"""Validation against real, observed data.

Everything else in this project is measured against a synthetic panel, which
proves the pipeline recovers a known generative process but says nothing about
real-world accuracy. This module is the part that can make a genuine claim,
because it uses the one real series available: the BLS CPI index for Motor
Vehicle Parts and Equipment.

Two mechanisms:

* :func:`backtest_real_series` - hold out the final months of *actually
  published* BLS data, fit only on what preceded them, and score the forecast
  against what really happened. Real data, real out-of-sample.

* :class:`ForecastLedger` - record forward forecasts now, with the date they
  were made, and score each one automatically when BLS publishes that month.
  This is the direct answer to "was next month's prediction right?" It starts
  empty and accumulates evidence over time, which is the honest shape of the
  question.

**Back-extrapolated months are excluded from both.** Those months were
reconstructed by this pipeline, not measured by BLS; scoring a forecast against
our own reconstruction would be circular and would inflate the result.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from .config import Config
from .data_sourcing import MacroSeries, load_macro_anchor
from .evaluation import (
    mean_absolute_error,
    mean_absolute_percentage_error,
    root_mean_squared_error,
)
from .logging_utils import get_logger

logger = get_logger(__name__)


# --------------------------------------------------------------------------- #
# Real-series backtest
# --------------------------------------------------------------------------- #


@dataclass
class RealBacktestPoint:
    """One month of the real-data backtest."""

    month: str
    actual: float
    predicted: float
    lower: Optional[float]
    upper: Optional[float]
    horizon: int
    abs_error: float
    pct_error: float
    within_interval: Optional[bool]


@dataclass
class RealBacktestResult:
    """Outcome of forecasting real BLS months from data that preceded them."""

    series_id: str
    model: str
    train_start: str
    train_end: str
    test_start: str
    test_end: str
    n_train: int
    n_test: int
    mae: float
    rmse: float
    mape: float
    coverage_pct: Optional[float]
    points: List[RealBacktestPoint] = field(default_factory=list)

    def as_dict(self) -> Dict[str, object]:
        payload = asdict(self)
        payload["points"] = [asdict(p) for p in self.points]
        return payload


def _real_observations(macro: MacroSeries) -> pd.Series:
    """Return only months BLS actually published.

    Drops any months this pipeline back-extrapolated. Validating against our own
    reconstruction would be circular.
    """
    if macro.observed_start is None:
        return pd.Series(dtype=float)
    real = macro.values[macro.values.index >= macro.observed_start]
    if macro.extrapolated_months:
        logger.info(
            "excluding %d back-extrapolated month(s) from real-data validation; "
            "%d genuinely published observations remain",
            macro.extrapolated_months,
            len(real),
        )
    return real


def _forecast_series(
    train: pd.Series, steps: int, config: Config, model: str
) -> tuple[np.ndarray, Optional[np.ndarray], Optional[np.ndarray]]:
    """Forecast a univariate series ``steps`` ahead.

    Returns ``(point, lower, upper)``; bounds are ``None`` for models without
    an interval.
    """
    alpha = config.evaluation.prediction_interval

    if model == "naive":
        # Random walk: last value carried forward. The baseline any real model
        # must beat before it is worth anything.
        point = np.repeat(float(train.iloc[-1]), steps)
        return point, None, None

    if model == "drift":
        values = train.to_numpy(dtype=float)
        slope = float(np.diff(values).mean())
        return values[-1] + slope * np.arange(1, steps + 1), None, None

    if model == "sarima":
        import warnings

        from statsmodels.tsa.statespace.sarimax import SARIMAX

        sarima_cfg = config.modeling.sarima
        # Only attempt a seasonal fit if the training window actually spans two
        # full cycles. Otherwise the seasonal term is unidentifiable and the fit
        # is noise dressed as structure.
        seasonal = tuple(sarima_cfg.seasonal_order)
        if len(train) < 2 * seasonal[3]:
            seasonal = (0, 0, 0, 0)
            logger.info(
                "real-series backtest: %d training months is under two seasonal "
                "cycles, fitting non-seasonal ARIMA instead",
                len(train),
            )

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fitted = SARIMAX(
                train,
                order=tuple(sarima_cfg.order),
                seasonal_order=seasonal,
                enforce_stationarity=True,
                enforce_invertibility=True,
            ).fit(disp=False)
            prediction = fitted.get_forecast(steps=steps)
            interval = prediction.conf_int(alpha=1 - alpha)

        return (
            prediction.predicted_mean.to_numpy(dtype=float),
            interval.iloc[:, 0].to_numpy(dtype=float),
            interval.iloc[:, 1].to_numpy(dtype=float),
        )

    raise ValueError(f"unknown model '{model}'")


def backtest_real_series(
    config: Config,
    macro: MacroSeries,
    holdout_months: int = 6,
    models: tuple[str, ...] = ("sarima", "naive", "drift"),
) -> List[RealBacktestResult]:
    """Forecast real BLS months using only data published before them.

    This is the project's one claim about real-world accuracy. The model sees
    observations up to month *T*, forecasts *T+1..T+h*, and is scored against
    the values BLS actually published for those months.

    Args:
        config: Pipeline configuration.
        macro: Macro series carrying real observations and their provenance.
        holdout_months: How many real months to withhold and predict.
        models: Which forecasters to compare.

    Returns:
        One :class:`RealBacktestResult` per model, best MAPE first.
    """
    real = _real_observations(macro)

    if len(real) < holdout_months + 6:
        logger.warning(
            "only %d real observations available; need at least %d for a "
            "%d-month holdout with a usable training window. Skipping.",
            len(real),
            holdout_months + 6,
            holdout_months,
        )
        return []

    train = real.iloc[:-holdout_months]
    test = real.iloc[-holdout_months:]

    logger.info(
        "REAL-DATA BACKTEST: training on %d published months (%s to %s), "
        "forecasting %d months (%s to %s) that the model has never seen",
        len(train),
        train.index.min().date(),
        train.index.max().date(),
        len(test),
        test.index.min().date(),
        test.index.max().date(),
    )

    actual = test.to_numpy(dtype=float)
    results: List[RealBacktestResult] = []

    for model in models:
        try:
            point, lower, upper = _forecast_series(train, len(test), config, model)
        except Exception as exc:
            logger.warning("real-series backtest failed for %s: %s", model, exc)
            continue

        points: List[RealBacktestPoint] = []
        for i, (month, truth) in enumerate(test.items()):
            inside = (
                bool(lower[i] <= truth <= upper[i])
                if lower is not None and upper is not None
                else None
            )
            points.append(
                RealBacktestPoint(
                    month=month.strftime("%Y-%m"),
                    actual=round(float(truth), 4),
                    predicted=round(float(point[i]), 4),
                    lower=round(float(lower[i]), 4) if lower is not None else None,
                    upper=round(float(upper[i]), 4) if upper is not None else None,
                    horizon=i + 1,
                    abs_error=round(abs(float(truth) - float(point[i])), 4),
                    pct_error=round((float(point[i]) - float(truth)) / float(truth) * 100, 4),
                    within_interval=inside,
                )
            )

        covered = [p.within_interval for p in points if p.within_interval is not None]
        result = RealBacktestResult(
            series_id=macro.series_id,
            model=model,
            train_start=train.index.min().strftime("%Y-%m"),
            train_end=train.index.max().strftime("%Y-%m"),
            test_start=test.index.min().strftime("%Y-%m"),
            test_end=test.index.max().strftime("%Y-%m"),
            n_train=len(train),
            n_test=len(test),
            mae=round(mean_absolute_error(actual, point), 4),
            rmse=round(root_mean_squared_error(actual, point), 4),
            mape=round(mean_absolute_percentage_error(actual, point), 4),
            coverage_pct=round(100.0 * sum(covered) / len(covered), 2) if covered else None,
            points=points,
        )
        results.append(result)

        logger.info(
            "  %-7s | MAE %7.3f | MAPE %6.3f%% | %s",
            model,
            result.mae,
            result.mape,
            f"coverage {result.coverage_pct:.0f}%" if result.coverage_pct is not None else "no interval",
        )

    results.sort(key=lambda r: r.mape)

    if results:
        best = results[0]
        naive = next((r for r in results if r.model == "naive"), None)
        if naive is not None and best.model != "naive":
            lift = (naive.mape - best.mape) / naive.mape * 100
            logger.info(
                "best real-data model is '%s' at %.3f%% MAPE, %.1f%% better than "
                "carrying the last value forward",
                best.model,
                best.mape,
                lift,
            )
        elif naive is not None and best.model == "naive":
            logger.warning(
                "on real data, no model beat the naive last-value baseline "
                "(%.3f%% MAPE). The modelling adds nothing here.",
                naive.mape,
            )
    return results


# --------------------------------------------------------------------------- #
# Forward forecast ledger
# --------------------------------------------------------------------------- #


@dataclass
class LedgerEntry:
    """A forecast recorded before its target month was published.

    ``actual`` stays ``None`` until BLS releases that month, at which point the
    entry is scored. An entry can never be edited after the fact - that is the
    whole point of writing it down in advance.
    """

    forecast_made_on: str
    origin_month: str
    target_month: str
    model: str
    predicted: float
    lower: Optional[float] = None
    upper: Optional[float] = None
    actual: Optional[float] = None
    abs_error: Optional[float] = None
    pct_error: Optional[float] = None
    within_interval: Optional[bool] = None
    scored_on: Optional[str] = None

    @property
    def is_scored(self) -> bool:
        return self.actual is not None


class ForecastLedger:
    """Append-only record of forward forecasts and their eventual outcomes.

    Answers "was the prediction for next month right?" the only way it can
    honestly be answered: write the prediction down before the answer exists,
    then check it when reality arrives.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.entries: List[LedgerEntry] = []
        self._load()

    def _load(self) -> None:
        if not self.path.is_file():
            logger.info("no existing forecast ledger at %s; starting a new one", self.path)
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            self.entries = [LedgerEntry(**row) for row in payload.get("entries", [])]
            logger.info(
                "loaded forecast ledger: %d entries (%d already scored)",
                len(self.entries),
                sum(1 for e in self.entries if e.is_scored),
            )
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            logger.warning("ledger at %s is unreadable (%s); starting fresh", self.path, exc)
            self.entries = []

    def save(self) -> Path:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "description": (
                "Forward forecasts of the real BLS index, recorded before the "
                "target month was published, and scored once it was."
            ),
            "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "entries": [asdict(e) for e in self.entries],
        }
        self.path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return self.path

    def record(
        self,
        origin_month: pd.Timestamp,
        target_month: pd.Timestamp,
        model: str,
        predicted: float,
        lower: Optional[float] = None,
        upper: Optional[float] = None,
    ) -> bool:
        """Record a forecast unless one already exists for that month and model.

        Returns:
            True if a new entry was added, False if it was already recorded.
            Existing entries are never overwritten - a forecast you can revise
            after seeing the outcome is not a forecast.
        """
        key = (target_month.strftime("%Y-%m"), model)
        if any((e.target_month, e.model) == key for e in self.entries):
            return False

        self.entries.append(
            LedgerEntry(
                forecast_made_on=date.today().isoformat(),
                origin_month=origin_month.strftime("%Y-%m"),
                target_month=target_month.strftime("%Y-%m"),
                model=model,
                predicted=round(float(predicted), 4),
                lower=round(float(lower), 4) if lower is not None else None,
                upper=round(float(upper), 4) if upper is not None else None,
            )
        )
        return True

    def score_against(self, observed: pd.Series) -> int:
        """Score any pending entry whose target month has now been published.

        Args:
            observed: Real published index values, indexed by month.

        Returns:
            Number of entries newly scored.
        """
        lookup = {ts.strftime("%Y-%m"): float(v) for ts, v in observed.items()}
        newly_scored = 0

        for entry in self.entries:
            if entry.is_scored:
                continue
            actual = lookup.get(entry.target_month)
            if actual is None:
                continue

            entry.actual = round(actual, 4)
            entry.abs_error = round(abs(entry.predicted - actual), 4)
            entry.pct_error = round((entry.predicted - actual) / actual * 100, 4)
            if entry.lower is not None and entry.upper is not None:
                entry.within_interval = bool(entry.lower <= actual <= entry.upper)
            entry.scored_on = date.today().isoformat()
            newly_scored += 1

            logger.info(
                "SCORED: %s forecast for %s was %.3f, BLS published %.3f "
                "(%.2f%% error)",
                entry.model,
                entry.target_month,
                entry.predicted,
                actual,
                entry.pct_error,
            )

        if newly_scored:
            logger.info("scored %d previously pending forecast(s)", newly_scored)
        return newly_scored

    def summary(self) -> Dict[str, object]:
        """Aggregate accuracy over scored entries, per model."""
        scored = [e for e in self.entries if e.is_scored]
        pending = [e for e in self.entries if not e.is_scored]

        by_model: Dict[str, Dict[str, float]] = {}
        for model in sorted({e.model for e in scored}):
            rows = [e for e in scored if e.model == model]
            errors = np.array([e.abs_error for e in rows], dtype=float)
            pct = np.array([abs(e.pct_error) for e in rows], dtype=float)
            covered = [e.within_interval for e in rows if e.within_interval is not None]
            by_model[model] = {
                "n_scored": len(rows),
                "mae": round(float(errors.mean()), 4),
                "mape": round(float(pct.mean()), 4),
                "coverage_pct": (
                    round(100.0 * sum(covered) / len(covered), 2) if covered else None
                ),
            }

        return {
            "n_entries": len(self.entries),
            "n_scored": len(scored),
            "n_pending": len(pending),
            "next_target_month": (
                min((e.target_month for e in pending), default=None)
            ),
            "by_model": by_model,
            "entries": [asdict(e) for e in sorted(self.entries, key=lambda e: e.target_month)],
        }


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #


