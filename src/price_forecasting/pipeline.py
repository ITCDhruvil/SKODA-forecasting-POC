"""CLI orchestrator wiring every stage together.

    python -m price_forecasting.pipeline --config config.yaml --stage all

Stages run in dependency order and cache their outputs to disk, so a later stage
can be re-run on its own without repeating the expensive ones.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from .config import Config, ConfigError, load_config
from .data_generation import generate_price_panel, load_panel, save_panel
from .data_sourcing import MacroSeries, load_macro_anchor, write_dataset_audit
from .evaluation import (
    compare_on_common_parts,
    coverage_report,
    empirical_prediction_intervals,
    evaluate_holdout,
    metrics_by,
    rolling_origin_backtest,
)
from .export import build_dashboard_payload, export_dashboard
from .forecasting import generate_forward_forecasts, save_forecasts
from .future_test import compare_target_modes, run_future_test
from .fx import FxSeries, fx_provenance, load_fx_series
from .fx_scenario import (
    fx_signal_to_noise,
    fx_trend_collinearity,
    hierarchy_rollup,
    run_fx_scenarios,
    validate_fx_learning,
)
from .hierarchy import exposure_summary
from .modeling import train_global_xgboost
from .logging_utils import configure_logging, get_logger, log_run_banner
from .preprocessing import (
    PreprocessingReport,
    build_features,
    clean_panel,
    save_features,
)
from .report import render_report
from .validation import run_validation
from .visualization import generate_all_figures

logger = get_logger(__name__)

STAGES = (
    "source",
    "generate",
    "preprocess",
    "evaluate",
    "forecast",
    "fxscenario",
    "futuretest",
    "validate",
    "report",
    "export",
    "all",
)


class PipelineState:
    """Carries artifacts between stages within a single run."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.macro: Optional[MacroSeries] = None
        self.fx: Optional[Dict[str, FxSeries]] = None
        self.fx_scenarios: Optional[List[Dict[str, object]]] = None
        self.fx_analysis: Optional[Dict[str, object]] = None
        self.fx_learning: Optional[Dict[str, object]] = None
        self.rollups: Optional[Dict[str, List[Dict[str, object]]]] = None
        self.panel: Optional[pd.DataFrame] = None
        self.clean: Optional[pd.DataFrame] = None
        self.features: Optional[pd.DataFrame] = None
        self.prep_report = PreprocessingReport()
        self.holdout: Optional[pd.DataFrame] = None
        self.backtest: Optional[pd.DataFrame] = None
        self.forecasts: Optional[pd.DataFrame] = None
        self.validation: Optional[Dict[str, object]] = None
        self.future_test: Optional[Dict[str, object]] = None
        self.versions: Dict[str, str] = {}

    def require_future_test(self) -> Optional[Dict[str, object]]:
        if self.future_test is None:
            path = self.config.paths.data_processed / "future_test.json"
            if path.is_file():
                self.future_test = json.loads(path.read_text(encoding="utf-8"))
        return self.future_test

    def require_fx_analysis(self) -> Optional[Dict[str, object]]:
        """FX scenarios and diagnostics, from memory or an earlier run's file."""
        if self.fx_analysis is None:
            path = self.config.paths.data_processed / "fx_analysis.json"
            if path.is_file():
                self.fx_analysis = json.loads(path.read_text(encoding="utf-8"))
        return self.fx_analysis

    def load_cached_predictions(self) -> None:
        """Populate holdout/backtest/forecasts from disk if not already in memory.

        Lets late stages run standalone against an earlier run's output.
        """
        processed = self.config.paths.data_processed
        dates = ["target_month", "origin_month"]
        for attr, filename in (
            ("holdout", "holdout_predictions.csv"),
            ("backtest", "backtest_predictions.csv"),
            ("forecasts", "forecasts.csv"),
        ):
            if getattr(self, attr) is None and (processed / filename).is_file():
                setattr(
                    self,
                    attr,
                    pd.read_csv(processed / filename, parse_dates=dates),
                )

    def require_validation(self) -> Dict[str, object]:
        if self.validation is None:
            path = self.config.paths.data_processed / "validation.json"
            if path.is_file():
                self.validation = json.loads(path.read_text(encoding="utf-8"))
            else:
                self.validation = run_validation(self.config, self.require_macro())
        return self.validation

    # -- lazy loaders so each stage can run standalone ---------------------- #

    def require_macro(self) -> MacroSeries:
        if self.macro is None:
            self.macro = load_macro_anchor(self.config)
        return self.macro

    def require_fx(self) -> Dict[str, FxSeries]:
        """Real FX rates covering the same window as the macro anchor."""
        if self.fx is None:
            self.fx = load_fx_series(self.config, self.require_macro().values.index)
        return self.fx

    def require_panel(self) -> pd.DataFrame:
        if self.panel is None:
            self.panel = load_panel(self.config)
        return self.panel

    def require_features(self) -> pd.DataFrame:
        if self.features is None:
            stage_preprocess(self)
        assert self.features is not None
        return self.features


