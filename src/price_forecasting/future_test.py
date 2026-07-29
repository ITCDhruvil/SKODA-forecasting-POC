"""Simulated-future test: forecast 6 months, then reveal them and score.

The question this answers is "if the model forecasts the next six months, how
wrong will it be, month by month?" - which the holdout evaluation only answers
indirectly.

Mechanism: generate a panel that is ``history_months + future_months`` long,
hide the tail, train every model on the visible part only, forecast the hidden
months, then reveal them and score. Nothing about the hidden window reaches the
models: not through features, not through training rows, not through the macro
anchor.

**What this does and does not prove.** The hidden months come from the same
generative process as the training months, so this measures how well each model
recovers a known process at each horizon. It is a genuine out-of-sample test of
the *forecasting machinery* - splits, feature construction, multi-step strategy,
target formulation - and it is the right way to compare models against each
other. It is **not** evidence about real-world accuracy; the only real-world
claim in this project lives in :mod:`validation`, scored against published BLS
data. The two are reported separately and must not be conflated.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from .config import Config
from .data_generation import generate_price_panel
from .data_sourcing import MacroSeries, load_macro_anchor
from .fx import FxSeries, load_fx_series
from .evaluation import (
    mean_absolute_error,
    mean_absolute_percentage_error,
    root_mean_squared_error,
)
from .logging_utils import get_logger
from .modeling import (
    fit_sarima_panel,
    seasonal_naive_forecast,
    train_global_xgboost,
)
from .preprocessing import PreprocessingReport, build_features, clean_panel

logger = get_logger(__name__)


@dataclass
class HorizonScore:
    """Error at one horizon for one model."""

    horizon: int
    target_month: str
    mae: float
    rmse: float
    mape: float
    mean_signed_pct: float
    n: int


@dataclass
class ModelScore:
    """Full scorecard for one model over the revealed window."""

    model: str
    mae: float
    rmse: float
    mape: float
    mean_signed_pct: float
    worst_month: str
    worst_month_mape: float
    n: int
    by_horizon: List[HorizonScore] = field(default_factory=list)

    def as_dict(self) -> Dict[str, object]:
        payload = asdict(self)
        payload["by_horizon"] = [asdict(h) for h in self.by_horizon]
        return payload


def _extend_macro(macro: MacroSeries, extra_months: int, config: Config) -> MacroSeries:
    """Extend the macro anchor forward so the hidden months have a trend to sit on.

    The extension continues the observed mean log drift. It is used only to
    *generate* the hidden months; the models never see it beyond the visible
    window, because features are built from the truncated panel.
    """
    values = macro.values
    log_steps = np.diff(np.log(values.to_numpy()))
    drift = float(log_steps.mean()) if len(log_steps) else 0.0

    future_index = pd.date_range(
        values.index.max() + pd.DateOffset(months=1), periods=extra_months, freq="MS"
    )
    last = float(values.iloc[-1])
    future_values = last * np.exp(drift * np.arange(1, extra_months + 1))

    extended = pd.concat(
        [values, pd.Series(future_values, index=future_index, name=values.name)]
    )
    return MacroSeries(
        values=extended,
        series_id=macro.series_id,
        source=macro.source,
        observed_start=macro.observed_start,
        extrapolated_months=macro.extrapolated_months,
    )


def _score(frame: pd.DataFrame, model: str) -> Optional[ModelScore]:
    """Score one model's predictions against the revealed actuals."""
    valid = frame.dropna(subset=["actual", "prediction"])
    if valid.empty:
        return None

    actual = valid["actual"].to_numpy(dtype=float)
    predicted = valid["prediction"].to_numpy(dtype=float)
    signed_pct = (predicted - actual) / actual * 100

    by_horizon: List[HorizonScore] = []
    for horizon, group in valid.groupby("horizon"):
        a = group["actual"].to_numpy(dtype=float)
        p = group["prediction"].to_numpy(dtype=float)
        by_horizon.append(
            HorizonScore(
                horizon=int(horizon),
                target_month=group["target_month"].iloc[0].strftime("%Y-%m"),
                mae=round(mean_absolute_error(a, p), 4),
                rmse=round(root_mean_squared_error(a, p), 4),
                mape=round(mean_absolute_percentage_error(a, p), 4),
                mean_signed_pct=round(float(((p - a) / a * 100).mean()), 4),
                n=int(len(group)),
            )
        )

    worst = max(by_horizon, key=lambda h: h.mape)
    return ModelScore(
        model=model,
        mae=round(mean_absolute_error(actual, predicted), 4),
        rmse=round(root_mean_squared_error(actual, predicted), 4),
        mape=round(mean_absolute_percentage_error(actual, predicted), 4),
        mean_signed_pct=round(float(signed_pct.mean()), 4),
        worst_month=worst.target_month,
        worst_month_mape=worst.mape,
        n=int(len(valid)),
        by_horizon=sorted(by_horizon, key=lambda h: h.horizon),
    )


