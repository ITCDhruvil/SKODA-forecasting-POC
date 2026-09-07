"""Metrics, holdout evaluation, and rolling-origin backtesting.

Two evaluations run here, and they answer different questions:

* **Holdout** - one forecast origin at the end of training, projected across the
  test and validation windows. Answers "how good is a forecast made today?"
* **Rolling-origin backtest** - several successive origins, each re-fitting on
  only what was known at that time. Answers "is that accuracy stable, or did we
  get one lucky split?" A single split on 36 months is far too easy to
  over-read, which is the whole reason this exists.

A fairness detail that materially affects the headline numbers: SARIMA is fit
per part and capped at ``sarima.max_parts`` for runtime, while XGBoost is global
and covers every part. Comparing them over different part sets would be
meaningless, so :func:`compare_on_common_parts` restricts all models to the
intersection before ranking them.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from .config import Config
from .logging_utils import get_logger
from .modeling import (
    GlobalXGBModel,
    build_supervised_frame,
    category_median_forecast,
    fit_sarima_panel,
    seasonal_naive_forecast,
    split_by_time,
    train_global_xgboost,
)

logger = get_logger(__name__)

MODEL_NAMES = ("seasonal_naive", "sarima", "xgboost")


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #


def mean_absolute_error(actual: np.ndarray, predicted: np.ndarray) -> float:
    """Mean absolute error in price units (USD)."""
    return float(np.mean(np.abs(actual - predicted)))


def root_mean_squared_error(actual: np.ndarray, predicted: np.ndarray) -> float:
    """RMSE - penalises large misses more heavily than MAE."""
    return float(np.sqrt(np.mean((actual - predicted) ** 2)))


def mean_absolute_percentage_error(
    actual: np.ndarray, predicted: np.ndarray, epsilon: float = 1e-6
) -> float:
    """MAPE as a percentage.

    Prices here are strictly positive so the denominator is safe, but it is
    clamped anyway - MAPE silently exploding to infinity on one bad row is a
    classic way to produce a nonsense headline number.
    """
    denominator = np.maximum(np.abs(actual), epsilon)
    return float(np.mean(np.abs((actual - predicted) / denominator)) * 100.0)


def compute_metrics(frame: pd.DataFrame) -> Dict[str, float]:
    """Compute MAE/RMSE/MAPE over a frame with ``actual`` and ``prediction``."""
    valid = frame.dropna(subset=["actual", "prediction"])
    if valid.empty:
        return {"mae": np.nan, "rmse": np.nan, "mape": np.nan, "n": 0}

    actual = valid["actual"].to_numpy(dtype=float)
    predicted = valid["prediction"].to_numpy(dtype=float)
    return {
        "mae": mean_absolute_error(actual, predicted),
        "rmse": root_mean_squared_error(actual, predicted),
        "mape": mean_absolute_percentage_error(actual, predicted),
        "n": int(len(valid)),
    }


def metrics_by(
    predictions: pd.DataFrame, group_columns: Sequence[str]
) -> pd.DataFrame:
    """Metric table grouped by arbitrary columns (model, horizon, category...)."""
    records = []
    for keys, group in predictions.groupby(list(group_columns), sort=True):
        if not isinstance(keys, tuple):
            keys = (keys,)
        record = dict(zip(group_columns, keys))
        record.update(compute_metrics(group))
        records.append(record)
    return pd.DataFrame(records)


# --------------------------------------------------------------------------- #
# Prediction assembly
# --------------------------------------------------------------------------- #


def _actuals_lookup(panel: pd.DataFrame) -> pd.Series:
    return panel.set_index(["part_id", "month"])["price"]


def _attach_actuals(predictions: pd.DataFrame, panel: pd.DataFrame) -> pd.DataFrame:
    """Join true prices onto a prediction frame by (part, target month)."""
    lookup = _actuals_lookup(panel)
    index = pd.MultiIndex.from_arrays(
        [predictions["part_id"], predictions["target_month"]]
    )
    predictions = predictions.copy()
    predictions["actual"] = lookup.reindex(index).to_numpy()
    return predictions


def _xgboost_predictions(
    model: GlobalXGBModel,
    features: pd.DataFrame,
    origin_month: pd.Timestamp,
    horizons: Sequence[int],
) -> pd.DataFrame:
    """Predict from a single forecast origin for every part."""
    origin_rows = features[features["month"] == origin_month]
    if origin_rows.empty:
        raise ValueError(f"no feature rows at origin month {origin_month.date()}")

    records = []
    for h in horizons:
        if h not in model.models:
            continue
        predicted = model.predict(origin_rows, h)
        records.append(
            pd.DataFrame(
                {
                    "part_id": origin_rows["part_id"].to_numpy(),
                    "horizon": h,
                    "target_month": origin_month + pd.DateOffset(months=h),
                    "prediction": predicted,
                }
            )
        )
    return pd.concat(records, ignore_index=True) if records else pd.DataFrame()


def _sarima_predictions(
    sarima_results: Dict[str, object], horizons: Sequence[int]
) -> pd.DataFrame:
    """Flatten per-part SARIMA results into a prediction frame with intervals."""
    records = []
    for part_id, result in sarima_results.items():
        forecast = result.forecast
        for position, h in enumerate(horizons):
            if position >= len(forecast):
                break
            records.append(
                {
                    "part_id": part_id,
                    "horizon": h,
                    "target_month": forecast.index[position],
                    "prediction": float(forecast.iloc[position]),
                    "lower": float(result.lower.iloc[position]),
                    "upper": float(result.upper.iloc[position]),
                    "fallback_level": result.fallback_level,
                }
            )
    return pd.DataFrame(records)


def generate_all_predictions(
    features: pd.DataFrame,
    panel: pd.DataFrame,
    config: Config,
    origin_month: pd.Timestamp,
    horizons: Sequence[int],
    fit_sarima: bool = True,
    feature_columns: Optional[Sequence[str]] = None,
) -> pd.DataFrame:
    """Train every model up to ``origin_month`` and predict forward.

    Nothing at or after ``origin_month + 1`` is visible to any model, which is
    what makes the resulting metrics an honest out-of-sample estimate.

    Returns:
        Long frame: ``model, part_id, horizon, target_month, prediction``
        (plus ``lower``/``upper`` where the model provides intervals).
    """
    history = panel[panel["month"] <= origin_month]
    history_features = features[features["month"] <= origin_month]

    frames = []

    # --- Baseline -----------------------------------------------------------
    naive = seasonal_naive_forecast(history, origin_month, horizons)
    naive["model"] = "seasonal_naive"
    frames.append(naive)

    # --- Global XGBoost -----------------------------------------------------
    xgb_model = train_global_xgboost(
        history_features,
        config,
        origin_month,
        horizons,
        feature_columns=feature_columns,
    )
    xgb_predictions = _xgboost_predictions(
        xgb_model, history_features, origin_month, horizons
    )
    if not xgb_predictions.empty:
        xgb_predictions["model"] = "xgboost"
        frames.append(xgb_predictions)

    # --- Thin-history parts get the category-median fallback ----------------
    thin_parts = (
        panel.loc[panel.get("insufficient_history", False) == True, "part_id"]  # noqa: E712
        .unique()
        .tolist()
        if "insufficient_history" in panel.columns
        else []
    )
    if thin_parts:
        fallback = category_median_forecast(history, thin_parts, origin_month, horizons)
        if not fallback.empty:
            fallback["model"] = "category_median_fallback"
            frames.append(fallback)
            logger.info(
                "applied category-median fallback to %d thin-history part(s)",
                len(thin_parts),
            )

    # --- Per-part SARIMA ----------------------------------------------------
    if fit_sarima:
        sarima_results = fit_sarima_panel(history, config, steps=max(horizons))
        sarima_predictions = _sarima_predictions(sarima_results, horizons)
        if not sarima_predictions.empty:
            sarima_predictions["model"] = "sarima"
            frames.append(sarima_predictions)

    predictions = pd.concat(frames, ignore_index=True)
    predictions["origin_month"] = origin_month
    return _attach_actuals(predictions, panel)


# --------------------------------------------------------------------------- #
# Holdout evaluation
# --------------------------------------------------------------------------- #


def evaluate_holdout(
    features: pd.DataFrame,
    panel: pd.DataFrame,
    config: Config,
    fit_sarima: bool = True,
    feature_columns: Optional[Sequence[str]] = None,
) -> pd.DataFrame:
    """Single-origin evaluation across the test and validation windows.

    The origin is the end of training. Horizons 1..test_months land in the test
    window; the remainder land in validation, which no model has seen in any
    form.

    Set ``fit_sarima=False`` for feature-ablation runs: SARIMA is univariate and
    ignores the feature matrix, so refitting it per arm costs runtime without
    changing the comparison.
    """
    splits = split_by_time(features, config)
    origin = splits["train_end"]
    total_horizon = config.modeling.test_months + config.modeling.validation_months
    horizons = list(range(1, total_horizon + 1))

    logger.info(
        "holdout evaluation from origin %s over horizons 1..%d",
        origin.date(),
        total_horizon,
    )
    predictions = generate_all_predictions(
        features,
        panel,
        config,
        origin,
        horizons,
        fit_sarima=fit_sarima,
        feature_columns=feature_columns,
    )

    predictions["split"] = np.where(
        predictions["target_month"] <= splits["test_end"], "test", "validation"
    )
    # Carry through the anomaly label so metrics can be split by it later.
    anomaly = panel.groupby("part_id")[["is_anomaly_part", "category"]].first()
    predictions = predictions.merge(
        anomaly, left_on="part_id", right_index=True, how="left"
    )
    return predictions


# --------------------------------------------------------------------------- #
# Rolling-origin backtest
# --------------------------------------------------------------------------- #


def rolling_origin_backtest(
    features: pd.DataFrame,
    panel: pd.DataFrame,
    config: Config,
    feature_columns: Optional[Sequence[str]] = None,
) -> pd.DataFrame:
    """Re-fit and forecast from several successive origins.

    Expanding window: each fold trains on everything up to its own origin, so
    fold *k* never sees data that fold *k+1* introduces. Reports whether
    accuracy is stable across time or an artifact of one split.
    """
    months = pd.DatetimeIndex(sorted(features["month"].unique()))
    n_folds = config.evaluation.backtest_folds
    fold_horizon = config.evaluation.backtest_horizon

    # Place origins so the last fold's forecast ends at the final month, and
    # earlier folds step back one month at a time.
    origins = [months[-(fold_horizon + offset)] for offset in range(n_folds)][::-1]

    logger.info(
        "rolling-origin backtest: %d fold(s), horizon %d, origins %s",
        n_folds,
        fold_horizon,
        [origin.date().isoformat() for origin in origins],
    )

    frames = []
    for fold, origin in enumerate(origins, start=1):
        logger.info("backtest fold %d/%d - origin %s", fold, n_folds, origin.date())
        predictions = generate_all_predictions(
            features,
            panel,
            config,
            origin,
            list(range(1, fold_horizon + 1)),
            fit_sarima=True,
            feature_columns=feature_columns,
        )
        predictions["fold"] = fold
        frames.append(predictions)

    backtest = pd.concat(frames, ignore_index=True)
    anomaly = panel.groupby("part_id")[["is_anomaly_part", "category"]].first()
    return backtest.merge(anomaly, left_on="part_id", right_index=True, how="left")


# --------------------------------------------------------------------------- #
# Fair comparison and interval calibration
# --------------------------------------------------------------------------- #


def compare_on_common_parts(predictions: pd.DataFrame) -> pd.DataFrame:
    """Rank models over the parts that *every* model actually covered.

    SARIMA is capped at ``sarima.max_parts`` for runtime while XGBoost is
    global. Left uncorrected, the two would be scored on different part sets and
    the comparison would be worthless. This restricts to the intersection.
    """
    core = predictions[predictions["model"].isin(MODEL_NAMES)]
    part_sets = [
        set(group["part_id"].unique()) for _, group in core.groupby("model")
    ]
    if not part_sets:
        return pd.DataFrame()

    common = set.intersection(*part_sets)
    logger.info(
        "fair comparison over %d part(s) covered by all %d models",
        len(common),
        core["model"].nunique(),
    )
    restricted = core[core["part_id"].isin(common)]
    table = metrics_by(restricted, ["model"]).sort_values("mae").reset_index(drop=True)
    table["n_parts"] = len(common)
    return table


def empirical_prediction_intervals(
    backtest: pd.DataFrame, config: Config, model: str = "xgboost"
) -> Dict[int, Dict[str, float]]:
    """Derive per-horizon prediction intervals from backtest residuals.

    XGBoost gives a point estimate only. Rather than inventing a Gaussian
    assumption, take the empirical quantiles of residuals actually observed
    during backtesting - a distribution-free interval that reflects how this
    model missed on this data.

    Residuals are expressed as a *ratio* to the prediction, so the interval
    scales with price level: a $12 filter and a $240 alternator do not share an
    absolute error band.

    After computing raw quantiles, a conformal-style inflate expands the band
    until in-sample residual coverage meets ``interval_coverage_target``.
    """
    alpha = config.evaluation.prediction_interval
    target = config.evaluation.interval_coverage_target
    max_inflate = config.evaluation.interval_max_inflate
    lower_q = (1.0 - alpha) / 2.0
    upper_q = 1.0 - lower_q

    subset = backtest[(backtest["model"] == model)].dropna(
        subset=["actual", "prediction"]
    )
    intervals: Dict[int, Dict[str, float]] = {}

    for horizon, group in subset.groupby("horizon"):
        ratio = group["actual"] / group["prediction"].replace(0.0, np.nan)
        ratio = ratio.replace([np.inf, -np.inf], np.nan).dropna()
        if len(ratio) < 10:
            logger.warning(
                "only %d residual(s) at horizon %d; interval will be unreliable",
                len(ratio),
                horizon,
            )
        lo = float(ratio.quantile(lower_q)) if len(ratio) else 0.9
        hi = float(ratio.quantile(upper_q)) if len(ratio) else 1.1

        # Inflate symmetrically in log-ratio space until residual coverage hits target
        inflate = 1.0
        if len(ratio) >= 10:
            for candidate in np.linspace(1.0, max_inflate, 41):
                lo_c = 1.0 - (1.0 - lo) * candidate
                hi_c = 1.0 + (hi - 1.0) * candidate
                covered = float(((ratio >= lo_c) & (ratio <= hi_c)).mean())
                inflate = float(candidate)
                if covered >= target:
                    break
            lo = 1.0 - (1.0 - lo) * inflate
            hi = 1.0 + (hi - 1.0) * inflate

        intervals[int(horizon)] = {
            "lower_ratio": lo,
            "upper_ratio": hi,
            "n": int(len(ratio)),
            "inflate": round(inflate, 3),
        }

    if intervals:
        logger.info(
            "empirical %.0f%% intervals for %s by horizon (target coverage %.0f%%): %s",
            alpha * 100,
            model,
            target * 100,
            ", ".join(
                f"h{h}=[{v['lower_ratio']:.3f}, {v['upper_ratio']:.3f}]"
                f"x{v.get('inflate', 1):.2f}"
                for h, v in sorted(intervals.items())
            ),
        )
    return intervals


def extrapolate_intervals(
    intervals: Dict[int, Dict[str, float]], horizons: Sequence[int]
) -> Dict[int, Dict[str, float]]:
    """Extend interval ratios to horizons the backtest did not reach.

    The backtest runs a shorter horizon than the final forecast. Rather than
    reusing the last measured band flat (which would understate long-horizon
    uncertainty), widen it by the square root of the horizon ratio, matching how
    random-walk uncertainty grows.
    """
    if not intervals:
        return {h: {"lower_ratio": 0.9, "upper_ratio": 1.1, "n": 0} for h in horizons}

    max_measured = max(intervals)
    extended = dict(intervals)
    base = intervals[max_measured]

    for h in horizons:
        if h in extended:
            continue
        scale = np.sqrt(h / max_measured)
        extended[h] = {
            "lower_ratio": 1.0 - (1.0 - base["lower_ratio"]) * scale,
            "upper_ratio": 1.0 + (base["upper_ratio"] - 1.0) * scale,
            "n": 0,
        }
    return extended


def coverage_report(
    predictions: pd.DataFrame, config: Config
) -> Optional[Dict[str, float]]:
    """Measure whether stated intervals actually contain the truth.

    An 80% interval that covers 40% of outcomes is worse than no interval at
    all, because it invites false confidence. Reported so the reader can check.
    """
    has_bounds = predictions.dropna(subset=["lower", "upper", "actual"]) if {
        "lower",
        "upper",
    }.issubset(predictions.columns) else pd.DataFrame()

    if has_bounds.empty:
        return None

    records = {}
    for model, group in has_bounds.groupby("model"):
        inside = (group["actual"] >= group["lower"]) & (group["actual"] <= group["upper"])
        records[str(model)] = float(inside.mean() * 100.0)
        logger.info(
            "%s: nominal %.0f%% interval achieved %.1f%% empirical coverage (n=%d)",
            model,
            config.evaluation.prediction_interval * 100,
            records[str(model)],
            len(group),
        )
    return records