# --------------------------------------------------------------------------- #
# Stages
# --------------------------------------------------------------------------- #


def stage_source(state: PipelineState) -> None:
    """Fetch both real anchors - the BLS price index and ECB FX rates."""
    logger.info("=== STAGE: source ===")
    macro = state.require_macro()
    write_dataset_audit(state.config, macro)
    if not macro.is_real:
        logger.warning(
            "proceeding on the offline fallback curve; results are not grounded "
            "in real price data"
        )

    fx = state.require_fx()
    provenance = fx_provenance(fx)
    if not provenance["allReal"]:
        logger.warning(
            "at least one FX pair fell back to a synthetic path; FX-driven "
            "results in this run are not grounded in real rates"
        )


def stage_generate(state: PipelineState) -> None:
    """Generate and persist the hierarchical price panel."""
    logger.info("=== STAGE: generate ===")
    macro = state.require_macro()
    fx = state.require_fx()
    state.panel = generate_price_panel(state.config, macro, fx)
    save_panel(state.config, state.panel)


def stage_preprocess(state: PipelineState) -> None:
    """Clean the panel and engineer leak-free hierarchy and FX features."""
    logger.info("=== STAGE: preprocess ===")
    macro = state.require_macro()
    fx = state.require_fx()
    panel = state.require_panel()

    state.prep_report = PreprocessingReport()
    state.clean = clean_panel(panel, state.config, state.prep_report)
    state.features = build_features(
        state.clean, state.config, macro, state.prep_report, fx=fx
    )
    save_features(state.config, state.features)


def stage_evaluate(state: PipelineState) -> None:
    """Run holdout evaluation and the rolling-origin backtest."""
    logger.info("=== STAGE: evaluate ===")
    features = state.require_features()
    assert state.clean is not None

    state.holdout = evaluate_holdout(features, state.clean, state.config)
    state.backtest = rolling_origin_backtest(features, state.clean, state.config)

    out_dir = state.config.paths.data_processed
    state.holdout.to_csv(out_dir / "holdout_predictions.csv", index=False)
    state.backtest.to_csv(out_dir / "backtest_predictions.csv", index=False)
    logger.info("wrote holdout and backtest predictions to %s", out_dir)


def stage_forecast(state: PipelineState) -> None:
    """Refit on all data and produce forward forecasts with intervals."""
    logger.info("=== STAGE: forecast ===")
    features = state.require_features()
    assert state.clean is not None

    if state.backtest is None:
        backtest_path = state.config.paths.data_processed / "backtest_predictions.csv"
        if backtest_path.is_file():
            state.backtest = pd.read_csv(
                backtest_path, parse_dates=["target_month", "origin_month"]
            )
        else:
            logger.warning(
                "no backtest available; XGBoost intervals will use defaults. "
                "Run the 'evaluate' stage first for calibrated bands."
            )

    intervals = (
        empirical_prediction_intervals(state.backtest, state.config)
        if state.backtest is not None
        else {}
    )
    state.forecasts = generate_forward_forecasts(
        features, state.clean, state.config, intervals
    )
    save_forecasts(state.config, state.forecasts)


def stage_fxscenario(state: PipelineState) -> None:
    """Shock FX, re-predict, and roll the response up the hierarchy.

    Also checks whether the model actually learned FX transmission, by
    correlating its revealed category exposure against the generator's true
    betas. A model that ignored FX would show a flat response and fail here.
    """
    logger.info("=== STAGE: fxscenario ===")
    config = state.config
    features = state.require_features()
    assert state.clean is not None

    origin = features["month"].max()
    horizons = list(range(1, config.modeling.forecast_horizon + 1))
    model = train_global_xgboost(features, config, origin, horizons)

    state.fx_scenarios = run_fx_scenarios(
        config, model, features, horizon=config.modeling.forecast_horizon
    )
    state.fx_learning = validate_fx_learning(state.clean, state.fx_scenarios)

    state.load_cached_predictions()
    if state.forecasts is not None:
        state.rollups = hierarchy_rollup(state.clean, state.forecasts)

    fx = state.require_fx()
    usd = next((s for s in fx.values() if s.pair.startswith("USD")), None)
    fx_move = (
        float(np.log(usd.values.iloc[-1] / usd.values.iloc[0])) if usd is not None else 0.15
    )

    payload = {
        "scenarios": state.fx_scenarios,
        "learning": state.fx_learning,
        "signalToNoise": fx_signal_to_noise(state.clean, config, fx_move),
        "collinearity": fx_trend_collinearity(fx),
        "rollups": state.rollups or {},
        "trueExposure": exposure_summary(),
        "provenance": fx_provenance(fx),
    }
    payload["available"] = bool(state.fx_scenarios)
    state.fx_analysis = payload

    out_path = config.paths.data_processed / "fx_analysis.json"
    out_path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    logger.info("wrote FX scenario analysis to %s", out_path)


