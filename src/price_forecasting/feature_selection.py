"""Monthly parameter relevance gate: which features affect the forecast?

The catalogue lists every driver. This module scores the engineered feature
matrix and keeps only those that (a) rank in the top-K by XGBoost gain, (b)
hurt holdout MAPE when ablated, or (c) match a configured core prefix. Weekly
scoring reuses the frozen selection; monthly retrain re-runs classification.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from .config import Config
from .logging_utils import get_logger
from .modeling import split_by_time, train_global_xgboost
from .preprocessing import get_feature_columns

logger = get_logger(__name__)

SELECTION_FILENAME = "selected_features.json"


@dataclass
class SelectionReport:
    """Audit trail for one monthly relevance classification."""

    as_of: str
    selected: List[str]
    rejected: List[str]
    scores: Dict[str, Dict[str, object]]
    groups: Dict[str, Dict[str, object]]
    always_kept: List[str]
    baseline_mape: Optional[float] = None
    n_candidates: int = 0
    reason: str = ""

    def as_dict(self) -> Dict[str, object]:
        return {
            "asOf": self.as_of,
            "selected": list(self.selected),
            "rejected": list(self.rejected),
            "scores": self.scores,
            "groups": self.groups,
            "alwaysKept": list(self.always_kept),
            "baselineMape": self.baseline_mape,
            "nCandidates": self.n_candidates,
            "nSelected": len(self.selected),
            "nRejected": len(self.rejected),
            "reason": self.reason,
        }


def selection_path(config: Config) -> Path:
    return config.paths.data_processed / SELECTION_FILENAME


def load_selection(config: Config) -> Optional[Dict[str, object]]:
    path = selection_path(config)
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_selection(config: Config, report: SelectionReport) -> Path:
    config.paths.data_processed.mkdir(parents=True, exist_ok=True)
    path = selection_path(config)
    path.write_text(json.dumps(report.as_dict(), indent=2, default=str), encoding="utf-8")
    logger.info(
        "wrote feature selection (%d selected / %d rejected) to %s",
        len(report.selected),
        len(report.rejected),
        path,
    )
    return path


def feature_group(name: str) -> str:
    """Map a feature column to a driver group for ablation."""
    lower = name.lower()
    if lower.startswith("lag_") or lower.startswith("price_lag"):
        return "price_lags"
    if lower.startswith("fx_"):
        return "fx"
    if lower.startswith("cmd_matched"):
        return "cmd_matched"
    if lower.startswith("cmd_"):
        return "commodities"
    if lower.startswith("freight"):
        return "freight"
    if lower.startswith("gpr"):
        return "gpr"
    if lower.startswith("chokepoint") or lower.startswith("geo_event"):
        return "geo_events"
    if lower.startswith("vendor") or "import" in lower:
        return "vendor_exposure"
    if "local" in lower or lower.startswith("project"):
        return "project"
    if lower.startswith("cat_") or lower.startswith("category"):
        return "category"
    return "other"


def _always_keep(name: str, prefixes: Sequence[str]) -> bool:
    return any(name.startswith(p) for p in prefixes)


def _mape(actual: np.ndarray, pred: np.ndarray) -> float:
    denom = np.clip(np.abs(actual), 1e-9, None)
    return float(np.mean(np.abs(pred - actual) / denom) * 100.0)


def _score_holdout_mape(
    model,
    features: pd.DataFrame,
    train_end: pd.Timestamp,
    horizon: int,
) -> float:
    """MAPE on the month after ``train_end`` using an already-fitted model."""
    if horizon not in model.models:
        return float("nan")

    origin = train_end
    row_mask = features["month"] == origin
    if not row_mask.any():
        return float("nan")

    preds = model.predict(features.loc[row_mask], horizon)
    target_month = origin + pd.DateOffset(months=horizon)
    actuals = features.loc[features["month"] == target_month, ["part_id", "price"]]
    if actuals.empty:
        return float("nan")

    pred_frame = pd.DataFrame(
        {
            "part_id": features.loc[row_mask, "part_id"].to_numpy(),
            "prediction": np.asarray(preds, dtype=float),
        }
    )
    merged = pred_frame.merge(actuals, on="part_id", how="inner")
    if merged.empty:
        return float("nan")
    return _mape(
        merged["price"].to_numpy(dtype=float),
        merged["prediction"].to_numpy(dtype=float),
    )


def _holdout_mape(
    features: pd.DataFrame,
    config: Config,
    feature_columns: Sequence[str],
    train_end: pd.Timestamp,
    horizon: int,
) -> float:
    """MAPE on the month after ``train_end`` for a candidate feature set."""
    model = train_global_xgboost(
        features, config, train_end, [horizon], feature_columns=list(feature_columns)
    )
    return _score_holdout_mape(model, features, train_end, horizon)


def selection_train_end(features: pd.DataFrame, config: Config) -> pd.Timestamp:
    """Inner selection boundary nested strictly inside holdout training history."""
    outer_train_end = split_by_time(features, config)["train_end"]
    months = pd.DatetimeIndex(sorted(features["month"].unique()))
    eligible = months[months <= outer_train_end]
    if len(eligible) == 0:
        raise ValueError("no months available before holdout boundary for feature selection")

    horizon = max(config.modeling.forecast_horizon, 1)
    offset = config.modeling.validation_months + horizon
    if len(eligible) > offset:
        return eligible[-1 - offset]
    return eligible[max(len(eligible) - 2, 0)]


def _gain_importance(model, feature_columns: Sequence[str], horizon: int) -> Dict[str, float]:
    if horizon not in model.models:
        return {c: 0.0 for c in feature_columns}
    booster = model.models[horizon]
    gains = getattr(booster, "feature_importances_", None)
    if gains is None:
        return {c: 0.0 for c in feature_columns}
    return {c: float(g) for c, g in zip(feature_columns, gains)}


def select_features(
    features: pd.DataFrame,
    config: Config,
    *,
    train_end: Optional[pd.Timestamp] = None,
) -> SelectionReport:
    """Classify which engineered features affect next-month predictions."""
    fs = config.ops.feature_selection
    horizon = config.modeling.forecast_horizon
    candidates = get_feature_columns(features)
    if not candidates:
        raise ValueError("no candidate feature columns on the feature frame")

    if train_end is None:
        train_end = selection_train_end(features, config)

    full_model = train_global_xgboost(
        features, config, train_end, [horizon], feature_columns=candidates
    )
    gains = _gain_importance(full_model, candidates, horizon)
    ranked = sorted(gains.items(), key=lambda kv: kv[1], reverse=True)

    always = [c for c in candidates if _always_keep(c, fs.always_keep_prefixes)]
    top = [c for c, _ in ranked[: fs.top_k]]
    selected_set = set(always) | set(top)

    baseline_mape = None
    group_scores: Dict[str, Dict[str, object]] = {}
    group_map: Dict[str, List[str]] = {}
    for col in candidates:
        group_map.setdefault(feature_group(col), []).append(col)

    if fs.run_ablation:
        # Reuse the full-candidate fit for baseline MAPE (identical rows/cols/
        # horizon/train_end as a fresh retrain). Ablations still retrain.
        baseline_mape = _score_holdout_mape(full_model, features, train_end, horizon)
        for group, cols in group_map.items():
            if all(c in selected_set for c in cols):
                group_scores[group] = {
                    "kept": True,
                    "reason": "already_selected",
                    "ablationLiftPct": None,
                    "nFeatures": len(cols),
                }
                continue
            reduced = [c for c in candidates if c not in cols]
            if not reduced:
                group_scores[group] = {
                    "kept": True,
                    "reason": "sole_group",
                    "ablationLiftPct": None,
                    "nFeatures": len(cols),
                }
                selected_set.update(cols)
                continue
            ablated_mape = _holdout_mape(features, config, reduced, train_end, horizon)
            lift = None
            keep = False
            if (
                baseline_mape is not None
                and not np.isnan(baseline_mape)
                and ablated_mape is not None
                and not np.isnan(ablated_mape)
            ):
                lift = float(ablated_mape - baseline_mape)
                keep = lift >= fs.min_ablation_lift_pct
            if keep:
                selected_set.update(cols)
            group_scores[group] = {
                "kept": keep or all(c in selected_set for c in cols),
                "reason": "ablation" if keep else "below_threshold",
                "ablationLiftPct": None if lift is None else round(lift, 4),
                "nFeatures": len(cols),
            }
    else:
        for group, cols in group_map.items():
            group_scores[group] = {
                "kept": all(c in selected_set for c in cols),
                "reason": "importance_only",
                "ablationLiftPct": None,
                "nFeatures": len(cols),
            }

    selected = [c for c in candidates if c in selected_set]
    selected.sort(key=lambda c: gains.get(c, 0.0), reverse=True)
    rejected = [c for c in candidates if c not in selected_set]

    scores = {
        c: {
            "gain": round(gains.get(c, 0.0), 6),
            "rank": next((i + 1 for i, (n, _) in enumerate(ranked) if n == c), None),
            "group": feature_group(c),
            "alwaysKeep": c in always,
            "selected": c in selected_set,
        }
        for c in candidates
    }

    report = SelectionReport(
        as_of=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        selected=selected,
        rejected=rejected,
        scores=scores,
        groups=group_scores,
        always_kept=always,
        baseline_mape=(
            None
            if baseline_mape is None or np.isnan(baseline_mape)
            else round(float(baseline_mape), 4)
        ),
        n_candidates=len(candidates),
        reason=(
            f"Kept top-{fs.top_k} by gain, always-keep prefixes, and groups whose "
            f"ablation raised MAPE by ≥{fs.min_ablation_lift_pct} pp."
        ),
    )
    logger.info(
        "feature selection: %d/%d kept (baseline MAPE=%s)",
        len(selected),
        len(candidates),
        report.baseline_mape,
    )
    return report


def apply_selection(
    features: pd.DataFrame,
    selection: Optional[Dict[str, object]],
) -> List[str]:
    """Return ordered feature columns to train/score with, given a frozen report."""
    all_cols = get_feature_columns(features)
    if not selection:
        return all_cols
    selected = selection.get("selected") or []
    kept = [c for c in selected if c in all_cols]
    if not kept:
        logger.warning(
            "frozen selection has no overlap with current features; using full set"
        )
        return all_cols
    for col in all_cols:
        if col not in kept and (
            col.startswith("price_lag_")
            or col.startswith("fx_")
            or col.startswith("cmd_matched")
        ):
            kept.append(col)
    return kept
