"""End-to-end evaluation report for the geo-aware price forecasting POC.

Focus: identification, mechanism, calibration, and trustworthiness — not MAPE alone.
Writes data/processed/evaluation_report.json for the evaluation canvas.
"""

from __future__ import annotations

import dataclasses
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from price_forecasting.config import load_config
from price_forecasting.data_generation import generate_price_panel
from price_forecasting.data_sourcing import load_macro_anchor
from price_forecasting.evaluation import (
    compare_on_common_parts,
    coverage_report,
    empirical_prediction_intervals,
    evaluate_holdout,
    metrics_by,
    rolling_origin_backtest,
)
from price_forecasting.forecasting import generate_forward_forecasts
from price_forecasting.future_test import compare_target_modes, run_future_test
from price_forecasting.fx import fx_provenance, load_fx_series
from price_forecasting.fx_scenario import (
    fx_signal_to_noise,
    fx_trend_collinearity,
    run_fx_scenarios,
    validate_fx_learning,
)
from price_forecasting.geo_nlp import maybe_enrich_from_disk
from price_forecasting.geo_scenario import (
    event_study,
    geo_signal_to_noise,
    geo_trend_collinearity,
    mediation_diagnostics,
    run_geo_scenarios,
)
from price_forecasting.geopolitical import geo_provenance, load_geo_bundle
from price_forecasting.modeling import train_global_xgboost
from price_forecasting.preprocessing import PreprocessingReport, build_features, clean_panel, get_feature_columns
from price_forecasting.validation import run_validation