def stage_futuretest(state: PipelineState) -> None:
    """Forecast N months blind, then reveal them and score per horizon.

    Answers "how wrong will the next six months be, month by month?" Also runs
    both XGBoost target formulations so the extrapolation fix is evidenced
    rather than asserted.
    """
    logger.info("=== STAGE: futuretest ===")
    macro = state.require_macro()

    fx = state.require_fx()
    payload = run_future_test(state.config, macro, fx=fx)
    payload["targetModeComparison"] = compare_target_modes(state.config, macro, fx=fx)
    state.future_test = payload

    out_path = state.config.paths.data_processed / "future_test.json"
    out_path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    logger.info("wrote simulated-future results to %s", out_path)

    comparison = payload["targetModeComparison"]
    if comparison.get("improvementPct"):
        logger.info(
            "extrapolation fix confirmed: predicting log-returns cut MAPE by "
            "%.1f%% versus predicting price levels (trees cannot extrapolate "
            "beyond their training target range)",
            comparison["improvementPct"],
        )


def stage_validate(state: PipelineState) -> None:
    """Validate against real published BLS data and update the forecast ledger.

    The only stage that makes a claim about real-world accuracy. Everything else
    is measured against the synthetic panel.
    """
    logger.info("=== STAGE: validate ===")
    macro = state.require_macro()
    state.validation = run_validation(state.config, macro)

    out_path = state.config.paths.data_processed / "validation.json"
    out_path.write_text(json.dumps(state.validation, indent=2, default=str), encoding="utf-8")
    logger.info("wrote real-data validation results to %s", out_path)

    backtests = state.validation.get("backtests") or []
    if backtests:
        best = min(backtests, key=lambda b: b["mape"])
        if best["model"] == "naive":
            logger.warning(
                "HEADLINE: on real BLS data no model beat the naive baseline "
                "(%.3f%% MAPE). The real index behaves like a random walk at "
                "this horizon - reported as-is rather than hidden.",
                best["mape"],
            )


def stage_export(state: PipelineState) -> None:
    """Serialise everything the React dashboard needs into dashboard.json."""
    logger.info("=== STAGE: export ===")
    config = state.config
    macro = state.require_macro()
    state.require_features()
    assert state.clean is not None

    state.load_cached_predictions()
    if state.holdout is None or state.forecasts is None:
        raise RuntimeError(
            "export needs holdout predictions and forecasts; run "
            "--stage evaluate and --stage forecast first"
        )

    payload = build_dashboard_payload(
        config=config,
        macro=macro,
        panel=state.clean,
        holdout=state.holdout,
        backtest=state.backtest,
        forecasts=state.forecasts,
        validation=state.require_validation(),
        versions=state.versions or {},
        future_test=state.require_future_test(),
        fx_analysis=state.require_fx_analysis(),
        feature_columns=state.prep_report.feature_columns,
    )
    export_dashboard(config, payload)