def _extend_fx(
    fx: Dict[str, FxSeries], extra_months: int
) -> Dict[str, FxSeries]:
    """Extend each FX pair forward at its observed drift.

    Used only to *generate* the hidden months. The models never see FX beyond
    the visible window, because their features are built from the truncated
    panel.
    """
    extended: Dict[str, FxSeries] = {}
    for pair, series in fx.items():
        values = series.values
        log_steps = np.diff(np.log(values.to_numpy()))
        drift = float(log_steps.mean()) if len(log_steps) else 0.0
        future_index = pd.date_range(
            values.index.max() + pd.DateOffset(months=1), periods=extra_months, freq="MS"
        )
        future_values = float(values.iloc[-1]) * np.exp(drift * np.arange(1, extra_months + 1))
        extended[pair] = FxSeries(
            values=pd.concat(
                [values, pd.Series(future_values, index=future_index, name=values.name)]
            ),
            pair=series.pair,
            base=series.base,
            quote=series.quote,
            source=series.source,
            observed_start=series.observed_start,
            extrapolated_months=series.extrapolated_months,
        )
    return extended


def run_future_test(
    config: Config,
    macro: Optional[MacroSeries] = None,
    future_months: Optional[int] = None,
    fx: Optional[Dict[str, FxSeries]] = None,
) -> Dict[str, object]:
    """Generate extra months, forecast them blind, then reveal and score.

    Returns a payload with per-model and per-horizon error rates, plus the
    aggregate actual-vs-predicted path for charting.
    """
    macro = macro or load_macro_anchor(config)
    fx = fx or load_fx_series(config, macro.values.index)
    future_months = future_months or config.evaluation.future_test_months
    horizons = list(range(1, future_months + 1))

    # --- 1. Build a world that runs `future_months` past the normal history --
    extended_macro = _extend_macro(macro, future_months, config)
    extended_fx = _extend_fx(fx, future_months)

    extended_config = _with_history(config, config.generation.history_months + future_months)
    full_panel = generate_price_panel(extended_config, extended_macro, extended_fx)

    months = pd.DatetimeIndex(sorted(full_panel["month"].unique()))
    cutoff = months[-(future_months + 1)]
    revealed_months = months[-future_months:]

    logger.info(
        "FUTURE TEST: generated %d months, hiding the last %d (%s to %s). "
        "Models train on data up to %s only.",
        len(months),
        future_months,
        revealed_months.min().date(),
        revealed_months.max().date(),
        cutoff.date(),
    )

    visible = full_panel[full_panel["month"] <= cutoff].copy()
    hidden = full_panel[full_panel["month"] > cutoff].copy()

    # --- 2. Clean and featurise ONLY the visible window ---------------------
    report = PreprocessingReport()
    visible_clean = clean_panel(visible, config, report)
    visible_macro = MacroSeries(
        values=extended_macro.values[extended_macro.values.index <= cutoff],
        series_id=macro.series_id,
        source=macro.source,
        observed_start=macro.observed_start,
        extrapolated_months=macro.extrapolated_months,
    )
    visible_fx = {
        pair: FxSeries(
            values=series.values[series.values.index <= cutoff],
            pair=series.pair,
            base=series.base,
            quote=series.quote,
            source=series.source,
            observed_start=series.observed_start,
            extrapolated_months=series.extrapolated_months,
        )
        for pair, series in extended_fx.items()
    }
    visible_features = build_features(
        visible_clean, config, visible_macro, report, fx=visible_fx
    )

    # --- 3. Forecast the hidden window --------------------------------------
    frames = []

    naive = seasonal_naive_forecast(visible_clean, cutoff, horizons)
    naive["model"] = "seasonal_naive"
    frames.append(naive)

    xgb = train_global_xgboost(visible_features, config, cutoff, horizons)
    origin_rows = visible_features[visible_features["month"] == cutoff]
    for h in horizons:
        if h not in xgb.models:
            continue
        frames.append(
            pd.DataFrame(
                {
                    "model": "xgboost",
                    "part_id": origin_rows["part_id"].to_numpy(),
                    "horizon": h,
                    "target_month": cutoff + pd.DateOffset(months=h),
                    "prediction": xgb.predict(origin_rows, h),
                }
            )
        )

    sarima_results = fit_sarima_panel(visible_clean, config, steps=future_months)
    sarima_rows = []
    for part_id, result in sarima_results.items():
        for position, h in enumerate(horizons):
            if position >= len(result.forecast):
                break
            sarima_rows.append(
                {
                    "model": "sarima",
                    "part_id": part_id,
                    "horizon": h,
                    "target_month": result.forecast.index[position],
                    "prediction": float(result.forecast.iloc[position]),
                }
            )
    if sarima_rows:
        frames.append(pd.DataFrame(sarima_rows))

    predictions = pd.concat(frames, ignore_index=True)

    # --- 4. Reveal and score -------------------------------------------------
    truth = hidden.set_index(["part_id", "month"])["price"]
    index = pd.MultiIndex.from_arrays(
        [predictions["part_id"], predictions["target_month"]]
    )
    predictions["actual"] = truth.reindex(index).to_numpy()

    static = full_panel.groupby("part_id")[["category", "is_anomaly_part"]].first()
    predictions = predictions.merge(static, left_on="part_id", right_index=True, how="left")

    scores: List[ModelScore] = []
    for model, group in predictions.groupby("model"):
        score = _score(group, str(model))
        if score is not None:
            scores.append(score)
    scores.sort(key=lambda s: s.mape)

    for score in scores:
        logger.info(
            "  %-15s | MAE $%6.3f | MAPE %5.2f%% | bias %+5.2f%% | worst %s (%.2f%%)",
            score.model,
            score.mae,
            score.mape,
            score.mean_signed_pct,
            score.worst_month,
            score.worst_month_mape,
        )

    baseline = next((s for s in scores if s.model == "seasonal_naive"), None)
    best = scores[0] if scores else None
    if best and baseline and best.model != "seasonal_naive":
        logger.info(
            "future test: '%s' beats the seasonal-naive baseline by %.1f%% on MAE",
            best.model,
            (baseline.mae - best.mae) / baseline.mae * 100,
        )
    elif best and best.model == "seasonal_naive":
        logger.warning(
            "future test: no model beat seasonal-naive (%.2f%% MAPE)", baseline.mape
        )

    # --- 5. Aggregate path for the chart ------------------------------------
    actual_path = hidden.groupby("month")["price"].mean()
    history_path = visible_clean.groupby("month")["price"].mean()

    series_rows = []
    for month, value in history_path.items():
        series_rows.append(
            {
                "month": month.strftime("%Y-%m"),
                "label": month.strftime("%b %Y"),
                "actual": round(float(value), 3),
                "revealed": None,
                **{f"pred_{s.model}": None for s in scores},
            }
        )
    for month in revealed_months:
        row = {
            "month": month.strftime("%Y-%m"),
            "label": month.strftime("%b %Y"),
            "actual": None,
            "revealed": round(float(actual_path[month]), 3),
        }
        for score in scores:
            subset = predictions[
                (predictions["model"] == score.model)
                & (predictions["target_month"] == month)
            ]
            row[f"pred_{score.model}"] = (
                round(float(subset["prediction"].mean()), 3) if not subset.empty else None
            )
        series_rows.append(row)

    # Category breakdown for the best model, so error can be attributed.
    category_rows = []
    if best:
        subset = predictions[predictions["model"] == best.model].dropna(
            subset=["actual", "prediction"]
        )
        for category, group in subset.groupby("category"):
            a = group["actual"].to_numpy(dtype=float)
            p = group["prediction"].to_numpy(dtype=float)
            category_rows.append(
                {
                    "category": str(category),
                    "mape": round(mean_absolute_percentage_error(a, p), 3),
                    "mae": round(mean_absolute_error(a, p), 3),
                    "mean_signed_pct": round(float(((p - a) / a * 100).mean()), 3),
                    "n": int(len(group)),
                }
            )
        category_rows.sort(key=lambda r: r["mape"], reverse=True)

    # How close is the best model to the best any model could do?
    floors = irreducible_error_floor(config, horizons)
    floor_rows = []
    if best:
        # best.by_horizon holds HorizonScore dataclasses, not dicts.
        by_horizon = {h.horizon: h.mape for h in best.by_horizon}
        for h in horizons:
            achieved = by_horizon.get(h)
            if achieved is None:
                continue
            floor_rows.append(
                {
                    "horizon": h,
                    "label": f"h{h}",
                    "achieved": round(achieved, 3),
                    "floor": round(floors[h], 3),
                    "excess": round(achieved - floors[h], 3),
                    "efficiencyPct": round(floors[h] / achieved * 100, 1),
                }
            )
        mean_floor = float(np.mean([r["floor"] for r in floor_rows]))
        logger.info(
            "noise floor: best model achieved %.2f%% MAPE against an irreducible "
            "%.2f%% - %.0f%% of the best attainable, %.2fpp of headroom left",
            best.mape,
            mean_floor,
            mean_floor / best.mape * 100,
            best.mape - mean_floor,
        )

    # Idiosyncratic noise averages out across parts, so the aggregate line has a
    # far tighter noise band than any single part. Any visible gap there is
    # systematic, not sampling noise - worth stating so the two are not confused.
    n_parts = int(full_panel["part_id"].nunique())
    stationary_sd = config.generation.noise_sigma / np.sqrt(
        1 - config.generation.noise_phi**2
    )
    aggregate_noise_pct = float(stationary_sd / np.sqrt(n_parts) * 100)

    return {
        "available": True,
        "targetMode": config.modeling.xgboost_target_mode,
        "noiseFloor": {
            "byHorizon": floor_rows,
            "meanFloorPct": round(float(np.mean(list(floors.values()))), 3),
            "bestAchievedPct": round(best.mape, 3) if best else None,
            "aggregateNoisePct": round(aggregate_noise_pct, 4),
            "note": (
                "The generator injects AR(1) noise, so a portion of every future "
                "price is unpredictable by construction. This floor is what a "
                "perfect model would score. Per-part error near the floor is as "
                "good as the data allows. The aggregate mean-price line is a "
                "different matter: idiosyncratic noise averages out across parts, "
                "so any visible gap there is systematic model error, not noise."
            ),
        },
        "futureMonths": future_months,
        "trainEnd": cutoff.strftime("%Y-%m"),
        "revealedRange": [
            revealed_months.min().strftime("%Y-%m"),
            revealed_months.max().strftime("%Y-%m"),
        ],
        "nParts": int(full_panel["part_id"].nunique()),
        "scores": [s.as_dict() for s in scores],
        "series": series_rows,
        "byCategory": category_rows,
        "disclaimer": (
            "Hidden months come from the same generative process as the training "
            "months. This measures how well each model recovers a known process "
            "at each horizon - a valid comparison between models, but not "
            "evidence of real-world accuracy. For that, see the real-data "
            "validation scored against published BLS observations."
        ),
    }


