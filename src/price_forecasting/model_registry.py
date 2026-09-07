"""Persist monthly model versions under ``models/YYYY-MM/``."""

from __future__ import annotations

import json
import pickle
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pandas as pd

from .config import Config
from .logging_utils import get_logger
from .modeling import GlobalXGBModel

logger = get_logger(__name__)


def model_version_id(as_of: Optional[pd.Timestamp] = None) -> str:
    stamp = as_of if as_of is not None else pd.Timestamp.utcnow()
    return stamp.strftime("%Y-%m")


def model_version_dir(config: Config, version_id: Optional[str] = None) -> Path:
    vid = version_id or model_version_id()
    return config.paths.models / vid


def latest_model_dir(config: Config) -> Optional[Path]:
    root = config.paths.models
    if not root.is_dir():
        return None
    versions = sorted(
        [p for p in root.iterdir() if p.is_dir() and (p / "model.pkl").is_file()],
        key=lambda p: p.name,
    )
    return versions[-1] if versions else None


def save_model_version(
    config: Config,
    model: GlobalXGBModel,
    *,
    selection: Optional[Dict[str, object]] = None,
    metrics: Optional[Dict[str, object]] = None,
    version_id: Optional[str] = None,
) -> Path:
    """Write booster + selection + metrics for a monthly retrain."""
    out = model_version_dir(config, version_id)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    with (out / "model.pkl").open("wb") as handle:
        pickle.dump(model, handle)

    meta = {
        "versionId": out.name,
        "savedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "featureColumns": list(model.feature_columns),
        "targetMode": model.target_mode,
        "horizons": sorted(model.models.keys()),
        "metrics": metrics or {},
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2, default=str), encoding="utf-8")

    if selection is not None:
        (out / "selected_features.json").write_text(
            json.dumps(selection, indent=2, default=str), encoding="utf-8"
        )

    # Pointer for weekly score
    current = config.paths.models / "CURRENT"
    current.write_text(out.name, encoding="utf-8")
    logger.info("registered model version %s at %s", out.name, out)
    return out


def load_model_version(
    config: Config, version_id: Optional[str] = None
) -> Tuple[GlobalXGBModel, Dict[str, object]]:
    """Load a registered model. Defaults to CURRENT / latest."""
    if version_id:
        path = model_version_dir(config, version_id)
    else:
        current = config.paths.models / "CURRENT"
        if current.is_file():
            path = model_version_dir(config, current.read_text(encoding="utf-8").strip())
        else:
            path = latest_model_dir(config)
    if path is None or not (path / "model.pkl").is_file():
        raise FileNotFoundError(
            "no registered model version found; run --stage retrain first"
        )
    with (path / "model.pkl").open("rb") as handle:
        model = pickle.load(handle)
    meta: Dict[str, object] = {}
    meta_path = path / "meta.json"
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["path"] = str(path)
    return model, meta


def list_model_versions(config: Config) -> List[str]:
    root = config.paths.models
    if not root.is_dir():
        return []
    return sorted(
        p.name for p in root.iterdir() if p.is_dir() and (p / "model.pkl").is_file()
    )
