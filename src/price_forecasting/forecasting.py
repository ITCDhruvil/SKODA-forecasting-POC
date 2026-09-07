"""Forward forecasting beyond the end of history.

Distinct from :mod:`evaluation`, which deliberately holds data back. Here every
model is refit on the *complete* history - withholding the last two months from
the model that ships would mean deploying something weaker than what was
measured.

Uncertainty comes from two places: SARIMA's analytic intervals, and empirical
residual quantiles harvested from the backtest for XGBoost. The latter are
extrapolated past the backtest horizon by a square-root-of-time rule so the
bands widen with distance rather than staying flat.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, Optional, Sequence

import numpy as np
import pandas as pd

from .config import Config
from .evaluation import extrapolate_intervals
from .logging_utils import get_logger
from .modeling import (
    category_median_forecast,
    fit_sarima_panel,
    seasonal_naive_forecast,
    train_global_xgboost,
)
from .preprocessing import get_feature_columns

logger = get_logger(__name__)


def generate_forward_forecasts(
    features: pd.DataFrame,
    panel: pd.DataFrame,
    config: Config,
    interval_ratios: Dict[int, Dict[str, float]],
    feature_columns: Optional[Sequence[str]] = None,
) -> pd.DataFrame:
    """Produce ``forecast_horizon`` months of forward forecasts for every part.

    Args:
        features: Full engineered feature frame.
        panel: Full cleaned panel.
        config: Pipeline configuration.
        interval_ratios: Per-horizon empirical interval ratios from the
            backtest, used to band the XGBoost point forecasts.
        feature_columns: Optional relevance-gated columns for XGBoost.

    Returns:
        Long frame: ``model, part_id, horizon, target_month, prediction,
        lower, upper``.
    """
    horizon = config.modeling.forecast_horizon
    horizons = list(range(1, horizon + 1))
    origin = features["month"].max()

    logger.info(
        "forward forecast: origin %s, horizons 1..%d (through %s)",
        origin.date(),
        horizon,
        (origin + pd.DateOffset(months=horizon)).date(),
    )

    frames = []

    # --- Global XGBoost, refit on everything --------------------------------
    cols = list(feature_columns) if feature_columns is not None else get_feature_columns(features)
    xgb_model = train_global_xgboost(
        features, config, origin, horizons, feature_columns=cols
    )
    origin_rows = features[features["month"] == origin]
    ratios = extrapolate_intervals(interval_ratios, horizons)

    for h in horizons:
        if h not in xgb_model.models:
            continue
        point = xgb_model.predict(origin_rows, h)
        band = ratios[h]
        frames.append(
            pd.DataFrame(
                {
                    "model": "xgboost",
                    "part_id": origin_rows["part_id"].to_numpy(),
                    "horizon": h,
                    "target_month": origin + pd.DateOffset(months=h),
                    "prediction": point,
                    "lower": point * band["lower_ratio"],
                    "upper": point * band["upper_ratio"],
                }
            )
        )

    # --- Per-part SARIMA with analytic intervals ----------------------------
    sarima_results = fit_sarima_panel(panel, config, steps=horizon)
    sarima_records = []
    for part_id, result in sarima_results.items():
        for position, h in enumerate(horizons):
            if position >= len(result.forecast):
                break
            sarima_records.append(
                {
                    "model": "sarima",
                    "part_id": part_id,
                    "horizon": h,
                    "target_month": result.forecast.index[position],
                    "prediction": float(result.forecast.iloc[position]),
                    "lower": float(result.lower.iloc[position]),
                    "upper": float(result.upper.iloc[position]),
                    "fallback_level": result.fallback_level,
                }
            )
    if sarima_records:
        frames.append(pd.DataFrame(sarima_records))

    # --- Baseline, for reference in the output ------------------------------
    naive = seasonal_naive_forecast(panel, origin, horizons)
    naive["model"] = "seasonal_naive"
    naive["lower"] = np.nan
    naive["upper"] = np.nan
    frames.append(naive)

    # --- Thin-history parts -------------------------------------------------
    if "insufficient_history" in panel.columns:
        thin = panel.loc[panel["insufficient_history"], "part_id"].unique().tolist()
        if thin:
            fallback = category_median_forecast(panel, thin, origin, horizons)
            if not fallback.empty:
                fallback["model"] = "category_median_fallback"
                fallback["lower"] = fallback["prediction"] * 0.85
                fallback["upper"] = fallback["prediction"] * 1.15
                frames.append(fallback)

    forecasts = pd.concat(frames, ignore_index=True)
    forecasts["origin_month"] = origin

    static_columns = [
        column
        for column in (
            "part_name", "project", "project_code", "vendor", "vendor_code",
            "vendor_origin", "category", "category_code", "oem",
            "is_anomaly_part",
        )
        if column in panel.columns
    ]
    static = panel.groupby("part_id")[static_columns].first()
    forecasts = forecasts.merge(static, left_on="part_id", right_index=True, how="left")

    _sanity_check(forecasts, panel)
    return forecasts


def _sanity_check(forecasts: pd.DataFrame, panel: pd.DataFrame) -> None:
    """Log anything about the forecast that looks wrong before it ships."""
    negative = (forecasts["prediction"] <= 0).sum()
    if negative:
        logger.warning("%d forecast(s) are non-positive prices", negative)

    inverted = (forecasts["upper"] < forecasts["lower"]).sum()
    if inverted:
        logger.warning("%d forecast(s) have upper bound below lower bound", inverted)

    # Interval width should grow with horizon. If it does not, the uncertainty
    # model is not doing its job.
    for model, group in forecasts.dropna(subset=["lower", "upper"]).groupby("model"):
        width = (
            ((group["upper"] - group["lower"]) / group["prediction"])
            .groupby(group["horizon"])
            .mean()
        )
        if len(width) > 1 and width.iloc[-1] <= width.iloc[0]:
            logger.warning(
                "%s: relative interval width does not widen with horizon "
                "(h1=%.3f, h%d=%.3f)",
                model,
                width.iloc[0],
                width.index[-1],
                width.iloc[-1],
            )
        else:
            logger.info(
                "%s: relative interval width h1=%.1f%% -> h%d=%.1f%%",
                model,
                width.iloc[0] * 100,
                width.index[-1],
                width.iloc[-1] * 100,
            )


def save_forecasts(config: Config, forecasts: pd.DataFrame) -> Path:
    """Write forward forecasts to ``data/processed/forecasts.csv``."""
    config.paths.data_processed.mkdir(parents=True, exist_ok=True)
    out_path = config.paths.data_processed / "forecasts.csv"
    forecasts.to_csv(out_path, index=False, date_format="%Y-%m-%d")
    logger.info(
        "wrote %d forecast rows to %s (%d parts x %d horizons x %d models)",
        len(forecasts),
        out_path,
        forecasts["part_id"].nunique(),
        forecasts["horizon"].nunique(),
        forecasts["model"].nunique(),
    )
    return out_path
