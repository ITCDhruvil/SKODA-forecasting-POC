"""Forecasting models: seasonal naive, per-part SARIMA, and a global XGBoost.

Model selection rationale
-------------------------

**Global XGBoost with part-level features (primary).** Each individual series
has only 36 monthly points - nowhere near enough to fit a per-part ML model
without overfitting. Pooling all 320 parts gives ~11.5k rows and lets shared
structure (category seasonality, the macro trend, brand price levels) be learned
once and reused. It also handles short-history and cold-start parts, and yields
one artifact to deploy instead of 320. The trade-off is that it smooths over
part-specific idiosyncrasy - which is precisely what the per-part statistical
model is there to recover.

**Per-part SARIMA (statistical comparator).** Interpretable, gives analytic
prediction intervals, and models each series on its own terms. Fit per part with
a fallback ladder, because a seasonal model on 36 observations will not always
converge and pretending otherwise would be dishonest. Capped at
``sarima.max_parts`` for POC runtime.

**Seasonal naive (baseline).** ``price[t+h] = price[t+h-12]``. Non-negotiable:
without a trivial baseline there is no way to claim either real model earns its
complexity.

Multi-step strategy
-------------------

**Direct, not recursive.** One model per horizon h in 1..H, each mapping
features at origin *t* to the price at *t+h*. Recursive forecasting would need
lag features regenerated from the model's own predictions, compounding error and
adding a fragile feedback path. Direct costs H times the training work, which at
this scale is seconds.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from .config import Config
from .logging_utils import get_logger
from .preprocessing import get_feature_columns

logger = get_logger(__name__)

SEASONAL_PERIOD = 12


# --------------------------------------------------------------------------- #
# Target construction
# --------------------------------------------------------------------------- #


def build_supervised_frame(
    features: pd.DataFrame, horizon: int, target_mode: str = "log_return"
) -> pd.DataFrame:
    """Attach the horizon-``h`` target to a feature frame.

    Two target formulations, and the choice matters more than any
    hyperparameter:

    ``level``
        Predict ``price[t+h]`` directly. Intuitive, but **gradient-boosted trees
        cannot extrapolate**: a tree predicts the mean of a training leaf, so
        every prediction is bounded by the range of targets seen in training.
        On a series that trends upward, the model structurally undershoots as
        soon as reality climbs past the training ceiling, and the bias grows
        with horizon.

    ``log_return`` (default)
        Predict ``log(price[t+h] / price[t])``. The target is roughly stationary
        and centred near zero, so it stays inside the training range even when
        the price level does not. The level is reconstructed at prediction time
        as ``price[t] * exp(prediction)``, which is unbounded above.

    Rows whose target falls past the end of the series get NaN and are dropped
    by the trainer, never imputed - inventing a target would corrupt the metrics.
    """
    if target_mode not in ("level", "log_return"):
        raise ValueError(f"unknown target_mode '{target_mode}'")

    frame = features.sort_values(["part_id", "month"]).copy()
    grouped = frame.groupby("part_id", sort=False)

    future_price = grouped["price"].shift(-horizon)
    frame["future_price"] = future_price
    frame["target_month"] = grouped["month"].shift(-horizon)

    if target_mode == "level":
        frame["target"] = future_price
    else:
        # Guard against non-positive prices; log is undefined there and a single
        # bad row would poison the whole horizon's training set.
        safe_now = frame["price"].where(frame["price"] > 0)
        safe_future = future_price.where(future_price > 0)
        frame["target"] = np.log(safe_future / safe_now)

    return frame


def split_by_time(
    frame: pd.DataFrame, config: Config
) -> Dict[str, pd.Timestamp]:
    """Compute the time-based split boundaries.

    Splits are chronological, never random. A random split on a time series
    leaks the future into the training set through neighbouring months and
    produces metrics that cannot be reproduced in deployment.

    Returns:
        Dict with ``train_end``, ``test_end`` and ``validation_end`` month
        boundaries. Train is ``<= train_end``, test is
        ``(train_end, test_end]``, validation is ``(test_end, validation_end]``.
    """
    months = pd.DatetimeIndex(sorted(frame["month"].unique()))
    n = len(months)
    n_validation = config.modeling.validation_months
    n_test = config.modeling.test_months

    if n_validation + n_test >= n:
        raise ValueError(
            f"validation ({n_validation}) + test ({n_test}) months >= history ({n})"
        )

    validation_end = months[-1]
    test_end = months[n - 1 - n_validation]
    train_end = months[n - 1 - n_validation - n_test]

    logger.info(
        "time split | train <= %s | test %s..%s | validation %s..%s",
        train_end.date(),
        months[n - n_validation - n_test].date(),
        test_end.date(),
        months[n - n_validation].date(),
        validation_end.date(),
    )
    return {
        "train_end": train_end,
        "test_end": test_end,
        "validation_end": validation_end,
    }


# --------------------------------------------------------------------------- #
# Baseline
# --------------------------------------------------------------------------- #


def seasonal_naive_forecast(
    history: pd.DataFrame, origin_month: pd.Timestamp, horizons: Sequence[int]
) -> pd.DataFrame:
    """Seasonal naive: repeat the value from 12 months before the target month.

    Falls back to the last observed value when the series does not reach back a
    full year - which is the honest behaviour for a short series, rather than
    silently returning NaN.

    Args:
        history: Long panel with ``part_id``, ``month``, ``price``.
        origin_month: Last month of observed data.
        horizons: Steps ahead to predict.

    Returns:
        Frame with ``part_id``, ``horizon``, ``target_month``, ``prediction``.
    """
    lookup = history.set_index(["part_id", "month"])["price"]
    last_value = (
        history.sort_values("month").groupby("part_id")["price"].last()
    )

    records = []
    for part_id in history["part_id"].unique():
        for h in horizons:
            target_month = origin_month + pd.DateOffset(months=h)
            source_month = target_month - pd.DateOffset(months=SEASONAL_PERIOD)
            value = lookup.get((part_id, source_month), np.nan)
            if pd.isna(value):
                value = last_value.get(part_id, np.nan)
            records.append(
                {
                    "part_id": part_id,
                    "horizon": h,
                    "target_month": target_month,
                    "prediction": float(value),
                }
            )
    return pd.DataFrame(records)


# --------------------------------------------------------------------------- #
# Global XGBoost
# --------------------------------------------------------------------------- #


@dataclass
class GlobalXGBModel:
    """Direct multi-horizon XGBoost: one fitted booster per horizon.

    When ``target_mode`` is ``log_return`` the boosters predict a log ratio, and
    :meth:`predict` converts back to a price level. Callers always receive
    prices, so the rest of the pipeline is unaffected by the choice.
    """

    models: Dict[int, object] = field(default_factory=dict)
    feature_columns: List[str] = field(default_factory=list)
    residual_quantiles: Dict[int, Tuple[float, float]] = field(default_factory=dict)
    categories: Dict[str, pd.Index] = field(default_factory=dict)
    target_mode: str = "log_return"

    def align_categories(self, frame: pd.DataFrame) -> pd.DataFrame:
        """Re-apply training-time categorical levels to a new frame.

        XGBoost's categorical support requires consistent category codes between
        fit and predict. Without this, an unseen brand at inference time silently
        shifts every code and corrupts predictions.
        """
        frame = frame.copy()
        for column, levels in self.categories.items():
            if column in frame.columns:
                frame[column] = pd.Categorical(frame[column], categories=levels)
        return frame

    def predict(self, frame: pd.DataFrame, horizon: int) -> np.ndarray:
        """Predict **prices** at ``horizon`` months ahead for each row.

        Under ``log_return`` the booster's raw output is a log ratio; it is
        converted back to a level here so every caller sees prices regardless of
        how the model was parameterised.
        """
        if horizon not in self.models:
            raise KeyError(f"no model trained for horizon {horizon}")

        aligned = self.align_categories(frame)
        raw = self.models[horizon].predict(aligned[self.feature_columns])

        if self.target_mode == "level":
            return raw

        anchor = frame["price"].to_numpy(dtype=float)
        # Clip the log return before exponentiating. An extreme leaf value would
        # otherwise turn into an absurd price; +/-0.7 in log space is roughly a
        # halving or doubling over the horizon, well beyond anything plausible
        # for spare parts pricing.
        return anchor * np.exp(np.clip(raw, -0.7, 0.7))


def train_global_xgboost(
    features: pd.DataFrame,
    config: Config,
    train_end: pd.Timestamp,
    horizons: Sequence[int],
    feature_columns: Optional[Sequence[str]] = None,
) -> GlobalXGBModel:
    """Fit one XGBoost regressor per forecast horizon.

    Args:
        features: Engineered feature frame.
        config: Pipeline configuration.
        train_end: Last month allowed in training. Both the feature row *and*
            its target month must fall at or before this boundary, otherwise the
            model would train on a target it should not have seen.
        horizons: Forecast horizons to train.
        feature_columns: Optional relevance-gated column list. Defaults to every
            non-label column on ``features``.

    Returns:
        A fitted :class:`GlobalXGBModel`.
    """
    from xgboost import XGBRegressor  # imported here so the module loads without it

    target_mode = config.modeling.xgboost_target_mode
    cols = list(feature_columns) if feature_columns is not None else get_feature_columns(features)
    # Drop anything missing from the frame (stale selection vs new preprocess)
    cols = [c for c in cols if c in features.columns]
    if not cols:
        cols = get_feature_columns(features)
    model = GlobalXGBModel(feature_columns=cols, target_mode=target_mode)

    model.categories = {
        column: features[column].cat.categories
        for column in features.columns
        if str(features[column].dtype) == "category"
    }

    params = config.modeling.xgboost.as_params(config.project.random_seed)

    for h in horizons:
        supervised = build_supervised_frame(features, h, target_mode=target_mode)
        # Critical: filter on target_month, not month. A row at t=train_end with
        # h=6 has its target six months in the future - inside the test window.
        mask = (
            supervised["target_month"].notna()
            & (supervised["target_month"] <= train_end)
            & supervised["target"].notna()
        )
        train = supervised.loc[mask]

        if train.empty:
            logger.warning("no training rows available for horizon %d; skipping", h)
            continue

        regressor = XGBRegressor(enable_categorical=True, tree_method="hist", **params)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            regressor.fit(train[cols], train["target"])

        model.models[h] = regressor
        logger.debug(
            "trained XGBoost h=%d on %d rows (target_mode=%s, targets up to %s)",
            h,
            len(train),
            target_mode,
            train["target_month"].max().date(),
        )

    logger.info(
        "trained %d XGBoost horizon model(s) with target_mode=%s on %d feature(s)",
        len(model.models),
        target_mode,
        len(cols),
    )
    return model


# --------------------------------------------------------------------------- #
# Per-part SARIMA
# --------------------------------------------------------------------------- #


@dataclass
class SarimaResult:
    """Outcome of fitting SARIMA to one part."""

    part_id: str
    order: Tuple[int, int, int]
    seasonal_order: Optional[Tuple[int, int, int, int]]
    forecast: pd.Series
    lower: pd.Series
    upper: pd.Series
    fallback_level: str
    message: str = ""


def _drift_forecast(
    series: pd.Series, steps: int, alpha: float
) -> Tuple[pd.Series, pd.Series, pd.Series]:
    """Random-walk-with-drift forecast, the last rung of the fallback ladder.

    Used when both SARIMA and plain ARIMA fail to converge. Simple, always
    available, and never silently presented as a fitted seasonal model.
    """
    from scipy import stats

    values = series.to_numpy(dtype=float)
    diffs = np.diff(values)
    drift = float(diffs.mean()) if len(diffs) else 0.0
    sigma = float(diffs.std(ddof=1)) if len(diffs) > 1 else max(abs(values[-1]) * 0.05, 0.01)

    index = pd.date_range(
        series.index[-1] + pd.DateOffset(months=1), periods=steps, freq="MS"
    )
    steps_ahead = np.arange(1, steps + 1)
    point = values[-1] + drift * steps_ahead
    # Uncertainty in a random walk grows with the square root of the horizon.
    spread = stats.norm.ppf(1 - (1 - alpha) / 2) * sigma * np.sqrt(steps_ahead)

    return (
        pd.Series(point, index=index),
        pd.Series(point - spread, index=index),
        pd.Series(point + spread, index=index),
    )


# A forecast outside this multiple of the last observed price is treated as a
# failed fit, not a bold prediction. Spare parts prices do not 5x or fall by 80%
# within six months; a forecast that says so has diverged.
PLAUSIBLE_RATIO_BOUNDS = (0.2, 5.0)


def _assert_plausible(
    forecast: pd.Series, history: pd.Series, part_id: str, level: str
) -> None:
    """Reject forecasts that are finite but economically absurd.

    Checking only ``isfinite`` is not enough: an explosive AR root produces
    perfectly finite numbers that grow by orders of magnitude. This is the guard
    that actually catches divergence and demotes the fit to the next rung of the
    ladder.

    Raises:
        ValueError: If the forecast is non-finite, non-positive, or outside
            :data:`PLAUSIBLE_RATIO_BOUNDS` relative to the last observation.
    """
    values = forecast.to_numpy(dtype=float)
    if not np.isfinite(values).all():
        raise ValueError("forecast contained non-finite values")

    last = float(history.iloc[-1])
    if last <= 0:
        raise ValueError("history ends at a non-positive price")

    ratio = values / last
    low, high = PLAUSIBLE_RATIO_BOUNDS
    if (ratio < low).any() or (ratio > high).any():
        raise ValueError(
            f"{level} forecast for {part_id} diverged: ratio range "
            f"[{ratio.min():.2f}, {ratio.max():.2f}] outside [{low}, {high}]"
        )
    if (values <= 0).any():
        raise ValueError("forecast contained non-positive prices")


def fit_sarima_for_part(
    series: pd.Series, config: Config, steps: int, part_id: str
) -> SarimaResult:
    """Fit SARIMA to one part with an explicit fallback ladder.

    Ladder: seasonal SARIMA -> non-seasonal ARIMA -> random walk with drift.
    Each failure is caught and recorded on the result rather than swallowed, so
    the report can state how many parts actually got a seasonal fit.
    """
    from statsmodels.tsa.statespace.sarimax import SARIMAX

    sarima_cfg = config.modeling.sarima
    alpha = config.evaluation.prediction_interval
    order = tuple(sarima_cfg.order)
    seasonal_order = tuple(sarima_cfg.seasonal_order)

    attempts = [
        ("sarima", order, seasonal_order),
        ("arima", tuple(sarima_cfg.fallback_order), (0, 0, 0, 0)),
    ]

    for level, attempt_order, attempt_seasonal in attempts:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                # Stationarity and invertibility are ENFORCED. With ~28 training
                # points a seasonal model is heavily over-parameterised, and
                # leaving these off lets the estimated AR root fall outside the
                # unit circle - which produces a forecast that diverges
                # exponentially rather than merely being wrong. Constraining the
                # roots costs some in-sample fit and buys forecasts that stay
                # in the realm of actual prices.
                fitted = SARIMAX(
                    series,
                    order=attempt_order,
                    seasonal_order=attempt_seasonal,
                    enforce_stationarity=True,
                    enforce_invertibility=True,
                ).fit(disp=False)

                prediction = fitted.get_forecast(steps=steps)
                mean = prediction.predicted_mean
                interval = prediction.conf_int(alpha=1 - alpha)

            _assert_plausible(mean, series, part_id, level)

            return SarimaResult(
                part_id=part_id,
                order=attempt_order,
                seasonal_order=attempt_seasonal if level == "sarima" else None,
                forecast=mean,
                lower=interval.iloc[:, 0],
                upper=interval.iloc[:, 1],
                fallback_level=level,
            )
        except Exception as exc:  # statsmodels raises a wide variety here
            logger.debug("%s %s failed for %s: %s", level, attempt_order, part_id, exc)
            last_error = exc

    point, lower, upper = _drift_forecast(series, steps, alpha)
    return SarimaResult(
        part_id=part_id,
        order=(0, 1, 0),
        seasonal_order=None,
        forecast=point,
        lower=lower,
        upper=upper,
        fallback_level="drift",
        message=str(last_error)[:200],
    )


def fit_sarima_panel(
    history: pd.DataFrame,
    config: Config,
    steps: int,
    part_ids: Optional[Sequence[str]] = None,
) -> Dict[str, SarimaResult]:
    """Fit SARIMA to each part and report how far down the ladder each fell.

    Args:
        history: Long panel restricted to the training window.
        config: Pipeline configuration.
        steps: Forecast steps to produce.
        part_ids: Parts to fit. Defaults to the first ``sarima.max_parts``
            parts in sorted order, for reproducible POC runtime.
    """
    if part_ids is None:
        all_parts = sorted(history["part_id"].unique())
        cap = config.modeling.sarima.max_parts

        # Always include the structural-break parts, even though they sort late.
        # Without this the cap silently excludes them and the robustness section
        # of the report has no SARIMA row to compare - the statistical model
        # would never be tested on the hard cases.
        anomaly_parts = (
            sorted(history.loc[history["is_anomaly_part"], "part_id"].unique())
            if "is_anomaly_part" in history.columns
            else []
        )
        remaining = [p for p in all_parts if p not in set(anomaly_parts)]
        part_ids = (anomaly_parts + remaining)[:cap]

        if len(all_parts) > len(part_ids):
            logger.info(
                "fitting SARIMA to %d of %d parts (sarima.max_parts cap for POC "
                "runtime; all %d structural-break parts included)",
                len(part_ids),
                len(all_parts),
                len(anomaly_parts),
            )

    results: Dict[str, SarimaResult] = {}
    for part_id in part_ids:
        series = (
            history.loc[history["part_id"] == part_id]
            .sort_values("month")
            .set_index("month")["price"]
            .astype(float)
            .dropna()
        )
        series = series.asfreq("MS") if series.index.freq is None else series
        series = series.interpolate()

        if len(series) < 2 * SEASONAL_PERIOD:
            logger.debug("part %s too short for seasonal fit (%d obs)", part_id, len(series))

        results[part_id] = fit_sarima_for_part(series, config, steps, part_id)

    ladder = pd.Series([r.fallback_level for r in results.values()]).value_counts()
    logger.info(
        "SARIMA fit outcomes across %d parts: %s",
        len(results),
        ", ".join(f"{level}={count}" for level, count in ladder.items()),
    )
    if ladder.get("drift", 0):
        logger.warning(
            "%d part(s) fell through to random-walk-with-drift; neither SARIMA "
            "nor ARIMA converged on their history",
            ladder["drift"],
        )
    return results


# --------------------------------------------------------------------------- #
# Fallback for thin-history parts
# --------------------------------------------------------------------------- #


def category_median_forecast(
    history: pd.DataFrame, part_ids: Sequence[str], origin_month: pd.Timestamp, horizons: Sequence[int]
) -> pd.DataFrame:
    """Forecast thin-history parts from their category's recent median growth.

    A part with too few observations to model on its own still needs a number in
    production. Borrowing the category's growth rate and applying it to the
    part's own last known price is the least-assumption option available.
    """
    recent = history[history["month"] > origin_month - pd.DateOffset(months=6)]
    growth = (
        recent.sort_values("month")
        .groupby(["category", "month"])["price"]
        .median()
        .groupby("category")
        .pct_change()
        .groupby("category")
        .mean()
        .fillna(0.0)
    )

    last = history.sort_values("month").groupby("part_id").last()
    records = []
    for part_id in part_ids:
        if part_id not in last.index:
            continue
        base = float(last.loc[part_id, "price"])
        rate = float(growth.get(last.loc[part_id, "category"], 0.0))
        for h in horizons:
            records.append(
                {
                    "part_id": part_id,
                    "horizon": h,
                    "target_month": origin_month + pd.DateOffset(months=h),
                    "prediction": base * (1.0 + rate) ** h,
                }
            )
    return pd.DataFrame(records)
