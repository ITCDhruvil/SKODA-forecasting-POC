"""Derive Material Cost Dashboard numbers from the forecasting panel.

Supports:
  - Derived baselines (panel first/last month) or commercial CSV overrides
  - Volume-weighted spend (qty x unit price)
  - Dual aligned walks: Nomination→SOP and SOP→FC
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from ..geo_schema import CATEGORY_MATERIAL_INTENSITY, MATERIAL_COMMODITY
from .commercial import load_commercial_baselines

# Partial pass-through of index moves into piece price (demo attribution).
_FX_PASS = 1.0
_COMMODITY_PASS = 0.18
_FREIGHT_PASS = 0.06

_BRIDGE_IDS = (
    "fx",
    "commodity",
    "freight",
    "vendorReprice",
    "mix",
    "seasonality",
    "unexplained",
)


def _same_sign_overlap(residual: float, candidate: float) -> float:
    if residual == 0.0 or candidate == 0.0:
        return 0.0
    if residual * candidate <= 0.0:
        return 0.0
    return float(np.copysign(min(abs(residual), abs(candidate)), residual))


def _seasonal_amplitude(prices: np.ndarray) -> float:
    if prices is None or len(prices) < 6:
        return 0.0
    y = np.asarray(prices, dtype=float)
    y = y[np.isfinite(y)]
    if len(y) < 6:
        return 0.0
    t = np.arange(len(y), dtype=float)
    slope, intercept = np.polyfit(t, y, 1)
    detrended = y - (intercept + slope * t)
    mean_level = float(np.mean(np.abs(y))) or 1.0
    return float(min(1.0, np.std(detrended) / mean_level))


def _split_residual(
    residual: float,
    *,
    start: float,
    end: float,
    fx_abs: float,
    commodity_abs: float,
    freight_abs: float,
    seasonal_amp: float,
    mix_amp: float,
) -> Dict[str, float]:
    hist_unexplained = (end - start) - fx_abs - commodity_abs - freight_abs
    vendor_reprice = _same_sign_overlap(residual, hist_unexplained)
    rem = residual - vendor_reprice
    s_w = max(float(seasonal_amp), 0.0)
    m_w = max(float(mix_amp), 0.0)
    u_w = 1.0
    total_w = s_w + m_w + u_w
    seasonality = rem * (s_w / total_w)
    mix = rem * (m_w / total_w)
    unexplained = rem - seasonality - mix
    return {
        "vendorReprice": vendor_reprice,
        "mix": mix,
        "seasonality": seasonality,
        "unexplained": unexplained,
    }


def _round(value, digits: int = 2):
    if value is None:
        return None
    if isinstance(value, (np.floating, np.integer)):
        value = value.item()
    if isinstance(value, float) and (np.isnan(value) or np.isinf(value)):
        return None
    return round(value, digits) if isinstance(value, float) else value


def _month_str(ts: pd.Timestamp) -> str:
    return pd.Timestamp(ts).strftime("%Y-%m")


def _month_label(ts: pd.Timestamp) -> str:
    return pd.Timestamp(ts).strftime("%b %Y")


def _primary_forecasts(forecasts: pd.DataFrame) -> pd.DataFrame:
    primary = forecasts[forecasts["model"] == "xgboost"]
    if primary.empty:
        primary = forecasts[forecasts["model"] == "sarima"]
    return primary


def _mediator_moves(
    geo_analysis: Optional[Dict[str, object]],
) -> Dict[str, float]:
    moves: Dict[str, float] = {}
    if not geo_analysis or not isinstance(geo_analysis, dict):
        return moves
    prov = geo_analysis.get("provenance") or {}
    for row in prov.get("mediators") or []:
        name = str(row.get("name") or "")
        if not name:
            continue
        try:
            moves[name] = float(row.get("totalMovePct") or 0.0) / 100.0
        except (TypeError, ValueError):
            continue
    return moves


def _commodity_for_row(material: object, category_code: object) -> Tuple[str, float]:
    mat = str(material or "").strip().lower()
    code = str(category_code or "").strip().upper()
    commodity = MATERIAL_COMMODITY.get(mat, "steel")
    intensity = float(CATEGORY_MATERIAL_INTENSITY.get(code, 0.5))
    return commodity, intensity


def _fx_betas(row: pd.Series) -> Tuple[float, float]:
    if "true_eur_beta" in row.index and pd.notna(row.get("true_eur_beta")):
        eur = float(row["true_eur_beta"])
    else:
        dep = float(row.get("vendor_import_dependency") or 0.2)
        loc = float(row.get("project_localisation") or 0.5)
        eur = dep * (1.0 - loc) * 0.35
    if "true_usd_beta" in row.index and pd.notna(row.get("true_usd_beta")):
        usd = float(row["true_usd_beta"])
    else:
        usd = 0.12 + 0.08 * float(
            CATEGORY_MATERIAL_INTENSITY.get(
                str(row.get("category_code") or "").upper(), 0.5
            )
        )
    return eur, usd


def _resolve_month(
    work: pd.DataFrame,
    configured: Optional[str],
    *,
    default: pd.Timestamp,
    label: str,
) -> pd.Timestamp:
    if not configured:
        return pd.Timestamp(default)
    ts = pd.Timestamp(str(configured) + "-01") if len(str(configured)) == 7 else pd.Timestamp(configured)
    months = set(pd.to_datetime(work["month"]).dt.to_period("M").astype(str))
    key = ts.strftime("%Y-%m")
    if key not in months:
        # Nearest available month
        available = sorted(pd.to_datetime(work["month"]).unique())
        if not available:
            return pd.Timestamp(default)
        target = ts.to_datetime64()
        nearest = min(available, key=lambda m: abs(pd.Timestamp(m).to_datetime64() - target))
        return pd.Timestamp(nearest)
    return ts


def _volume_for_row(row: pd.Series, volume_weight: str, commercial_vol: Optional[float]) -> float:
    if commercial_vol is not None and np.isfinite(commercial_vol) and commercial_vol > 0:
        return float(commercial_vol)
    if volume_weight in (None, "", "none", "unit"):
        return 1.0
    col = volume_weight if volume_weight in row.index else None
    if col is None:
        for candidate in ("annual_part_volume", "project_volume"):
            if candidate in row.index and pd.notna(row.get(candidate)):
                col = candidate
                break
    if col is None:
        return 1.0
    try:
        v = float(row[col])
    except (TypeError, ValueError):
        return 1.0
    if not np.isfinite(v) or v <= 0:
        return 1.0
    return v


def _empty_bridges() -> Dict[str, float]:
    return {k: 0.0 for k in _BRIDGE_IDS}


def _scale_bridges(bridges: Dict[str, float], qty: float) -> Dict[str, float]:
    return {k: float(bridges.get(k, 0.0)) * qty for k in _BRIDGE_IDS}


def _sum_bridges(a: Dict[str, float], b: Dict[str, float]) -> Dict[str, float]:
    return {k: float(a.get(k, 0.0)) + float(b.get(k, 0.0)) for k in _BRIDGE_IDS}


def _close_unexplained(bridges: Dict[str, float], delta: float) -> Dict[str, float]:
    explained = sum(v for k, v in bridges.items() if k != "unexplained")
    out = dict(bridges)
    out["unexplained"] = delta - explained
    return out


def _waterfall_from_totals(
    *,
    start_id: str,
    start_label: str,
    start_value: float,
    start_note: str,
    end_id: str,
    end_label: str,
    end_value: float,
    end_note: str,
    totals: Dict[str, float],
    notes: Dict[str, str],
) -> List[Dict[str, object]]:
    labels = {
        "fx": "Currency",
        "commodity": "Materials",
        "freight": "Shipping",
        "vendorReprice": "Vendor reprice",
        "mix": "Mix",
        "seasonality": "Seasonality",
        "unexplained": "Unexplained",
    }
    steps: List[Dict[str, object]] = [
        {
            "id": start_id,
            "label": start_label,
            "kind": "total",
            "value": _round(start_value),
            "note": start_note,
        }
    ]
    for key in _BRIDGE_IDS:
        steps.append(
            {
                "id": key,
                "label": labels[key],
                "kind": "bridge",
                "value": _round(totals.get(key, 0.0)),
                "note": notes.get(key, labels[key]),
            }
        )
    steps.append(
        {
            "id": end_id,
            "label": end_label,
            "kind": "total",
            "value": _round(end_value),
            "note": end_note,
        }
    )
    return steps


def build_material_cost(
    panel: pd.DataFrame,
    forecasts: pd.DataFrame,
    geo_analysis: Optional[Dict[str, object]] = None,
    *,
    commercial_path: Optional[Path] = None,
    nomination_month: Optional[str] = None,
    sop_month: Optional[str] = None,
    volume_weight: str = "none",
    require_commercial: bool = False,
) -> Dict[str, object]:
    """Assemble the ``materialCost`` block for ``dashboard.json``."""
    if panel is None or panel.empty or forecasts is None or forecasts.empty:
        return {
            "available": False,
            "reason": "Panel or forecasts missing; run generate / forecast / export.",
        }

    commercial, commercial_note = load_commercial_baselines(
        Path(commercial_path) if commercial_path else Path("")
    )
    if require_commercial and commercial is None:
        return {
            "available": False,
            "reason": (
                "material_cost.require_commercial is true but no usable commercial "
                f"baselines file was found ({commercial_note})."
            ),
        }

    work = panel.copy()
    work["month"] = pd.to_datetime(work["month"])
    default_nom = work["month"].min()
    default_sop = work["month"].max()
    nomination_ts = _resolve_month(
        work, nomination_month, default=default_nom, label="nomination"
    )
    sop_ts = _resolve_month(work, sop_month, default=default_sop, label="sop")
    if sop_ts < nomination_ts:
        nomination_ts, sop_ts = sop_ts, nomination_ts

    primary = _primary_forecasts(forecasts)
    if primary.empty:
        return {"available": False, "reason": "No primary-model forecasts available."}

    horizon = int(primary["horizon"].max())
    end = primary[primary["horizon"] == horizon].copy()
    fc_month = pd.to_datetime(end["target_month"].iloc[0])

    nom = work[work["month"] == nomination_ts].drop_duplicates("part_id")
    sop = work[work["month"] == sop_ts].drop_duplicates("part_id")

    meta_cols = [
        c
        for c in (
            "part_id",
            "part_name",
            "project",
            "project_code",
            "vendor",
            "vendor_code",
            "category",
            "category_code",
            "material",
            "vendor_import_dependency",
            "project_localisation",
            "true_eur_beta",
            "true_usd_beta",
            "fx_eurinr",
            "fx_usdinr",
            "annual_part_volume",
            "project_volume",
            "price",
        )
        if c in nom.columns
    ]
    base = nom[meta_cols].rename(columns={"price": "bgPrice"})
    sop_prices = sop[["part_id", "price"]].rename(columns={"price": "sopPrice"})
    if "fx_eurinr" in sop.columns:
        sop_fx = sop[["part_id", "fx_eurinr", "fx_usdinr"]].rename(
            columns={"fx_eurinr": "fx_eurinr_sop", "fx_usdinr": "fx_usdinr_sop"}
        )
        base = base.merge(sop_fx, on="part_id", how="left")
    base = base.merge(sop_prices, on="part_id", how="inner")
    base = base.merge(
        end[["part_id", "prediction"]].rename(columns={"prediction": "fcPrice"}),
        on="part_id",
        how="inner",
    )

    file_override_count = 0
    if commercial is not None and not commercial.empty:
        base = base.merge(commercial, on="part_id", how="left", suffixes=("", "_c"))
        # Apply commercial unit prices when present.
        if "bg_unit_price" in base.columns:
            mask = base["bg_unit_price"].notna()
            file_override_count += int(mask.sum())
            base.loc[mask, "bgPrice"] = base.loc[mask, "bg_unit_price"]
        if "sop_unit_price" in base.columns:
            mask = base["sop_unit_price"].notna()
            file_override_count += int(mask.sum())
            base.loc[mask, "sopPrice"] = base.loc[mask, "sop_unit_price"]

    baseline_mode = "file" if commercial is not None and file_override_count > 0 else (
        "file" if commercial is not None and len(commercial) > 0 else "derived"
    )
    # File mode only when we actually loaded commercial rows that match panel parts.
    matched = 0
    if commercial is not None:
        matched = int(base["part_id"].isin(set(commercial["part_id"])).sum()) if "part_id" in base.columns else 0
    baseline_mode = "file" if matched > 0 else "derived"

    mediators = _mediator_moves(geo_analysis)
    steel_m = mediators.get("steel", 0.0)
    alu_m = mediators.get("aluminium", 0.0)
    cu_m = mediators.get("copper", 0.0)
    energy_m = mediators.get("energy", mediators.get("aluminium", 0.0) * 0.5)
    freight_m = mediators.get("freight", 0.0)
    commodity_move = {
        "steel": steel_m,
        "aluminium": alu_m,
        "copper": cu_m,
        "energy": energy_m,
    }

    if "fx_eurinr" in base.columns and "fx_eurinr_sop" in base.columns:
        eur_first = float(base["fx_eurinr"].median())
        eur_last = float(base["fx_eurinr_sop"].median())
        usd_first = float(base["fx_usdinr"].median())
        usd_last = float(base["fx_usdinr_sop"].median())
    else:
        eur_first = eur_last = usd_first = usd_last = 1.0
    eur_ret = (eur_last / eur_first - 1.0) if eur_first else 0.0
    usd_ret = (usd_last / usd_first - 1.0) if usd_first else 0.0

    hist_by_part: Dict[str, np.ndarray] = {}
    path_by_part: Dict[str, List[Dict[str, object]]] = {}
    for pid, grp in work.groupby("part_id", observed=True):
        g = grp.sort_values("month")
        hist_by_part[str(pid)] = g["price"].to_numpy(dtype=float)
        path: List[Dict[str, object]] = []
        for _, r in g.iterrows():
            m = pd.Timestamp(r["month"])
            path.append(
                {
                    "month": _month_str(m),
                    "label": _month_label(m),
                    "price": _round(float(r["price"]), 3),
                    "kind": "actual",
                }
            )
        path_by_part[str(pid)] = path

    # Portfolio median Δ% on spend-aware unit moves (pre-qty) for mix amp.
    portfolio_change_pct = float(
        np.median(
            [
                ((float(r["fcPrice"]) - float(r["bgPrice"])) / float(r["bgPrice"]) * 100.0)
                if float(r["bgPrice"])
                else 0.0
                for _, r in base.iterrows()
            ]
        )
    ) if len(base) else 0.0

    part_rows: List[Dict[str, object]] = []
    for _, row in base.iterrows():
        bg_u = float(row["bgPrice"])
        sop_u = float(row["sopPrice"])
        fc_u = float(row["fcPrice"])
        commercial_vol = None
        if "volume" in row.index and pd.notna(row.get("volume")):
            try:
                commercial_vol = float(row["volume"])
            except (TypeError, ValueError):
                commercial_vol = None
        qty = _volume_for_row(row, volume_weight, commercial_vol)

        eur_b, usd_b = _fx_betas(row)
        # --- Nomination → SOP attributions (unit) ---
        fx_u = bg_u * (eur_b * eur_ret + usd_b * usd_ret) * _FX_PASS
        commodity, intensity = _commodity_for_row(
            row.get("material"), row.get("category_code")
        )
        c_move = commodity_move.get(commodity, steel_m)
        commodity_u = bg_u * intensity * c_move * _COMMODITY_PASS
        dep = float(row.get("vendor_import_dependency") or 0.2)
        freight_u = bg_u * dep * freight_m * _FREIGHT_PASS

        nom_delta_u = sop_u - bg_u
        nom_residual_u = nom_delta_u - fx_u - commodity_u - freight_u
        change_pct_nom = (nom_delta_u / bg_u * 100.0) if bg_u else 0.0
        mix_amp = min(1.0, abs(change_pct_nom - portfolio_change_pct) / 25.0)
        seasonal_amp = _seasonal_amplitude(
            hist_by_part.get(str(row["part_id"]), np.array([]))
        )
        nom_split = _split_residual(
            nom_residual_u,
            start=bg_u,
            end=sop_u,
            fx_abs=fx_u,
            commodity_abs=commodity_u,
            freight_abs=freight_u,
            seasonal_amp=seasonal_amp,
            mix_amp=mix_amp,
        )
        bridges_nom_u = _close_unexplained(
            {
                "fx": fx_u,
                "commodity": commodity_u,
                "freight": freight_u,
                **nom_split,
            },
            nom_delta_u,
        )

        # --- SOP → FC: no FX/commodity/freight window (aligned to forward variance) ---
        fwd_delta_u = fc_u - sop_u
        change_pct_fwd = (fwd_delta_u / sop_u * 100.0) if sop_u else 0.0
        mix_amp_fwd = min(1.0, abs(change_pct_fwd - portfolio_change_pct) / 25.0)
        # Forward residual is almost entirely model / mix — keep driver channels at 0.
        fwd_split = _split_residual(
            fwd_delta_u,
            start=sop_u,
            end=fc_u,
            fx_abs=0.0,
            commodity_abs=0.0,
            freight_abs=0.0,
            seasonal_amp=0.0,
            mix_amp=mix_amp_fwd,
        )
        bridges_fwd_u = _close_unexplained(
            {
                "fx": 0.0,
                "commodity": 0.0,
                "freight": 0.0,
                **fwd_split,
            },
            fwd_delta_u,
        )

        bridges_nom = _scale_bridges(bridges_nom_u, qty)
        bridges_fwd = _scale_bridges(bridges_fwd_u, qty)
        bridges_all = _sum_bridges(bridges_nom, bridges_fwd)
        bridges_all["other"] = sum(
            bridges_all[k]
            for k in ("vendorReprice", "mix", "seasonality", "unexplained")
        )

        bg_spend = bg_u * qty
        sop_spend = sop_u * qty
        fc_spend = fc_u * qty
        delta_spend = fc_spend - bg_spend

        path = list(path_by_part.get(str(row["part_id"]), []))
        path.append(
            {
                "month": _month_str(fc_month),
                "label": _month_label(fc_month),
                "price": _round(fc_u, 3),
                "kind": "forecast",
            }
        )

        part_rows.append(
            {
                "partId": str(row["part_id"]),
                "partName": str(row.get("part_name") or row["part_id"]),
                "project": str(row.get("project") or ""),
                "vendor": str(row.get("vendor") or ""),
                "category": str(row.get("category") or ""),
                "material": str(row.get("material") or ""),
                "volume": _round(qty, 3),
                "volumeSource": (
                    "commercial"
                    if commercial_vol is not None and commercial_vol > 0
                    else volume_weight
                    if volume_weight not in ("none", "unit", "")
                    else "unit"
                ),
                "bgPrice": _round(bg_u),
                "sopPrice": _round(sop_u),
                "fcPrice": _round(fc_u),
                "bgSpend": _round(bg_spend),
                "sopSpend": _round(sop_spend),
                "fcSpend": _round(fc_spend),
                "changeAbs": _round(delta_spend),
                "changePct": _round((delta_spend / bg_spend * 100.0) if bg_spend else 0.0, 3),
                "bridges": {k: _round(v) for k, v in bridges_all.items()},
                "bridgesNomToSop": {k: _round(v) for k, v in bridges_nom.items()},
                "bridgesSopToFc": {k: _round(v) for k, v in bridges_fwd.items()},
                "pricePath": path,
                "baselineSource": "file" if baseline_mode == "file" and matched else "derived",
            }
        )

    def _spend_sum(key: str) -> float:
        return float(sum(float(p.get(key) or 0) for p in part_rows))

    def _bridge_pool_sum(pool: str, key: str) -> float:
        return float(
            sum(float((p.get(pool) or {}).get(key) or 0) for p in part_rows)  # type: ignore[union-attr]
        )

    bg_total = _spend_sum("bgSpend")
    sop_total = _spend_sum("sopSpend")
    fc_total = _spend_sum("fcSpend")

    def _finalize_walk(pool: str, start: float, end: float) -> Dict[str, float]:
        totals = {k: _bridge_pool_sum(pool, k) for k in _BRIDGE_IDS}
        explained = sum(totals[k] for k in _BRIDGE_IDS if k != "unexplained")
        totals["unexplained"] = (end - start) - explained
        if part_rows and abs(totals["unexplained"] - _bridge_pool_sum(pool, "unexplained")) > 1e-6:
            adj = totals["unexplained"] - _bridge_pool_sum(pool, "unexplained")
            target = max(
                part_rows,
                key=lambda p: abs(float((p.get(pool) or {}).get("unexplained") or 0)),  # type: ignore[union-attr]
            )
            br = target[pool]  # type: ignore[index]
            br["unexplained"] = _round(float(br.get("unexplained") or 0) + adj)
        return totals

    nom_totals = _finalize_walk("bridgesNomToSop", bg_total, sop_total)
    fwd_totals = _finalize_walk("bridgesSopToFc", sop_total, fc_total)
    all_totals = {k: nom_totals[k] + fwd_totals[k] for k in _BRIDGE_IDS}
    # Re-close combined on unexplained
    all_explained = sum(all_totals[k] for k in _BRIDGE_IDS if k != "unexplained")
    all_totals["unexplained"] = (fc_total - bg_total) - all_explained

    nom_notes = {
        "fx": (
            f"EUR/INR {_round(eur_ret * 100, 2)}% · USD/INR {_round(usd_ret * 100, 2)}% "
            "over Nomination→SOP x FX exposure x volume"
        ),
        "commodity": "Commodity index moves x intensity x volume (Nomination→SOP)",
        "freight": "Freight index x import dependency x volume (Nomination→SOP)",
        "vendorReprice": "SOP piece-price move not explained by FX / materials / shipping",
        "mix": "Cross-sectional deviation vs portfolio median (Nomination→SOP)",
        "seasonality": "History oscillation around Nomination→SOP trend",
        "unexplained": "Residual that closes Nomination→SOP",
    }
    fwd_notes = {
        "fx": "No forward FX attribution in this walk (aligned to SOP→FC window)",
        "commodity": "No forward commodity attribution in this walk",
        "freight": "No forward freight attribution in this walk",
        "vendorReprice": "Typically unused on the forward walk",
        "mix": "Parts diverging from portfolio median on SOP→FC",
        "seasonality": "Unused on the forward walk",
        "unexplained": "Model / residual remainder — closes SOP→FC",
    }
    all_notes = {
        "fx": nom_notes["fx"],
        "commodity": nom_notes["commodity"],
        "freight": nom_notes["freight"],
        "vendorReprice": "Mostly Nomination→SOP unexplained reprice (plus any forward share)",
        "mix": "Mix across Nomination→SOP and SOP→FC",
        "seasonality": "Seasonality on the history walk",
        "unexplained": "Combined residual that closes Budget→Forecast",
    }

    waterfall_nom = _waterfall_from_totals(
        start_id="budget",
        start_label="Budget (BG)",
        start_value=bg_total,
        start_note=f"Nomination-month ({_month_label(nomination_ts)}) unit price x volume",
        end_id="sop",
        end_label="SOP / current",
        end_value=sop_total,
        end_note=f"SOP-month ({_month_label(sop_ts)}) unit price x volume",
        totals=nom_totals,
        notes=nom_notes,
    )
    waterfall_fwd = _waterfall_from_totals(
        start_id="sop",
        start_label="SOP / current",
        start_value=sop_total,
        start_note=f"SOP-month ({_month_label(sop_ts)}) unit price x volume",
        end_id="forecast",
        end_label="Forecast (FC)",
        end_value=fc_total,
        end_note=f"Primary model, horizon h={horizon} ({_month_label(fc_month)}) x volume",
        totals=fwd_totals,
        notes=fwd_notes,
    )
    waterfall_all = _waterfall_from_totals(
        start_id="budget",
        start_label="Budget (BG)",
        start_value=bg_total,
        start_note=f"Nomination-month ({_month_label(nomination_ts)}) unit price x volume",
        end_id="forecast",
        end_label="Forecast (FC)",
        end_value=fc_total,
        end_note=f"Primary model, horizon h={horizon} ({_month_label(fc_month)}) x volume",
        totals=all_totals,
        notes=all_notes,
    )

    # Basket mean unit price series (unweighted mean — tracker is price, not spend)
    hist = (
        work.groupby("month", as_index=False)["price"]
        .mean()
        .sort_values("month")
    )
    price_series: List[Dict[str, object]] = []
    for _, r in hist.iterrows():
        m = pd.Timestamp(r["month"])
        price_series.append(
            {
                "month": _month_str(m),
                "label": _month_label(m),
                "actual": _round(float(r["price"]), 3),
                "forecast": None,
                "isNomination": m == nomination_ts,
                "isSop": m == sop_ts,
            }
        )
    fwd = (
        primary.groupby("target_month", as_index=False)["prediction"]
        .mean()
        .sort_values("target_month")
    )
    for _, r in fwd.iterrows():
        m = pd.Timestamp(r["target_month"])
        price_series.append(
            {
                "month": _month_str(m),
                "label": _month_label(m),
                "actual": None,
                "forecast": _round(float(r["prediction"]), 3),
                "isNomination": False,
                "isSop": False,
            }
        )

    projects = sorted({str(p["project"]) for p in part_rows if p.get("project")})
    ranked = sorted(
        part_rows,
        key=lambda p: abs(float(p.get("changeAbs") or 0)),
        reverse=True,
    )

    spend_basis = (
        "unit_sum"
        if volume_weight in ("none", "unit", "")
        else f"volume_weighted:{volume_weight}"
    )

    if baseline_mode == "file":
        disclaimer = (
            f"Baselines use commercial file overrides for {matched} part(s) "
            f"({commercial_note}). Spend is {spend_basis.replace('_', ' ')}."
        )
    else:
        disclaimer = (
            "Budget (BG), Nomination, and SOP are derived from the forecasting "
            "panel because no commercial nomination / SOP / budget file matched "
            "panel parts in data/. Treat this as a finance-ready demo walk, not "
            f"an official BG. Spend is {spend_basis.replace('_', ' ')}. "
            f"({commercial_note})"
        )

    return {
        "available": True,
        "baselineMode": baseline_mode,
        "spendBasis": spend_basis,
        "volumeWeight": volume_weight,
        "disclaimer": disclaimer,
        "commercialNote": commercial_note,
        "milestones": {
            "nomination": {
                "month": _month_str(nomination_ts),
                "label": _month_label(nomination_ts),
                "role": (
                    "Configured / commercial nomination month"
                    if nomination_month or baseline_mode == "file"
                    else "First history month — proxy for nominated piece price"
                ),
            },
            "sop": {
                "month": _month_str(sop_ts),
                "label": _month_label(sop_ts),
                "role": (
                    "Configured / commercial SOP month"
                    if sop_month or baseline_mode == "file"
                    else "Last history month — proxy for SOP / current production price"
                ),
            },
            "forecast": {
                "month": _month_str(fc_month),
                "label": _month_label(fc_month),
                "role": f"Forward forecast at horizon {horizon}",
            },
        },
        "summary": {
            "budgetSpend": _round(bg_total),
            "sopSpend": _round(sop_total),
            "forecastSpend": _round(fc_total),
            "varianceAbs": _round(fc_total - bg_total),
            "variancePct": _round(
                ((fc_total - bg_total) / bg_total * 100) if bg_total else 0.0, 3
            ),
            "varianceNomToSopAbs": _round(sop_total - bg_total),
            "varianceSopToFcAbs": _round(fc_total - sop_total),
            "nParts": len(part_rows),
            "horizon": horizon,
            "totalVolume": _round(_spend_sum("volume"), 3),
        },
        "waterfall": waterfall_all,
        "waterfallNomToSop": waterfall_nom,
        "waterfallSopToFc": waterfall_fwd,
        "priceSeries": price_series,
        "parts": ranked,
        "projects": projects,
        "fxWindow": {
            "eurinr": {
                "first": _round(eur_first, 4),
                "last": _round(eur_last, 4),
                "movePct": _round(eur_ret * 100, 3),
            },
            "usdinr": {
                "first": _round(usd_first, 4),
                "last": _round(usd_last, 4),
                "movePct": _round(usd_ret * 100, 3),
            },
        },
    }
