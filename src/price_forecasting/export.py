"""Serialises pipeline results into ``dashboard.json`` for the React app.

One file, written into the dashboard's ``public/`` directory, so the frontend
needs no server and no CORS handling. Everything the UI renders comes from here;
the React app contains no hardcoded figures, which means it cannot drift away
from what the pipeline actually produced.

Provenance travels with the numbers. Each block carries whether it came from
real BLS data or the synthetic panel, so the UI can label them differently
rather than presenting simulated results as measured ones.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from .config import Config
from .data_sourcing import MacroSeries
from .evaluation import compare_on_common_parts, metrics_by
from .parameters import build_parameter_catalogue
from .logging_utils import get_logger

logger = get_logger(__name__)

DASHBOARD_FILENAME = "dashboard.json"


def _round(value, digits: int = 2):
    """Round for JSON, converting numpy scalars and NaN to plain Python."""
    if value is None:
        return None
    if isinstance(value, (np.floating, np.integer)):
        value = value.item()
    if isinstance(value, float) and (np.isnan(value) or np.isinf(value)):
        return None
    return round(value, digits) if isinstance(value, float) else value


def _records(frame: pd.DataFrame, digits: int = 3) -> List[Dict[str, object]]:
    """Convert a DataFrame to JSON-safe records."""
    out = []
    for record in frame.to_dict("records"):
        out.append(
            {
                key: (
                    value.strftime("%Y-%m")
                    if isinstance(value, pd.Timestamp)
                    else _round(value, digits)
                )
                for key, value in record.items()
            }
        )
    return out


# --------------------------------------------------------------------------- #
# Blocks
# --------------------------------------------------------------------------- #


def _build_risk_concentration(
    panel: pd.DataFrame, forecasts: pd.DataFrame, threshold: float = 5.0
) -> Dict[str, object]:
    """Where the at-risk spend actually sits.

    A total exposure figure prompts one immediate question - "concentrated
    where?" - and an answer of "spread evenly" means something very different
    operationally from "four vendors". This answers it before it is asked.
    """
    latest_month = panel["month"].max()
    latest = panel[panel["month"] == latest_month]

    primary = forecasts[forecasts["model"] == "xgboost"]
    if primary.empty:
        primary = forecasts[forecasts["model"] == "sarima"]
    if primary.empty:
        return {"available": False}

    end = primary[primary["horizon"] == primary["horizon"].max()]
    dimensions = [c for c in ("vendor", "category", "project") if c in latest.columns]
    if not dimensions:
        return {"available": False}

    merged = end[["part_id", "prediction"]].merge(
        latest[["part_id", "price"] + dimensions].drop_duplicates("part_id"),
        on="part_id",
        how="inner",
    )
    merged = merged[merged["price"] > 0]
    merged["pct"] = (merged["prediction"] - merged["price"]) / merged["price"] * 100
    at_risk = merged[merged["pct"] > threshold]

    total_at_risk = float(at_risk["price"].sum())
    if total_at_risk <= 0:
        return {"available": False}

    by_dimension: Dict[str, List[Dict[str, object]]] = {}
    for dimension in dimensions:
        rows = []
        for name, group in at_risk.groupby(dimension, observed=True):
            exposed = float(group["price"].sum())
            rows.append(
                {
                    "name": str(name),
                    "spendAtRisk": _round(exposed),
                    "shareOfRisk": _round(exposed / total_at_risk * 100),
                    "parts": int(group["part_id"].nunique()),
                    "avgIncreasePct": _round(float(group["pct"].mean())),
                }
            )
        rows.sort(key=lambda r: r["spendAtRisk"] or 0, reverse=True)
        by_dimension[dimension] = rows

    vendors = by_dimension.get("vendor", [])
    top4_share = sum(r["shareOfRisk"] or 0 for r in vendors[:4])

    logger.info(
        "risk concentration: %d parts above +%.0f%%, top 4 vendors hold %.0f%% "
        "of the exposed spend",
        int(at_risk["part_id"].nunique()),
        threshold,
        top4_share,
    )

    return {
        "available": True,
        "thresholdPct": threshold,
        "totalSpendAtRisk": _round(total_at_risk),
        "partsAtRisk": int(at_risk["part_id"].nunique()),
        "top4VendorSharePct": _round(top4_share),
        "byDimension": by_dimension,
    }


def _build_data_sources(
    config: Config,
    macro: MacroSeries,
    panel: pd.DataFrame,
    future_test: Optional[Dict[str, object]],
) -> List[Dict[str, object]]:
    """Every input the model consumes, with provenance and honest labelling.

    A technical reviewer's first question is "where did this data come from".
    Answering it in the product, rather than in a separate document, keeps the
    answer attached to the numbers it describes.
    """
    months = pd.DatetimeIndex(sorted(panel["month"].unique()))

    sources: List[Dict[str, object]] = [
        {
            "id": "bls",
            "name": "BLS Motor Vehicle Parts Price Index",
            "kind": "Macro price anchor",
            "provider": "US Bureau of Labor Statistics",
            "identifier": macro.series_id,
            "endpoint": f"{config.sourcing.bls_api_base}/{macro.series_id}",
            "isReal": macro.is_real,
            "status": "real" if macro.is_real else "fallback",
            "frequency": "Monthly",
            "coverage": f"{macro.values.index.min():%Y-%m} to {macro.values.index.max():%Y-%m}",
            "observations": int(len(macro.values)),
            "caveat": (
                f"{macro.extrapolated_months} month(s) back-extrapolated - the "
                f"public API caps history at ~3 years. Those months are excluded "
                f"from real-data validation."
                if macro.extrapolated_months
                else "Full window covered by published observations."
            ),
            "usedFor": "Drives the shared price trend across every part.",
            "auth": "None - public API, no key required",
        }
    ]

    for spec in config.fx.pairs:
        pair = f"{spec['base']}{spec['quote']}"
        channel = spec.get("channel", "import_invoicing")
        sources.append(
            {
                "id": f"fx_{pair.lower()}",
                "name": f"{spec['base']}/{spec['quote']} reference rate",
                "kind": (
                    "FX - direct import invoicing"
                    if channel == "import_invoicing"
                    else "FX - commodity channel"
                ),
                "provider": "European Central Bank (via Frankfurter)",
                "identifier": pair,
                "endpoint": config.fx.api_base,
                "isReal": True,
                "status": "real",
                "frequency": "Daily, aggregated to monthly average",
                "coverage": f"{months.min():%Y-%m} to {months.max():%Y-%m}",
                "observations": int(len(months)),
                "caveat": (
                    "Monthly average, not month-end: a contract repricing across "
                    "a month is exposed to the average rate."
                ),
                "usedFor": (
                    "Direct import cost for foreign-invoiced content."
                    if channel == "import_invoicing"
                    else "Indirect cost via USD-benchmarked commodities (steel, "
                    "copper, crude) - applies even to domestically bought parts."
                ),
                "auth": "None - public API, no key required",
            }
        )

    sources.append(
        {
            "id": "panel",
            "name": "Part-level price panel",
            "kind": "Synthetic",
            "provider": "Generated by this pipeline",
            "identifier": "data/raw/parts_prices.csv",
            "endpoint": None,
            "isReal": False,
            "status": "synthetic",
            "frequency": "Monthly",
            "coverage": f"{months.min():%Y-%m} to {months.max():%Y-%m}",
            "observations": int(len(panel)),
            "caveat": (
                "No public source publishes monthly piece prices per SKU per "
                "vendor per programme - that data lives only in OEM purchasing "
                "systems. This layer is simulated to specification and would be "
                "replaced by the customer's own purchase-order history."
            ),
            "usedFor": (
                f"{panel['part_id'].nunique()} parts across "
                f"{panel['project'].nunique() if 'project' in panel.columns else 0} "
                f"projects and "
                f"{panel['vendor'].nunique() if 'vendor' in panel.columns else 0} vendors."
            ),
            "auth": "n/a",
        }
    )

    return sources


def _build_kpis(
    panel: pd.DataFrame, forecasts: pd.DataFrame, comparison: pd.DataFrame, config: Config
) -> List[Dict[str, object]]:
    """Headline metric cards."""
    latest_month = panel["month"].max()
    latest = panel[panel["month"] == latest_month]
    prior_month = latest_month - pd.DateOffset(months=1)
    prior = panel[panel["month"] == prior_month]

    primary = forecasts[forecasts["model"] == "xgboost"]
    if primary.empty:
        primary = forecasts[forecasts["model"] == "sarima"]

    horizon_end = primary[primary["horizon"] == primary["horizon"].max()]

    current_basket = float(latest["price"].sum())
    prior_basket = float(prior["price"].sum()) if not prior.empty else current_basket
    forecast_basket = float(horizon_end["prediction"].sum())

    basket_change = (
        (current_basket - prior_basket) / prior_basket * 100 if prior_basket else 0.0
    )
    forecast_change = (
        (forecast_basket - current_basket) / current_basket * 100 if current_basket else 0.0
    )

    best_mape = (
        float(comparison.sort_values("mape")["mape"].iloc[0])
        if not comparison.empty
        else None
    )
    best_model = (
        str(comparison.sort_values("mape")["model"].iloc[0])
        if not comparison.empty
        else "n/a"
    )

    # "At risk" = parts forecast to rise more than 5% over the horizon.
    #
    # Reported as **money, not a count**. "78 parts at risk" is a technical
    # metric nobody repeats; "X of spend exposed" is the number a procurement
    # lead carries into their next meeting. Only upward moves count - a part
    # getting cheaper is not a risk.
    last_price = latest.set_index("part_id")["price"]
    end_forecast = horizon_end.set_index("part_id")["prediction"]
    joined = pd.concat([last_price, end_forecast], axis=1, join="inner")
    joined.columns = ["current", "forecast"]
    joined["pct"] = (joined["forecast"] - joined["current"]) / joined["current"] * 100

    risk_threshold = 5.0
    at_risk_mask = joined["pct"] > risk_threshold
    at_risk = int(at_risk_mask.sum())
    spend_at_risk = float(joined.loc[at_risk_mask, "current"].sum())
    spend_share = (spend_at_risk / current_basket * 100) if current_basket else 0.0

    return [
        {
            "id": "basket",
            "label": "Basket Price (all parts)",
            "value": current_basket,
            "format": "currency",
            "change": _round(basket_change),
            "changeLabel": "vs previous month",
            "direction": "up" if basket_change >= 0 else "down",
            "icon": "trending",
        },
        {
            "id": "forecast",
            "label": f"Forecast Basket (+{int(primary['horizon'].max())} mo)",
            "value": forecast_basket,
            "format": "currency",
            "change": _round(forecast_change),
            "changeLabel": f"projected to {horizon_end['target_month'].max():%b %Y}",
            "direction": "up" if forecast_change >= 0 else "down",
            "icon": "package",
        },
        {
            "id": "accuracy",
            "label": "Best Model Accuracy",
            "value": _round(100.0 - best_mape) if best_mape is not None else None,
            "format": "percent",
            # No delta here. This is a level, not a change, and rendering the
            # MAPE as a green "+3.0%" would read as an improvement it is not.
            "change": None,
            "changeLabel": (
                f"{best_model} - {best_mape:.2f}% MAPE" if best_mape is not None else "n/a"
            ),
            "direction": "flat",
            "icon": "target",
            "note": "Measured on the synthetic panel, not real prices",
        },
        {
            "id": "atrisk",
            "label": "Spend At Risk (>5% increase)",
            "value": spend_at_risk,
            "format": "currency",
            "change": _round(spend_share),
            "changeLabel": f"of basket, across {at_risk} of {len(joined)} parts",
            "direction": "up",
            "icon": "alert",
        },
    ]


def _build_price_series(
    panel: pd.DataFrame, forecasts: pd.DataFrame, holdout: pd.DataFrame
) -> List[Dict[str, object]]:
    """Aggregate mean price: history, holdout fit, and forward forecast."""
    history = panel.groupby("month")["price"].mean()

    fitted = (
        holdout[holdout["model"] == "xgboost"]
        .groupby("target_month")["prediction"]
        .mean()
    )

    primary = forecasts[forecasts["model"] == "xgboost"]
    if primary.empty:
        primary = forecasts[forecasts["model"] == "sarima"]

    forward = primary.groupby("target_month").agg(
        prediction=("prediction", "mean"),
        lower=("lower", "mean"),
        upper=("upper", "mean"),
    )

    months = sorted(set(history.index) | set(forward.index))
    rows = []
    for month in months:
        rows.append(
            {
                "month": month.strftime("%Y-%m"),
                "label": month.strftime("%b %Y"),
                "actual": _round(history.get(month)),
                "fitted": _round(fitted.get(month)),
                "forecast": _round(forward["prediction"].get(month)),
                "lower": _round(forward["lower"].get(month)),
                "upper": _round(forward["upper"].get(month)),
            }
        )
    return rows


def _build_hierarchy(
    panel: pd.DataFrame, forecasts: pd.DataFrame
) -> Dict[str, List[Dict[str, object]]]:
    """Current vs forecast spend rolled up each hierarchy dimension.

    This is how a part-level model is read at the level a decision is actually
    made: programme managers care about project totals, buyers about vendors,
    commodity teams about categories.
    """
    latest_month = panel["month"].max()
    latest = panel[panel["month"] == latest_month]

    primary = forecasts[forecasts["model"] == "xgboost"]
    if primary.empty:
        primary = forecasts[forecasts["model"] == "sarima"]
    if primary.empty:
        return {}

    end = primary[primary["horizon"] == primary["horizon"].max()]

    dimensions = [
        ("project", "project"),
        ("vendor", "vendor"),
        ("category", "category"),
    ]
    available = [
        (label, column) for label, column in dimensions if column in latest.columns
    ]
    if not available:
        return {}

    merged = end[["part_id", "prediction"]].merge(
        latest[["part_id", "price"] + [c for _, c in available]].drop_duplicates("part_id"),
        on="part_id",
        how="inner",
    )

    result: Dict[str, List[Dict[str, object]]] = {}
    for label, column in available:
        rows = []
        for name, group in merged.groupby(column, observed=True):
            current = float(group["price"].sum())
            forecast = float(group["prediction"].sum())
            if current <= 0:
                continue
            rows.append(
                {
                    "name": str(name),
                    "parts": int(group["part_id"].nunique()),
                    "currentSpend": _round(current),
                    "forecastSpend": _round(forecast),
                    "changePct": _round((forecast - current) / current * 100, 3),
                    "changeAbs": _round(forecast - current),
                }
            )
        rows.sort(key=lambda r: r["changePct"] or 0, reverse=True)
        result[label] = rows
    return result


def _confidence_for(change_pct: float, expected_error_pct: float) -> Dict[str, object]:
    """How much weight should a buyer put on a predicted move?

    Deliberately **not** a probability. The model produces a point forecast and
    an empirical interval; inventing a "73% chance of being right" from that
    would be false precision.

    The honest question is whether the predicted move is large enough to be
    distinguishable from the model's own typical error at that horizon. A
    forecast of +0.4% from a model that is routinely 2.2% wrong is noise; a
    forecast of +8% from the same model is a signal worth acting on.

    Ratio = |predicted move| / expected error:
      >= 2.0  high    - move clearly exceeds typical error
      >= 1.0  medium  - move is comparable to typical error
      <  1.0  low     - move is within noise, do not act on the sign
    """
    error = max(float(expected_error_pct), 0.01)
    ratio = abs(float(change_pct)) / error
    if ratio >= 2.0:
        level = "high"
    elif ratio >= 1.0:
        level = "medium"
    else:
        level = "low"
    return {
        "level": level,
        "signalToErrorRatio": _round(ratio, 2),
        "expectedErrorPct": _round(error, 3),
    }


def _build_tree(
    panel: pd.DataFrame,
    forecasts: pd.DataFrame,
    future_test: Optional[Dict[str, object]],
) -> List[Dict[str, object]]:
    """Nested project -> vendor -> category -> part forecasts.

    Built as a real tree rather than three flat roll-ups so the UI can drill
    down and show the thing a buyer actually needs to see: that a single vendor
    supplies several categories on one programme, and what each of those lines
    is forecast to do.
    """
    latest_month = panel["month"].max()
    latest = panel[panel["month"] == latest_month]

    primary = forecasts[forecasts["model"] == "xgboost"]
    if primary.empty:
        primary = forecasts[forecasts["model"] == "sarima"]
    if primary.empty:
        return []

    horizon = int(primary["horizon"].max())
    end = primary[primary["horizon"] == horizon]

    required = {"project", "vendor", "category"}
    if not required.issubset(latest.columns):
        return []

    # Expected model error at this horizon, from the simulated-future test. This
    # is what makes the confidence flag meaningful rather than decorative.
    expected_error = 2.5
    if future_test:
        scores = future_test.get("scores") or []
        best = min(scores, key=lambda s: s.get("mape", 99)) if scores else None
        if best:
            match = [h for h in best.get("by_horizon", []) if h.get("horizon") == horizon]
            expected_error = float(
                match[0]["mape"] if match else best.get("mape", expected_error)
            )

    merged = end[["part_id", "prediction", "lower", "upper"]].merge(
        latest[
            [
                "part_id", "part_name", "project", "vendor", "vendor_origin",
                "category", "price", "is_anomaly_part", "anomaly_type",
            ]
        ].drop_duplicates("part_id"),
        on="part_id",
        how="inner",
    )
    merged = merged[merged["price"] > 0]

    def _aggregate(group: pd.DataFrame) -> Dict[str, float]:
        current = float(group["price"].sum())
        forecast = float(group["prediction"].sum())
        return {
            "currentSpend": _round(current),
            "forecastSpend": _round(forecast),
            "changePct": _round((forecast - current) / current * 100, 3) if current else 0.0,
            "changeAbs": _round(forecast - current),
            "parts": int(group["part_id"].nunique()),
        }

    tree: List[Dict[str, object]] = []
    for project, project_group in merged.groupby("project", observed=True):
        vendors = []
        for vendor, vendor_group in project_group.groupby("vendor", observed=True):
            categories = []
            for category, category_group in vendor_group.groupby("category", observed=True):
                parts = []
                for row in category_group.sort_values("prediction", ascending=False).to_dict(
                    "records"
                ):
                    change = (row["prediction"] - row["price"]) / row["price"] * 100
                    parts.append(
                        {
                            "partId": row["part_id"],
                            "partName": row["part_name"],
                            "currentPrice": _round(row["price"]),
                            "forecastPrice": _round(row["prediction"]),
                            "lower": _round(row["lower"]),
                            "upper": _round(row["upper"]),
                            "changePct": _round(change, 3),
                            "changeAbs": _round(row["prediction"] - row["price"]),
                            "isAnomaly": bool(row["is_anomaly_part"]),
                            "anomalyType": str(row["anomaly_type"] or ""),
                            "confidence": _confidence_for(change, expected_error),
                        }
                    )
                categories.append(
                    {
                        "name": str(category),
                        **_aggregate(category_group),
                        "parts": parts,
                        "partCount": len(parts),
                    }
                )
            categories.sort(key=lambda c: c["changePct"] or 0, reverse=True)
            vendors.append(
                {
                    "name": str(vendor),
                    "origin": str(vendor_group["vendor_origin"].iloc[0]),
                    **_aggregate(vendor_group),
                    "categoryCount": len(categories),
                    "categories": categories,
                }
            )
        vendors.sort(key=lambda v: v["changePct"] or 0, reverse=True)
        tree.append(
            {
                "name": str(project),
                **_aggregate(project_group),
                "vendorCount": len(vendors),
                "vendors": vendors,
            }
        )

    tree.sort(key=lambda p: p["changePct"] or 0, reverse=True)
    logger.info(
        "built drill-down tree: %d projects, %d project-vendor links, expected "
        "model error %.2f%% at h=%d",
        len(tree),
        sum(p["vendorCount"] for p in tree),
        expected_error,
        horizon,
    )
    return tree


def _build_categories(panel: pd.DataFrame, forecasts: pd.DataFrame) -> List[Dict[str, object]]:
    """Share of total basket value by category, with forecast movement."""
    latest_month = panel["month"].max()
    latest = panel[panel["month"] == latest_month]

    primary = forecasts[forecasts["model"] == "xgboost"]
    if primary.empty:
        primary = forecasts[forecasts["model"] == "sarima"]
    end = primary[primary["horizon"] == primary["horizon"].max()]

    current = latest.groupby("category")["price"].sum()
    future = end.groupby("category")["prediction"].sum()
    total = float(current.sum())

    rows = []
    for category in current.sort_values(ascending=False).index:
        now = float(current[category])
        later = float(future.get(category, now))
        rows.append(
            {
                "category": category,
                "value": _round(now),
                "share": _round(now / total * 100),
                "forecastChange": _round((later - now) / now * 100) if now else 0.0,
                "parts": int(latest[latest["category"] == category]["part_id"].nunique()),
            }
        )
    return rows


def _build_top_parts(
    panel: pd.DataFrame, forecasts: pd.DataFrame, limit: int = 12
) -> List[Dict[str, object]]:
    """Parts with the largest forecast price movement, plus a sparkline."""
    latest_month = panel["month"].max()
    latest = panel[panel["month"] == latest_month].set_index("part_id")

    primary = forecasts[forecasts["model"] == "xgboost"]
    if primary.empty:
        primary = forecasts[forecasts["model"] == "sarima"]

    end = primary[primary["horizon"] == primary["horizon"].max()].set_index("part_id")

    # Recent history for the sparkline: last 12 months per part.
    recent_start = latest_month - pd.DateOffset(months=11)
    recent = panel[panel["month"] >= recent_start]
    spark = recent.sort_values("month").groupby("part_id")["price"].apply(list)

    rows = []
    for part_id in end.index.intersection(latest.index):
        current = float(latest.loc[part_id, "price"])
        forecast = float(end.loc[part_id, "prediction"])
        if current <= 0:
            continue
        change = (forecast - current) / current * 100
        rows.append(
            {
                "partId": part_id,
                "partName": str(latest.loc[part_id, "part_name"]),
                "component": str(latest.loc[part_id, "category"]),
                "category": str(latest.loc[part_id, "category"]),
                "brand": str(latest.loc[part_id, "vendor"]),
                "project": str(latest.loc[part_id, "project"]),
                "vendor": str(latest.loc[part_id, "vendor"]),
                "vendorOrigin": str(latest.loc[part_id, "vendor_origin"]),
                "currentPrice": _round(current),
                "forecastPrice": _round(forecast),
                "change": _round(change),
                "isAnomaly": bool(latest.loc[part_id, "is_anomaly_part"]),
                "anomalyType": str(latest.loc[part_id, "anomaly_type"] or ""),
                "sparkline": [_round(v) for v in spark.get(part_id, [])],
            }
        )

    rows.sort(key=lambda r: abs(r["change"] or 0), reverse=True)
    return rows[:limit]


def _build_horizon(forecasts: pd.DataFrame) -> List[Dict[str, object]]:
    """Basket value per forecast month, for the horizon bar chart."""
    primary = forecasts[forecasts["model"] == "xgboost"]
    if primary.empty:
        primary = forecasts[forecasts["model"] == "sarima"]

    grouped = primary.groupby("target_month").agg(
        value=("prediction", "sum"),
        lower=("lower", "sum"),
        upper=("upper", "sum"),
    )
    return [
        {
            "month": month.strftime("%Y-%m"),
            "label": month.strftime("%b %Y"),
            "value": _round(row["value"]),
            "lower": _round(row["lower"]),
            "upper": _round(row["upper"]),
        }
        for month, row in grouped.iterrows()
    ]


def _build_alerts(top_parts: List[Dict[str, object]], config: Config) -> List[Dict[str, object]]:
    """Actionable notices derived from the forecasts, most severe first."""
    alerts = []
    for part in top_parts:
        change = part["change"] or 0.0
        if part["isAnomaly"]:
            severity = "high"
            message = f"Structural break detected ({part['anomalyType'].replace('_', ' ')})"
        elif abs(change) > 8:
            severity = "high"
            message = f"Forecast to move {change:+.1f}% over the horizon"
        elif abs(change) > 4:
            severity = "medium"
            message = f"Forecast to move {change:+.1f}% over the horizon"
        else:
            continue
        alerts.append(
            {
                "partId": part["partId"],
                "title": f"{part['category']} - {part['vendor']}",
                "message": message,
                "severity": severity,
                "change": part["change"],
            }
        )

    order = {"high": 0, "medium": 1, "low": 2}
    alerts.sort(key=lambda a: (order[a["severity"]], -abs(a["change"] or 0)))
    return alerts[:8]


def _build_insight(
    validation: Dict[str, object], comparison: pd.DataFrame
) -> Dict[str, object]:
    """The single most important thing a reader should take away.

    This deliberately leads with the real-data result rather than the flattering
    synthetic one. If the naive baseline wins on real data, that is the headline,
    because it is the finding that would change what someone does next.
    """
    backtests = validation.get("backtests") or []
    if not backtests:
        return {
            "headline": "Real-data validation unavailable",
            "body": str(validation.get("reason", "No real BLS observations were retrieved.")),
            "tone": "warning",
        }

    best = min(backtests, key=lambda b: b["mape"])
    naive = next((b for b in backtests if b["model"] == "naive"), None)

    if naive is not None and best["model"] == "naive":
        others = [b for b in backtests if b["model"] != "naive"]
        worst_named = max(others, key=lambda b: b["mape"])["model"] if others else "the models"
        return {
            "headline": "On real data, the naive baseline wins",
            "body": (
                f"Forecasting {naive['n_test']} months of actual published BLS data, "
                f"carrying the last value forward scored {naive['mape']:.2f}% MAPE - "
                f"better than {worst_named}. The real index is close to a random walk, "
                f"so added model complexity is not paying for itself at this horizon."
            ),
            "tone": "warning",
        }

    return {
        "headline": f"{best['model']} leads on real data",
        "body": (
            f"Across {best['n_test']} months of actual published BLS data, "
            f"{best['model']} scored {best['mape']:.2f}% MAPE"
            + (
                f" against the naive baseline's {naive['mape']:.2f}%."
                if naive
                else "."
            )
        ),
        "tone": "positive",
    }


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def build_dashboard_payload(
    config: Config,
    macro: MacroSeries,
    panel: pd.DataFrame,
    holdout: pd.DataFrame,
    backtest: Optional[pd.DataFrame],
    forecasts: pd.DataFrame,
    validation: Dict[str, object],
    versions: Dict[str, str],
    future_test: Optional[Dict[str, object]] = None,
    fx_analysis: Optional[Dict[str, object]] = None,
    feature_columns: Optional[List[str]] = None,
) -> Dict[str, object]:
    """Assemble the full dashboard payload.

    ``feature_columns`` is the model's actual feature list; it is used to verify
    which catalogued drivers are genuinely implemented rather than trusting a
    hand-maintained flag.
    """
    comparison = compare_on_common_parts(holdout)
    top_parts = _build_top_parts(panel, forecasts)

    backtest_summary: List[Dict[str, object]] = []
    if backtest is not None and not backtest.empty:
        fold_metrics = metrics_by(backtest, ["model", "fold"])
        summary = (
            fold_metrics.groupby("model")[["mae", "rmse", "mape"]]
            .agg(["mean", "std"])
            .reset_index()
        )
        summary.columns = [
            col[0] if not col[1] else f"{col[0]}_{col[1]}" for col in summary.columns
        ]
        backtest_summary = _records(summary)

    return {
        "meta": {
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "projectName": config.project.name,
            "randomSeed": config.project.random_seed,
            "forecastHorizon": config.modeling.forecast_horizon,
            "historyMonths": config.generation.history_months,
            "nParts": int(panel["part_id"].nunique()),
            "nCategories": int(panel["category"].nunique()),
            "nProjects": int(panel["project"].nunique()) if "project" in panel.columns else 0,
            "nVendors": int(panel["vendor"].nunique()) if "vendor" in panel.columns else 0,
            # Parts are priced in the assembly plant's currency; the UI must not
            # label rupee figures with a dollar sign.
            "currency": config.fx.base_currency,
            "currencySymbol": {"INR": "₹", "EUR": "€", "USD": "$", "GBP": "£"}.get(
                config.fx.base_currency, config.fx.base_currency + " "
            ),
            "historyRange": [
                panel["month"].min().strftime("%Y-%m"),
                panel["month"].max().strftime("%Y-%m"),
            ],
            "versions": versions,
        },
        "provenance": {
            "macroSeriesId": macro.series_id,
            "macroSource": macro.source,
            "macroIsReal": macro.is_real,
            "extrapolatedMonths": macro.extrapolated_months,
            "skuLayer": "synthetic",
            "disclaimer": (
                "The macro price trend is real BLS data. The per-part price panel "
                "is synthetic - no public source provides monthly prices per "
                "automotive SKU. Model rankings transfer; absolute error figures "
                "on the synthetic panel do not."
            ),
        },
        "kpis": _build_kpis(panel, forecasts, comparison, config),
        "priceSeries": _build_price_series(panel, forecasts, holdout),
        "categories": _build_categories(panel, forecasts),
        "topParts": top_parts,
        "horizon": _build_horizon(forecasts),
        "alerts": _build_alerts(top_parts, config),
        "insight": _build_insight(validation, comparison),
        "modelComparison": _records(comparison),
        "backtestSummary": backtest_summary,
        "validation": validation,
        "futureTest": future_test or {"available": False},
        "fxAnalysis": fx_analysis or {"available": False},
        "hierarchy": _build_hierarchy(panel, forecasts),
        "riskConcentration": _build_risk_concentration(panel, forecasts),
        "tree": _build_tree(panel, forecasts, future_test),
        "dataSources": _build_data_sources(config, macro, panel, future_test),
        "parameterCatalogue": build_parameter_catalogue(feature_columns or []),
        "macroSeries": [
            {
                "month": month.strftime("%Y-%m"),
                "label": month.strftime("%b %Y"),
                "value": _round(float(value), 3),
                "isReal": bool(
                    macro.observed_start is not None and month >= macro.observed_start
                ),
            }
            for month, value in macro.values.items()
        ],
    }


def export_dashboard(config: Config, payload: Dict[str, object]) -> List[Path]:
    """Write ``dashboard.json`` to data/processed and the React app's public dir.

    Writing both means the payload is inspectable from the pipeline side and
    immediately consumable by the frontend with no copy step.
    """
    targets = [config.paths.data_processed / DASHBOARD_FILENAME]

    app_public = config.paths.root / "dashboard" / "public"
    if app_public.is_dir():
        targets.append(app_public / DASHBOARD_FILENAME)
    else:
        logger.info(
            "React app not scaffolded at %s yet; writing payload to data/processed only",
            app_public,
        )

    serialised = json.dumps(payload, indent=2, default=str)
    written = []
    for target in targets:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(serialised, encoding="utf-8")
        written.append(target)
        logger.info("wrote %s (%.1f KB)", target, len(serialised) / 1024)

    return written