def stage_report(state: PipelineState) -> None:
    """Render figures and the markdown summary report."""
    logger.info("=== STAGE: report ===")
    config = state.config
    macro = state.require_macro()
    # Populates state.clean as a side effect, so this stage can run standalone
    # against cached predictions from an earlier run.
    state.require_features()
    assert state.clean is not None

    holdout = state.holdout
    backtest = state.backtest
    forecasts = state.forecasts

    processed = config.paths.data_processed
    if holdout is None and (processed / "holdout_predictions.csv").is_file():
        holdout = pd.read_csv(
            processed / "holdout_predictions.csv", parse_dates=["target_month", "origin_month"]
        )
    if backtest is None and (processed / "backtest_predictions.csv").is_file():
        backtest = pd.read_csv(
            processed / "backtest_predictions.csv", parse_dates=["target_month", "origin_month"]
        )
    if forecasts is None and (processed / "forecasts.csv").is_file():
        forecasts = pd.read_csv(
            processed / "forecasts.csv", parse_dates=["target_month", "origin_month"]
        )

    if holdout is None or forecasts is None:
        raise RuntimeError(
            "report stage needs holdout predictions and forecasts; "
            "run --stage evaluate and --stage forecast first"
        )

    comparison = compare_on_common_parts(holdout)
    by_split = metrics_by(holdout, ["model", "split"])
    by_horizon = metrics_by(holdout[holdout["split"] == "test"], ["model", "horizon"])

    anomaly_metrics = metrics_by(
        holdout[holdout["model"].isin(("xgboost", "sarima", "seasonal_naive"))],
        ["model", "is_anomaly_part"],
    )

    backtest_metrics = (
        metrics_by(backtest, ["model", "fold"]) if backtest is not None else pd.DataFrame()
    )
    backtest_summary = pd.DataFrame()
    if not backtest_metrics.empty:
        backtest_summary = (
            backtest_metrics.groupby("model")[["mae", "rmse", "mape"]]
            .agg(["mean", "std"])
            .round(3)
        )
        backtest_summary.columns = [
            f"{metric}_{stat}" for metric, stat in backtest_summary.columns
        ]
        backtest_summary = backtest_summary.reset_index()

    coverage = coverage_report(holdout, config)

    if "fallback_level" in holdout.columns:
        ladder = (
            holdout[holdout["model"] == "sarima"]
            .groupby("fallback_level")["part_id"]
            .nunique()
        )
    else:
        ladder = pd.Series(dtype=int, name="parts")

    figures = generate_all_figures(
        config,
        state.clean,
        holdout,
        backtest_metrics,
        comparison,
        forecasts,
        macro,
    )

    render_report(
        config=config,
        macro=macro,
        panel=state.clean,
        prep_report=state.prep_report,
        comparison=comparison,
        holdout_by_split=by_split,
        holdout_by_horizon=by_horizon,
        anomaly_metrics=anomaly_metrics,
        backtest_metrics=backtest_metrics,
        backtest_summary=backtest_summary,
        coverage=coverage,
        sarima_ladder=ladder,
        forecasts=forecasts,
        figures=figures,
        versions=state.versions,
    )


STAGE_FUNCTIONS = {
    "source": stage_source,
    "generate": stage_generate,
    "preprocess": stage_preprocess,
    "evaluate": stage_evaluate,
    "forecast": stage_forecast,
    "fxscenario": stage_fxscenario,
    "futuretest": stage_futuretest,
    "validate": stage_validate,
    "report": stage_report,
    "export": stage_export,
}


def run_pipeline(config: Config, stage: str) -> None:
    """Execute one stage, or every stage in order when ``stage == 'all'``."""
    config.paths.ensure()
    state = PipelineState(config)
    state.versions = log_run_banner(logger, config.project.random_seed)

    np.random.seed(config.project.random_seed)

    stages: List[str] = (
        list(STAGE_FUNCTIONS) if stage == "all" else [stage]
    )

    started = time.time()
    for name in stages:
        stage_started = time.time()
        STAGE_FUNCTIONS[name](state)
        logger.info("stage '%s' finished in %.1fs", name, time.time() - stage_started)

    logger.info("=" * 78)
    logger.info("pipeline complete in %.1fs", time.time() - started)
    logger.info("report:    %s", config.paths.reports / "report.md")
    logger.info("figures:   %s", config.paths.figures)
    logger.info("forecasts: %s", config.paths.data_processed / "forecasts.csv")
    logger.info("=" * 78)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="price_forecasting.pipeline",
        description="Automotive spare parts monthly price forecasting pipeline.",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("config.yaml"),
        help="Path to config.yaml (default: ./config.yaml)",
    )
    parser.add_argument(
        "--stage",
        choices=STAGES,
        default="all",
        help="Pipeline stage to run (default: all)",
    )
    parser.add_argument(
        "--log-level",
        default=None,
        help="Override the log level from config (e.g. DEBUG, WARNING)",
    )
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        config = load_config(args.config)
    except ConfigError as exc:
        # Configure minimal logging first - the config that would have told us
        # how to log is the thing that failed.
        configure_logging()
        logger.error("configuration error: %s", exc)
        return 2

    configure_logging(
        level=args.log_level or config.logging.level,
        fmt=config.logging.format,
        datefmt=config.logging.datefmt,
    )

    try:
        run_pipeline(config, args.stage)
    except KeyboardInterrupt:
        logger.warning("interrupted by user")
        return 130
    except Exception as exc:  # top-level guard so failures are legible
        logger.exception("pipeline failed: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