def irreducible_error_floor(config: Config, horizons: Sequence[int]) -> Dict[int, float]:
    """Lowest MAPE any model could achieve, given the injected noise.

    The generator adds AR(1) noise with known ``phi`` and ``sigma``. From month
    *t*, only ``phi**h`` of the noise at *t+h* is knowable; the rest is fresh
    shocks that no model can see coming. That unpredictable part is a hard floor.

    Without this number, "the error should be lower" is unfalsifiable. With it,
    achieved error can be read as a fraction of what is actually attainable.

    Returns:
        ``{horizon: floor_mape_pct}``.
    """
    phi = config.generation.noise_phi
    sigma = config.generation.noise_sigma

    floors: Dict[int, float] = {}
    for h in horizons:
        variance = sigma**2 * (1 - phi ** (2 * h)) / (1 - phi**2)
        # For X ~ N(0, sd), E|X| = sd * sqrt(2/pi). Log-noise of this size is
        # approximately a proportional price error at these magnitudes.
        floors[h] = float(np.sqrt(variance) * np.sqrt(2 / np.pi) * 100)
    return floors


def _with_history(config: Config, history_months: int) -> Config:
    """Return a shallow copy of the config with a different history length.

    The dataclasses are frozen, so this rebuilds the one field that changes
    rather than mutating in place.
    """
    import dataclasses

    generation = dataclasses.replace(config.generation, history_months=history_months)
    return dataclasses.replace(config, generation=generation)


