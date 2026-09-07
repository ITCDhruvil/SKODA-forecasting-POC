"""Lightweight drift checks between monthly retrain cycles."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from .config import Config
from .logging_utils import get_logger

logger = get_logger(__name__)

DRIFT_FILENAME = "drift_report.json"
METRICS_FILENAME = "ops_metrics.json"


def _psi(expected: np.ndarray, actual: np.ndarray, bins: int = 10) -> float:
    """Population stability index between two 1-d samples."""
    expected = expected[np.isfinite(expected)]
    actual = actual[np.isfinite(actual)]
    if len(expected) < 20 or len(actual) < 20:
        return 0.0
    qs = np.linspace(0, 100, bins + 1)
    cuts = np.unique(np.percentile(expected, qs))
    if len(cuts) < 3:
        return 0.0
    exp_counts = np.histogram(expected, bins=cuts)[0].astype(float)
    act_counts = np.histogram(actual, bins=cuts)[0].astype(float)
    exp_pct = np.clip(exp_counts / max(exp_counts.sum(), 1.0), 1e-4, None)
    act_pct = np.clip(act_counts / max(act_counts.sum(), 1.0), 1e-4, None)
    return float(np.sum((act_pct - exp_pct) * np.log(act_pct / exp_pct)))


def ops_metrics_path(config: Config) -> Path:
    return config.paths.data_processed / METRICS_FILENAME


def load_ops_metrics(config: Config) -> Optional[Dict[str, object]]:
    path = ops_metrics_path(config)
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_ops_metrics(config: Config, payload: Dict[str, object]) -> Path:
    config.paths.data_processed.mkdir(parents=True, exist_ok=True)
    path = ops_metrics_path(config)
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    return path


def compute_drift(
    features: pd.DataFrame,
    selected_columns: Sequence[str],
    config: Config,
    *,
    current_mape: Optional[float] = None,
) -> Dict[str, object]:
    """Compare recent vs prior window on selected features + MAPE change."""
    prior = load_ops_metrics(config)
    months = pd.DatetimeIndex(sorted(features["month"].unique()))
    if len(months) < 6:
        recent = months
        baseline = months
    else:
        recent = months[-3:]
        baseline = months[-6:-3]

    recent_rows = features[features["month"].isin(recent)]
    base_rows = features[features["month"].isin(baseline)]

    numeric_cols = [
        c
        for c in selected_columns
        if c in features.columns and pd.api.types.is_numeric_dtype(features[c])
    ]

    feature_psi: List[Dict[str, object]] = []
    max_psi = 0.0
    for col in numeric_cols[:40]:
        psi = _psi(
            base_rows[col].to_numpy(dtype=float),
            recent_rows[col].to_numpy(dtype=float),
        )
        max_psi = max(max_psi, psi)
        feature_psi.append({"feature": col, "psi": round(psi, 4)})

    feature_psi.sort(key=lambda r: float(r["psi"]), reverse=True)

    prior_mape = None
    if prior and prior.get("holdoutMape") is not None:
        prior_mape = float(prior["holdoutMape"])

    mape_delta = None
    mape_alert = False
    if current_mape is not None and prior_mape is not None:
        mape_delta = round(float(current_mape) - prior_mape, 4)
        mape_alert = mape_delta >= config.ops.mape_drift_alert_pp

    psi_alert = max_psi >= config.ops.psi_alert_threshold
    alert = bool(mape_alert or psi_alert)

    report = {
        "asOf": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "alert": alert,
        "mapeAlert": mape_alert,
        "psiAlert": psi_alert,
        "currentMape": current_mape,
        "priorMape": prior_mape,
        "mapeDeltaPp": mape_delta,
        "maxPsi": round(max_psi, 4),
        "psiThreshold": config.ops.psi_alert_threshold,
        "mapeDriftAlertPp": config.ops.mape_drift_alert_pp,
        "baselineMonths": [m.strftime("%Y-%m") for m in baseline],
        "recentMonths": [m.strftime("%Y-%m") for m in recent],
        "topPsi": feature_psi[:10],
        "summary": (
            "Drift alert: "
            + ", ".join(
                [
                    s
                    for s, flag in (
                        (f"MAPE +{mape_delta} pp", mape_alert),
                        (f"max PSI {max_psi:.2f}", psi_alert),
                    )
                    if flag
                ]
            )
            if alert
            else "No drift alert vs prior retrain window."
        ),
    }

    out = config.paths.data_processed / DRIFT_FILENAME
    out.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    logger.info("drift report: alert=%s maxPsi=%.3f mapeDelta=%s", alert, max_psi, mape_delta)
    return report
