"""Geopolitical counterfactual scenarios.

Mirrors :mod:`fx_scenario`: shock one mediator family, re-predict with
everything else held constant, roll the response up the hierarchy. Because the
model is a single global estimator, the shock propagates through whatever
structure it actually learned.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from .config import Config
from .fx_scenario import ROLLUP_LEVELS, ScenarioResult
from .logging_utils import get_logger
from .modeling import GlobalXGBModel

logger = get_logger(__name__)


def _shift_prefixed_features(
    frame: pd.DataFrame,
    prefixes: Sequence[str],
    shock_pct: float,
    *,
    treat_as_return: bool = True,
) -> pd.DataFrame:
    """Apply a proportional shock to feature columns matching ``prefixes``.

    Mirrors FX scenarios: bare return columns shift by ``log(1+shock)``;
    ``*_x_import`` / ``*_x_mat`` interactions shift by that times the exposure
    weight already baked into the column (or re-applied from master data), so
    high-import / high-material parts move more — required for beta-recovery
    diagnostics.
    """
    shocked = frame.copy()
    log_shock = float(np.log1p(shock_pct / 100.0))
    scale = 1.0 + shock_pct / 100.0
    n_touched = 0

    import_dependency = (
        shocked["vendor_import_dependency"].astype(float)
        if "vendor_import_dependency" in shocked.columns
        else pd.Series(0.5, index=shocked.index)
    )
    material_intensity = (
        shocked["material_intensity"].astype(float)
        if "material_intensity" in shocked.columns
        else pd.Series(0.5, index=shocked.index)
    )

    for column in shocked.columns:
        if not any(column.startswith(p) for p in prefixes):
            continue
        if shocked[column].dtype.name == "category":
            continue
        values = shocked[column].astype(float)
        if column.endswith("_x_import"):
            shocked[column] = values + log_shock * import_dependency
        elif column.endswith("_x_mat"):
            shocked[column] = values + log_shock * material_intensity
        elif (
            treat_as_return
            or "ret" in column
            or "_z_" in column
            or column.endswith("_decay")
        ):
            shocked[column] = values + log_shock
        elif "chokepoint" in column or column.startswith("geo_event_"):
            shocked[column] = np.clip(values + abs(shock_pct) / 100.0, 0.0, 5.0)
        else:
            shocked[column] = values * scale
        n_touched += 1

    logger.info(
        "geo shock %+.1f%% touched %d feature column(s) with prefixes %s",
        shock_pct,
        n_touched,
        list(prefixes),
    )
    return shocked


def _rollup_delta(
    baseline: pd.Series,
    shocked: pd.Series,
    meta: pd.DataFrame,
) -> Dict[str, List[Dict[str, object]]]:
    """Roll per-part % changes up the hierarchy."""
    delta = pd.DataFrame(
        {
            "part_id": baseline.index,
            "baseline": baseline.to_numpy(),
            "shocked": shocked.reindex(baseline.index).to_numpy(),
        }
    )
    delta = delta.merge(meta, on="part_id", how="left")
    delta = delta[delta["baseline"] > 0]
    delta["pct"] = (delta["shocked"] / delta["baseline"] - 1.0) * 100.0

    by_level: Dict[str, List[Dict[str, object]]] = {}
    for level_id, column in ROLLUP_LEVELS:
        if column not in delta.columns:
            continue
        grouped = (
            delta.groupby(column, sort=False)
            .agg(priceChangePct=("pct", "mean"), nParts=("part_id", "nunique"))
            .reset_index()
            .rename(columns={column: "name"})
            .sort_values("priceChangePct", ascending=False)
        )
        by_level[level_id] = [
            {
                "name": row["name"],
                "priceChangePct": round(float(row["priceChangePct"]), 4),
                "nParts": int(row["nParts"]),
            }
            for _, row in grouped.iterrows()
        ]
    return by_level


def run_geo_scenarios(
    config: Config,
    model: GlobalXGBModel,
    features: pd.DataFrame,
    horizon: int = 6,
) -> List[Dict[str, object]]:
    """Run freight / GPR / duty counterfactuals and return JSON-ready results."""
    origin = features["month"].max()
    base_frame = features[features["month"] == origin].copy()
    if base_frame.empty:
        logger.warning("no feature rows at origin %s; geo scenarios skipped", origin)
        return []

    if horizon not in model.models:
        horizon = max(model.models) if model.models else None
        if horizon is None:
            logger.warning("model has no trained horizons; skipping geo scenarios")
            return []

    baseline_pred = model.predict(base_frame, horizon)
    baseline = pd.Series(baseline_pred, index=base_frame["part_id"].to_numpy())
    meta_cols = [c for c in ("part_id", "project", "vendor", "category") if c in base_frame.columns]
    meta = base_frame[meta_cols].drop_duplicates("part_id")

    specs = [
        ("freight", config.geo.scenario_freight_shocks, ("freight_", "chokepoint_")),
        ("gpr", config.geo.scenario_gpr_shocks, ("gpr",)),
        ("duty", config.geo.scenario_duty_shocks, ("geo_event_tariff",)),
    ]

    results: List[Dict[str, object]] = []
    for family, shocks, prefixes in specs:
        for shock in shocks:
            shocked_frame = _shift_prefixed_features(
                base_frame, prefixes, float(shock)
            )
            shocked_frame["price"] = base_frame["price"]
            shocked_pred = model.predict(shocked_frame, horizon)
            shocked = pd.Series(shocked_pred, index=base_frame["part_id"].to_numpy())
            overall = float(
                ((shocked / baseline.replace(0, np.nan) - 1.0) * 100.0).mean(skipna=True)
            )
            by_level = _rollup_delta(baseline, shocked, meta)
            result = ScenarioResult(
                name=f"{family} {shock:+.0f}%",
                shock_pct=float(shock),
                pairs=[family],
                overall_price_change_pct=overall,
                implied_elasticity=overall / shock if shock else 0.0,
                by_level=by_level,
            )
            payload = result.as_dict()
            payload["family"] = family
            results.append(payload)

    logger.info("ran %d geo scenario(s)", len(results))
    return results


# Transmission channel -> the generative beta column it is planted through.
_CHANNEL_BETA_COLUMNS = {
    "steel": "true_steel_beta",
    "freight": "true_freight_beta",
    "gpr": "true_gpr_beta",
}


def _mediator_log_swing(series: pd.Series) -> float:
    """Largest absolute log deviation from the series start.

    Uses the widest swing rather than the end-to-end move, which is the most
    generous measure of the variation a model had available. A channel that
    fails the detectability check on this measure would fail on any tighter one.
    """
    if series.empty:
        return 0.0
    base = float(series.iloc[0])
    if abs(base) < 1e-12:
        return 0.0
    path = np.log(series.to_numpy() / base)
    return float(np.nanmax(np.abs(path)))


def geo_signal_to_noise(
    panel: pd.DataFrame,
    config: Config,
    geo,
) -> Dict[str, object]:
    """Is category-level mediator exposure detectable at this noise level?

    The same question :func:`fx_scenario.fx_signal_to_noise` asks of FX, asked
    per transmission channel. The spread in planted betas times the mediator's
    realised swing is the price gap between the most and least exposed
    category; the AR(1) noise on a category mean is what that gap has to be
    seen through.

    This is what separates "the model failed to rank categories" from "the
    ranking was never recoverable from this panel". Reporting the first when
    the second is true would blame the model for a property of the data.
    """
    swings = {
        "steel": _mediator_log_swing(geo.commodities["steel"].values)
        if "steel" in geo.commodities
        else 0.0,
        "freight": _mediator_log_swing(geo.freight.values),
        "gpr": _mediator_log_swing(geo.gpr["overall"].values)
        if "overall" in geo.gpr
        else 0.0,
    }

    noise_sd = config.generation.noise_sigma / np.sqrt(
        1 - config.generation.noise_phi**2
    )
    parts_per_category = float(panel.groupby("category")["part_id"].nunique().mean())
    months = float(panel["month"].nunique())
    category_noise_pct = float(
        noise_sd * 100 / np.sqrt(max(parts_per_category * months, 1.0))
    )

    channels: Dict[str, object] = {}
    for channel, beta_column in _CHANNEL_BETA_COLUMNS.items():
        if beta_column not in panel.columns:
            continue
        by_category = panel.groupby("category")[beta_column].mean()
        beta_spread = float(by_category.max() - by_category.min())
        signal_pct = beta_spread * swings[channel] * 100
        ratio = signal_pct / category_noise_pct if category_noise_pct else float("inf")
        channels[channel] = {
            "betaSpread": round(beta_spread, 5),
            "mediatorLogSwing": round(swings[channel], 4),
            "signalPct": round(signal_pct, 4),
            "snr": round(float(ratio), 2),
            "identifiable": bool(ratio >= 3.0),
        }
        logger.info(
            "geo signal-to-noise [%s]: beta spread %.5f x swing %.3f = %.3f%% "
            "signal against %.3f%% category-mean noise -> SNR %.2f (%s)",
            channel,
            beta_spread,
            swings[channel],
            signal_pct,
            category_noise_pct,
            ratio,
            "identifiable" if ratio >= 3.0 else "NOT identifiable",
        )

    return {
        "available": bool(channels),
        "categoryMeanNoisePct": round(category_noise_pct, 5),
        "channels": channels,
        "note": (
            "SNR is the cross-category price gap implied by the planted betas "
            "divided by the noise on a category mean. Below ~3 the exposure "
            "ranking is not recoverable from this panel at any feature count, "
            "so a failed shock-ranking test is a statement about the data."
        ),
    }


def geo_trend_collinearity(geo) -> Dict[str, object]:
    """How separable is each mediator from a plain time trend on this window?

    The counterpart to :func:`fx_scenario.fx_trend_collinearity`, and a
    different question from detectability: an effect can be comfortably above
    the noise floor and still be unattributable if the driver moves in lockstep
    with elapsed time. On a 36-month window a mediator that drifts one way for
    three years makes "prices moved because freight moved" and "prices moved
    because time passed" the same statement.

    Mediators are also checked against each other, since commodity and freight
    paths that co-move leave the model unable to split the response between
    them however many lags it is given.
    """
    series_map: Dict[str, np.ndarray] = {}
    for name, mediator in geo.commodities.items():
        series_map[name] = np.log(mediator.values.to_numpy().clip(min=1e-9))
    series_map["freight"] = np.log(geo.freight.values.to_numpy().clip(min=1e-9))
    if "overall" in geo.gpr:
        series_map["gpr"] = geo.gpr["overall"].values.to_numpy().astype(float)

    rows: List[Dict[str, object]] = []
    for name, path in series_map.items():
        cumulative = path - path[0]
        time_index = np.arange(len(cumulative), dtype=float)
        with np.errstate(invalid="ignore"):
            versus_time = float(np.corrcoef(cumulative, time_index)[0, 1])
        rows.append(
            {
                "mediator": name,
                "cumulativeVsTime": round(versus_time if np.isfinite(versus_time) else 0.0, 4),
                "risingMonthsPct": round(float((np.diff(path) > 0).mean() * 100), 1),
            }
        )

    worst_row = max(rows, key=lambda r: abs(float(r["cumulativeVsTime"])), default=None)
    worst = abs(float(worst_row["cumulativeVsTime"])) if worst_row else 0.0
    separable = worst < 0.7

    # Cross-mediator co-movement on returns: if these are high, the channels are
    # not separately identified even when each is separable from time.
    names = list(series_map)
    cross: List[Dict[str, object]] = []
    for i, left in enumerate(names):
        for right in names[i + 1 :]:
            a, b = np.diff(series_map[left]), np.diff(series_map[right])
            with np.errstate(invalid="ignore"):
                corr = float(np.corrcoef(a, b)[0, 1])
            if np.isfinite(corr) and abs(corr) >= 0.5:
                cross.append(
                    {"pair": f"{left}~{right}", "returnCorr": round(corr, 4)}
                )

    logger.info(
        "geo/trend collinearity: worst mediator path correlates %.2f with "
        "elapsed time (%s) -> mediators are %s from trend on this window",
        worst,
        worst_row["mediator"] if worst_row else "n/a",
        "separable" if separable else "NOT separable",
    )

    return {
        "available": bool(rows),
        "mediators": rows,
        "worstMediator": worst_row["mediator"] if worst_row else None,
        "worstCumulativeVsTime": round(worst, 4),
        "separable": bool(separable),
        "collinearMediatorPairs": cross,
        "note": (
            "A mediator whose cumulative path correlates above ~0.7 with "
            "elapsed time cannot be told apart from the trend on this window, "
            "so its category-level attribution is not identified no matter how "
            "the features are built."
        ),
    }


def mediation_diagnostics(
    features: pd.DataFrame,
    panel: pd.DataFrame,
) -> Dict[str, object]:
    """Simple mediation-style correlations for the mechanism narrative.

    Compares the association of GPR with price growth with and without
    controlling for mediator returns (freight, steel, FX). Not a formal causal
    mediation analysis — a transparency diagnostic for the demo.
    """
    # Aggregate to month level to avoid part-level pseudo-replication
    monthly = (
        panel.groupby("month", sort=True)["price"]
        .mean()
        .pct_change()
        .rename("price_mom")
        .to_frame()
    )
    feat_month = features.drop_duplicates("month").set_index("month")

    def col_or_none(*candidates: str) -> Optional[pd.Series]:
        for name in candidates:
            if name in feat_month.columns:
                return feat_month[name]
        return None

    gpr = col_or_none("gpr_z_lag0", "gpr_z_lag1")
    freight = col_or_none("freight_ret_1m", "freight_ret_lag1")
    steel = col_or_none("cmd_steel_ret_1m", "cmd_steel_ret_lag1")
    fx = col_or_none("fx_eurinr_ret_1m", "fx_usdinr_ret_1m")

    frame = monthly.join([s for s in (gpr, freight, steel, fx) if s is not None], how="inner").dropna()
    if len(frame) < 8 or gpr is None:
        return {"available": False, "reason": "insufficient overlap for mediation diagnostic"}

    y = frame["price_mom"]
    g = frame[gpr.name]
    total_corr = float(y.corr(g))

    # Residualise y and g on mediators
    mediators = [c for c in frame.columns if c not in ("price_mom", gpr.name)]
    if mediators:
        # OLS via normal equations
        x = np.column_stack([np.ones(len(frame)), frame[mediators].to_numpy()])
        beta_y, _, _, _ = np.linalg.lstsq(x, y.to_numpy(), rcond=None)
        beta_g, _, _, _ = np.linalg.lstsq(x, g.to_numpy(), rcond=None)
        y_res = y.to_numpy() - x @ beta_y
        g_res = g.to_numpy() - x @ beta_g
        partial = float(np.corrcoef(y_res, g_res)[0, 1])
    else:
        partial = total_corr

    return {
        "available": True,
        "nMonths": int(len(frame)),
        "totalCorrGprPrice": round(total_corr, 4),
        "partialCorrGprPriceGivenMediators": round(partial, 4),
        "mediators": mediators,
        "interpretation": (
            "If the partial correlation shrinks toward zero relative to the "
            "total correlation, GPR's link to prices is largely mediated by "
            "freight / commodities / FX — consistent with the channel model."
        ),
    }


def event_study(
    panel: pd.DataFrame,
    events: Sequence,
    window: int = 6,
) -> List[Dict[str, object]]:
    """Average price path around each curated event (category-level)."""
    monthly = panel.groupby("month", sort=True)["price"].mean()
    if monthly.empty:
        return []

    log_price = np.log(monthly.clip(lower=1e-9))
    studies = []
    for event in events:
        start = pd.Timestamp(event.date_start).to_period("M").to_timestamp()
        if start not in log_price.index:
            # nearest month in sample
            if start < log_price.index.min() or start > log_price.index.max():
                continue
            start = log_price.index[log_price.index.get_indexer([start], method="nearest")[0]]

        offsets = list(range(-window, window + 1))
        path = []
        base = float(log_price.loc[start]) if start in log_price.index else None
        if base is None:
            continue
        for off in offsets:
            month = start + pd.DateOffset(months=off)
            if month not in log_price.index:
                path.append({"offset": off, "logDelta": None, "pctDelta": None})
                continue
            delta = float(log_price.loc[month] - base)
            path.append(
                {
                    "offset": off,
                    "logDelta": round(delta, 5),
                    "pctDelta": round((np.exp(delta) - 1.0) * 100.0, 3),
                }
            )
        studies.append(
            {
                "eventId": event.event_id,
                "category": event.category,
                "severity": event.severity,
                "regionScope": event.region_scope,
                "narrative": event.narrative,
                "anchorMonth": start.strftime("%Y-%m"),
                "path": path,
            }
        )
    return studies