def compare_target_modes(
    config: Config,
    macro: Optional[MacroSeries] = None,
    fx: Optional[Dict[str, FxSeries]] = None,
) -> Dict[str, object]:
    """Run the future test under both target formulations and compare.

    Direct evidence for whether predicting log-returns actually fixes the
    extrapolation bias, rather than an appeal to theory.
    """
    import dataclasses

    macro = macro or load_macro_anchor(config)
    fx = fx or load_fx_series(config, macro.values.index)
    results = {}

    for mode in ("level", "log_return"):
        modeling = dataclasses.replace(config.modeling, xgboost_target_mode=mode)
        variant = dataclasses.replace(config, modeling=modeling)
        logger.info("--- future test with xgboost_target_mode=%s ---", mode)
        payload = run_future_test(variant, macro, fx=fx)
        xgb = next((s for s in payload["scores"] if s["model"] == "xgboost"), None)
        results[mode] = {
            "mape": xgb["mape"] if xgb else None,
            "mae": xgb["mae"] if xgb else None,
            "mean_signed_pct": xgb["mean_signed_pct"] if xgb else None,
            "by_horizon": xgb["by_horizon"] if xgb else [],
        }

    level = results.get("level", {})
    log_return = results.get("log_return", {})
    if level.get("mape") and log_return.get("mape"):
        improvement = (level["mape"] - log_return["mape"]) / level["mape"] * 100
        logger.info(
            "target mode comparison: level %.3f%% MAPE (bias %+.2f%%) vs "
            "log_return %.3f%% MAPE (bias %+.2f%%) - %.1f%% improvement",
            level["mape"],
            level["mean_signed_pct"],
            log_return["mape"],
            log_return["mean_signed_pct"],
            improvement,
        )
        results["improvementPct"] = round(improvement, 2)

    return results