def run_validation(config: Config, macro: Optional[MacroSeries] = None) -> Dict[str, object]:
    """Run the real-data backtest, update the ledger, and return both.

    Called by the pipeline's ``validate`` stage. Safe to run repeatedly: the
    ledger refuses to overwrite an existing forecast, so re-running scores new
    outcomes without rewriting history.
    """
    macro = macro or load_macro_anchor(config)
    real = _real_observations(macro)

    if real.empty:
        logger.warning(
            "no real observations available (source=%s); real-data validation "
            "cannot run and the dashboard will say so",
            macro.source,
        )
        return {
            "available": False,
            "reason": f"no real BLS observations (source: {macro.source})",
            "backtests": [],
            "ledger": {"n_entries": 0, "n_scored": 0, "n_pending": 0, "by_model": {}, "entries": []},
        }

    backtests = backtest_real_series(config, macro, holdout_months=6)

    # --- Ledger: record forecasts for months BLS has not published yet ------
    ledger = ForecastLedger(config.paths.data_processed / "forecast_ledger.json")
    ledger.score_against(real)

    horizon = config.modeling.forecast_horizon
    origin = real.index.max()
    added = 0
    for model in ("sarima", "naive"):
        try:
            point, lower, upper = _forecast_series(real, horizon, config, model)
        except Exception as exc:
            logger.warning("could not produce forward forecast for %s: %s", model, exc)
            continue
        for step in range(horizon):
            target = origin + pd.DateOffset(months=step + 1)
            if ledger.record(
                origin_month=origin,
                target_month=target,
                model=model,
                predicted=point[step],
                lower=lower[step] if lower is not None else None,
                upper=upper[step] if upper is not None else None,
            ):
                added += 1

    ledger.save()
    if added:
        logger.info(
            "recorded %d new forward forecast(s) for months BLS has not yet "
            "published; they will be scored automatically on a future run",
            added,
        )

    summary = ledger.summary()
    logger.info(
        "forecast ledger: %d entries, %d scored, %d awaiting publication "
        "(next: %s)",
        summary["n_entries"],
        summary["n_scored"],
        summary["n_pending"],
        summary["next_target_month"],
    )

    return {
        "available": True,
        "series_id": macro.series_id,
        "n_real_observations": len(real),
        "real_range": [
            real.index.min().strftime("%Y-%m"),
            real.index.max().strftime("%Y-%m"),
        ],
        "excluded_extrapolated_months": macro.extrapolated_months,
        "backtests": [r.as_dict() for r in backtests],
        "ledger": summary,
    }