def _round(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _round(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_round(v) for v in obj]
    if isinstance(obj, (np.floating, float)):
        if np.isnan(obj) or np.isinf(obj):
            return None
        return round(float(obj), 4)
    if isinstance(obj, (np.integer, int)):
        return int(obj)
    return obj


# Geo feature arms compared head to head. "full" pins the wide lag ladder the
# first evaluation ran on, so the pruning result stays comparable to the
# recorded 108-feature baseline even though config.yaml has since narrowed the
# default lags.
GEO_ARMS: Dict[str, Optional[Dict[str, object]]] = {
    "none": None,
    "sparse": {"feature_mode": "sparse"},
    "full": {
        "feature_mode": "full",
        "mediator_lags": [1, 2, 3, 4, 6],
        "mediator_return_periods": [1, 3, 6],
        "gpr_lags": [0, 1, 2, 3],
    },
}


def _xgb_test_mape(holdout: pd.DataFrame) -> Optional[float]:
    from price_forecasting.evaluation import mean_absolute_percentage_error

    sub = holdout[(holdout["model"] == "xgboost") & (holdout["split"] == "test")]
    if sub.empty:
        return None
    return float(
        mean_absolute_percentage_error(
            sub["actual"].to_numpy(), sub["prediction"].to_numpy()
        )
    )


def _run_geo_arm(
    arm: str,
    overrides: Optional[Dict[str, object]],
    config,
    macro,
    fx,
    geo,
    panel_clean,
) -> Dict[str, object]:
    """Holdout accuracy and shock-ranking fidelity for one geo feature set.

    Every arm sees the same panel and the same splits, so the only thing that
    varies is which geo columns reach the model.
    """
    scoped = config
    if overrides is not None:
        scoped = dataclasses.replace(
            config, geo=dataclasses.replace(config.geo, **overrides)
        )

    report = PreprocessingReport()
    features = build_features(
        panel_clean,
        scoped,
        macro,
        report,
        fx=fx,
        geo=geo if overrides is not None else None,
    )
    holdout = evaluate_holdout(features, panel_clean, scoped, fit_sarima=False)

    result: Dict[str, object] = {
        "arm": arm,
        "nGeoFeatures": len(report.geo_features),
        "nFeatures": len(get_feature_columns(features)),
        "xgboostTestMape": _round(_xgb_test_mape(holdout)),
    }

    # The no-geo arm has nothing to shock, so shock-ranking only applies to the
    # two geo arms.
    if overrides is not None:
        origin = features["month"].max()
        horizons = list(range(1, scoped.modeling.forecast_horizon + 1))
        model = train_global_xgboost(features, scoped, origin, horizons)
        scenarios = run_geo_scenarios(
            scoped, model, features, horizon=scoped.modeling.forecast_horizon
        )
        result["freightBetaRecovery"] = _beta_recovery(panel_clean, scenarios)

    return result


def _ablation_geo(config, macro, fx, geo, panel_clean) -> Dict[str, object]:
    """Compare no-geo / sparse / full geo feature sets on one panel."""
    arms = {
        name: _run_geo_arm(name, overrides, config, macro, fx, geo, panel_clean)
        for name, overrides in GEO_ARMS.items()
    }

    baseline = arms["none"]["xgboostTestMape"]

    def lift_over_baseline(arm: str) -> Optional[float]:
        mape = arms[arm]["xgboostTestMape"]
        if mape is None or not baseline:
            return None
        return _round((baseline - mape) / baseline * 100.0)

    lifts = {arm: lift_over_baseline(arm) for arm in ("sparse", "full")}
    best = max(
        (a for a in ("sparse", "full") if lifts[a] is not None),
        key=lambda a: lifts[a],
        default=None,
    )

    return {
        "arms": arms,
        "xgboostTestMapeWithoutGeo": baseline,
        "relativeLiftPct": lifts.get("sparse"),
        "liftPctByArm": lifts,
        "bestArm": best,
        "prunedFeatureReduction": (
            arms["full"]["nGeoFeatures"] - arms["sparse"]["nGeoFeatures"]
        ),
        "interpretation": (
            "Positive lift means geo features improved holdout MAPE against the "
            "same panel without them. 'full' is the wide lag ladder; 'sparse' "
            "keeps only mediators plus exposure interactions. Compare the "
            "freight shock ranking alongside the MAPE — a feature set can score "
            "well on accuracy and still rank exposure wrongly."
        ),
    }


def _beta_recovery(panel: pd.DataFrame, geo_scenarios: List[Dict]) -> Dict[str, object]:
    """Do freight/duty shocks hit high-exposure parts harder?"""
    freight = next(
        (s for s in geo_scenarios if s.get("family") == "freight" and s.get("shockPct", 0) > 0),
        None,
    )
    if not freight or "category" not in freight.get("byLevel", {}):
        return {"available": False}

    rows = freight["byLevel"]["category"]
    # True freight beta by category from panel
    truth = (
        panel.groupby("category")["true_freight_beta"]
        .mean()
        .rename("trueFreightBeta")
        .reset_index()
    )
    modelled = pd.DataFrame(rows).rename(columns={"name": "category", "priceChangePct": "modelledPct"})
    merged = truth.merge(modelled, on="category", how="inner")
    if len(merged) < 4:
        return {"available": False}

    spearman = float(merged["trueFreightBeta"].corr(merged["modelledPct"], method="spearman"))
    return {
        "available": True,
        "shockFamily": "freight",
        "shockPct": freight["shockPct"],
        "spearman": round(spearman, 4),
        "verdict": (
            "recovered" if spearman >= 0.6 else "partial" if spearman >= 0.3 else "not recovered"
        ),
        "rows": [
            {
                "category": r.category,
                "trueFreightBeta": round(float(r.trueFreightBeta), 4),
                "modelledPct": round(float(r.modelledPct), 4),
            }
            for r in merged.itertuples()
        ],
    }


def _horizon_bias(holdout: pd.DataFrame) -> List[Dict[str, object]]:
    sub = holdout[(holdout["model"] == "xgboost") & (holdout["split"] == "test")].copy()
    if sub.empty or "horizon" not in sub.columns:
        return []
    sub["signed_pct"] = (sub["prediction"] - sub["actual"]) / sub["actual"] * 100
    out = []
    for h, g in sub.groupby("horizon"):
        out.append(
            {
                "horizon": int(h),
                "mape": round(float((g["signed_pct"].abs()).mean()), 4),
                "meanSignedPct": round(float(g["signed_pct"].mean()), 4),
                "n": int(len(g)),
            }
        )
    return sorted(out, key=lambda r: r["horizon"])


def _verdicts(report: Dict[str, Any]) -> List[Dict[str, str]]:
    """Executive verdicts across evaluation axes."""
    verdicts = []

    real = report.get("realBlsValidation") or {}
    backtests = real.get("backtests") or []
    if backtests:
        best = min(backtests, key=lambda b: b["mape"])
        verdicts.append(
            {
                "axis": "Real-world accuracy (BLS)",
                "verdict": "fail" if best["model"] == "naive" else "pass",
                "summary": (
                    f"Best model on real BLS is {best['model']} at {best['mape']:.3f}% MAPE. "
                    + (
                        "No fitted model beats naive — treat synthetic accuracy as process recovery, not production claim."
                        if best["model"] == "naive"
                        else "Fitted model beats naive on the published index."
                    )
                ),
            }
        )

    ft = report.get("futureTest") or {}
    scores = ft.get("scores") or []
    xgb = next((s for s in scores if s["model"] == "xgboost"), None)
    naive = next((s for s in scores if s["model"] == "seasonal_naive"), None)
    if xgb and naive:
        beat = xgb["mape"] < naive["mape"]
        nf = ft.get("noiseFloor") or {}
        eff = None
        if nf.get("byHorizon"):
            eff = float(np.mean([h["efficiencyPct"] for h in nf["byHorizon"]]))
        verdicts.append(
            {
                "axis": "Synthetic forecast recovery",
                "verdict": "pass" if beat else "weak",
                "summary": (
                    f"XGBoost MAPE {xgb['mape']:.2f}% vs seasonal naive {naive['mape']:.2f}%"
                    + (f"; mean efficiency vs noise floor ~{eff:.0f}%." if eff else ".")
                ),
            }
        )

    fx = report.get("fxIdentification") or {}
    snr = fx.get("signalToNoise") or {}
    col = fx.get("collinearity") or {}
    learn = fx.get("learning") or {}
    if snr.get("available"):
        verdicts.append(
            {
                "axis": "FX detectability vs attribution",
                "verdict": (
                    "mixed"
                    if snr.get("identifiable") and not col.get("separable")
                    else "pass"
                    if snr.get("identifiable") and col.get("separable")
                    else "fail"
                ),
                "summary": (
                    f"SNR={snr.get('snr')} (detectable={snr.get('identifiable')}); "
                    f"trend collinearity separable={col.get('separable')}; "
                    f"beta recovery={learn.get('verdict')} (Spearman {learn.get('spearman')})."
                ),
            }
        )

    med = report.get("geoMechanism", {}).get("mediation") or {}
    if med.get("available"):
        total = abs(med.get("totalCorrGprPrice") or 0)
        partial = abs(med.get("partialCorrGprPriceGivenMediators") or 0)
        shrinks = partial < total * 0.85
        verdicts.append(
            {
                "axis": "Geo mediation (channel story)",
                "verdict": "pass" if shrinks else "weak",
                "summary": (
                    f"GPR-price |corr| {total:.3f} -> partial {partial:.3f} after mediators. "
                    + (
                        "Shrinkage supports the channel model."
                        if shrinks
                        else "Little shrinkage — residual direct/confounded geo link remains."
                    )
                ),
            }
        )

    abl = report.get("geoAblation") or {}
    arms = abl.get("arms") or {}
    lifts = abl.get("liftPctByArm") or {}
    if lifts.get("sparse") is not None:
        sparse_lift = lifts["sparse"]
        full_lift = lifts.get("full")
        base = abl.get("xgboostTestMapeWithoutGeo")
        sparse_mape = (arms.get("sparse") or {}).get("xgboostTestMape")
        detail = (
            f" Wide lag ladder ({(arms.get('full') or {}).get('nGeoFeatures')} features) "
            f"scored {full_lift:+.2f}%."
            if full_lift is not None
            else ""
        )
        verdicts.append(
            {
                "axis": "Geo feature holdout lift",
                "verdict": (
                    "pass" if sparse_lift > 1 else "weak" if sparse_lift > -1 else "fail"
                ),
                "summary": (
                    f"Sparse geo ({(arms.get('sparse') or {}).get('nGeoFeatures')} features) "
                    f"vs no-geo XGB test MAPE lift {sparse_lift:+.2f}% "
                    f"({base}% -> {sparse_mape}%).{detail}"
                ),
            }
        )

    cov = report.get("calibration") or {}
    if cov.get("empiricalCoverage") is not None:
        nom = cov.get("nominalCoverage", 0.8)
        emp = cov["empiricalCoverage"]
        ok = abs(emp - nom) <= 0.15
        verdicts.append(
            {
                "axis": "Prediction interval calibration",
                "verdict": "pass" if ok else "fail",
                "summary": (
                    f"Empirical coverage {emp:.1%} vs nominal {nom:.0%}. "
                    + ("Acceptable." if ok else "Mis-calibrated — do not treat bands as probabilities.")
                ),
            }
        )

    freight = report.get("geoMechanism", {}).get("freightBetaRecovery") or {}
    if freight.get("available"):
        full_freight = (arms.get("full") or {}).get("freightBetaRecovery") or {}
        contrast = (
            f" Wide lag ladder scored {full_freight.get('spearman')}."
            if full_freight.get("available")
            else ""
        )
        # Distinguish "the model failed" from "this panel could never show it".
        # Grade as not-identifiable only when a data-side explanation actually
        # holds, so the two obvious excuses have to be ruled out first.
        mech = report.get("geoMechanism", {})
        snr_report = mech.get("signalToNoise") or {}
        channel = (snr_report.get("channels") or {}).get("freight") or {}
        collinear = mech.get("collinearity") or {}
        freight_trend = next(
            (
                row
                for row in collinear.get("mediators", [])
                if row.get("mediator") == "freight"
            ),
            {},
        )
        trend_corr = abs(float(freight_trend.get("cumulativeVsTime") or 0.0))

        below_floor = channel.get("identifiable") is False
        trend_confounded = trend_corr >= 0.7

        if freight["verdict"] == "recovered":
            grade = "pass"
        elif freight["verdict"] == "partial":
            grade = "weak"
        elif below_floor or trend_confounded:
            grade = "not-identifiable"
        else:
            grade = "fail"

        if below_floor:
            cause = (
                f" Freight signal is below the noise floor (SNR {channel.get('snr')}), "
                "so no feature set could recover this ranking here."
            )
        elif trend_confounded:
            cause = (
                f" The freight path correlates {trend_corr:.2f} with elapsed time, "
                "so freight and trend are not separable on this window."
            )
        else:
            cause = (
                f" Not a detectability limit: freight SNR is {channel.get('snr')} "
                f"and the freight path correlates only {trend_corr:.2f} with time. "
                "The signal is present and separable, so the shortfall is in how "
                "the model represents the channel, not in the data."
            )

        verdicts.append(
            {
                "axis": "Freight shock ranking vs true exposure",
                "verdict": grade,
                "summary": (
                    f"Spearman {freight['spearman']} ({freight['verdict']}) between "
                    "true freight betas and modelled category response to freight "
                    f"shock.{contrast}{cause}"
                ),
            }
        )

    return verdicts


def main() -> int:
    started = time.time()
    config = load_config(ROOT / "config.yaml")
    # Eval-sized panel: enough hierarchy coverage, faster than full 480 POC run
    config = dataclasses.replace(
        config,
        generation=dataclasses.replace(
            config.generation, n_parts=180, n_anomaly_parts=4
        ),
        modeling=dataclasses.replace(
            config.modeling,
            sarima=dataclasses.replace(config.modeling.sarima, max_parts=20),
        ),
    )
    config.paths.ensure()
    maybe_enrich_from_disk(config)

    print("=== 1. Real anchors ===")
    macro = load_macro_anchor(config)
    fx = load_fx_series(config, macro.values.index)
    geo = load_geo_bundle(config, macro.values.index)
    fx_prov = fx_provenance(fx)
    geo_prov = geo_provenance(geo)

    print("=== 2. Panel + features ===")
    panel = generate_price_panel(config, macro, fx, geo=geo)
    report = PreprocessingReport()
    clean = clean_panel(panel, config, report)
    features = build_features(clean, config, macro, report, fx=fx, geo=geo)

    print("=== 3. Holdout / backtest / forecasts ===")
    holdout = evaluate_holdout(features, clean, config)
    backtest = rolling_origin_backtest(features, clean, config)
    comparison = compare_on_common_parts(holdout)
    coverage = coverage_report(holdout, config)
    intervals = empirical_prediction_intervals(backtest, config)
    forecasts = generate_forward_forecasts(features, clean, config, intervals)
    horizon_bias = _horizon_bias(holdout)

    print("=== 4. Real BLS validation ===")
    real_val = run_validation(config, macro)

    print("=== 5. Future test + target-mode ===")
    future = run_future_test(config, macro, fx=fx, geo=geo)
    # Skip full dual-mode compare (2x cost); use stored comparison shape lightly
    future["targetModeComparison"] = {
        "note": "Skipped dual re-run in eval script for runtime; primary mode is log_return",
        "primaryMode": config.modeling.xgboost_target_mode,
    }

    print("=== 6. FX identification ===")
    origin = features["month"].max()
    horizons = list(range(1, config.modeling.forecast_horizon + 1))
    model = train_global_xgboost(features, config, origin, horizons)
    fx_scenarios = run_fx_scenarios(
        config, model, features, horizon=config.modeling.forecast_horizon
    )
    fx_learning = validate_fx_learning(clean, fx_scenarios)
    usd = next((s for s in fx.values() if s.pair.startswith("USD")), None)
    fx_move = (
        float(np.log(usd.values.iloc[-1] / usd.values.iloc[0])) if usd is not None else 0.15
    )
    fx_id = {
        "scenarios": fx_scenarios,
        "learning": fx_learning,
        "signalToNoise": fx_signal_to_noise(clean, config, fx_move),
        "collinearity": fx_trend_collinearity(fx),
        "provenance": fx_prov,
    }

    print("=== 7. Geo mechanism ===")
    geo_scenarios = run_geo_scenarios(
        config, model, features, horizon=config.modeling.forecast_horizon
    )
    mediation = mediation_diagnostics(features, clean)
    studies = event_study(clean, geo.events, window=6)
    freight_recovery = _beta_recovery(clean, geo_scenarios)
    geo_mech = {
        "scenarios": geo_scenarios,
        "mediation": mediation,
        "eventStudies": studies,
        "freightBetaRecovery": freight_recovery,
        "signalToNoise": geo_signal_to_noise(clean, config, geo),
        "collinearity": geo_trend_collinearity(geo),
        "provenance": geo_prov,
    }

    print("=== 8. Geo ablation ===")
    ablation = _ablation_geo(config, macro, fx, geo, clean)

    # Calibration extract
    calib = {}
    if isinstance(coverage, dict):
        calib = {
            "nominalCoverage": config.evaluation.prediction_interval,
            "empiricalCoverage": coverage.get("coverage") or coverage.get("empirical_coverage"),
            "raw": _round(coverage),
        }
    elif hasattr(coverage, "to_dict"):
        raw = coverage.to_dict() if hasattr(coverage, "to_dict") else {}
        calib = {"raw": _round(raw)}

    # Model comparison table
    model_rows = []
    if not comparison.empty:
        for _, row in comparison.iterrows():
            model_rows.append({k: _round(row[k]) for k in row.index})

    report_out: Dict[str, Any] = {
        "meta": {
            "generatedAt": pd.Timestamp.utcnow().isoformat(),
            "elapsedSec": round(time.time() - started, 1),
            "nParts": int(clean["part_id"].nunique()),
            "nMonths": int(clean["month"].nunique()),
            "historyRange": [
                clean["month"].min().strftime("%Y-%m"),
                clean["month"].max().strftime("%Y-%m"),
            ],
            "nFeatures": len(get_feature_columns(features)),
            "nGeoFeatures": len(report.geo_features),
            "xgboostTargetMode": config.modeling.xgboost_target_mode,
            "dataLayers": {
                "macro": {"series": macro.series_id, "source": macro.source, "isReal": macro.is_real},
                "fx": {"allReal": fx_prov.get("allReal"), "pairs": fx_prov.get("pairs")},
                "geo": {
                    "allReal": geo_prov.get("allReal"),
                    "nEvents": geo_prov.get("nEvents"),
                    "mediators": [
                        {"name": m["name"], "source": m["source"], "isReal": m["isReal"], "movePct": m["totalMovePct"]}
                        for m in geo_prov.get("mediators", [])
                    ],
                },
                "skuLayer": "synthetic",
            },
        },
        "verdicts": [],  # filled below
        "realBlsValidation": _round(real_val),
        "holdoutComparison": model_rows,
        "horizonBias": horizon_bias,
        "calibration": calib,
        "futureTest": {
            "available": True,
            "scores": future.get("scores"),
            "noiseFloor": future.get("noiseFloor"),
            "futureMonths": future.get("futureMonths"),
            "trainEnd": future.get("trainEnd"),
            "revealedRange": future.get("revealedRange"),
            "disclaimer": future.get("disclaimer"),
        },
        "fxIdentification": _round(fx_id),
        "geoMechanism": _round(geo_mech),
        "geoAblation": ablation,
        "forwardForecastSummary": {
            "nRows": int(len(forecasts)),
            "horizon": config.modeling.forecast_horizon,
            "models": sorted(forecasts["model"].unique().tolist()) if not forecasts.empty else [],
        },
    }
    report_out["verdicts"] = _verdicts(report_out)

    out_path = config.paths.data_processed / "evaluation_report.json"
    out_path.write_text(json.dumps(report_out, indent=2, default=str), encoding="utf-8")
    print(f"wrote {out_path} in {time.time() - started:.1f}s")
    for v in report_out["verdicts"]:
        print(f"  [{v['verdict']}] {v['axis']}: {v['summary'][:100]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
