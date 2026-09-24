"""Ingest optional commercial nomination / SOP / budget baselines."""

from __future__ import annotations

from pathlib import Path
from typing import Dict, Optional, Tuple

import pandas as pd

# Column aliases → canonical names
_ALIASES: Dict[str, str] = {
    "part_id": "part_id",
    "partid": "part_id",
    "part": "part_id",
    "sku": "part_id",
    "nomination_month": "nomination_month",
    "nom_month": "nomination_month",
    "budget_month": "nomination_month",
    "sop_month": "sop_month",
    "current_month": "sop_month",
    "bg_unit_price": "bg_unit_price",
    "budget_unit_price": "bg_unit_price",
    "budget_price": "bg_unit_price",
    "bg_price": "bg_unit_price",
    "nomination_unit_price": "nomination_unit_price",
    "nomination_price": "nomination_unit_price",
    "sop_unit_price": "sop_unit_price",
    "sop_price": "sop_unit_price",
    "current_price": "sop_unit_price",
    "volume": "volume",
    "qty": "volume",
    "quantity": "volume",
    "annual_part_volume": "volume",
    "annual_volume": "volume",
    "bom_qty": "volume",
}


def _norm_col(name: object) -> str:
    return str(name or "").strip().lower().replace(" ", "_").replace("-", "_")


def load_commercial_baselines(path: Path) -> Tuple[Optional[pd.DataFrame], str]:
    """
    Load a commercial baselines CSV if present.

    Returns ``(frame_or_None, status_note)``. Frame is indexed-ready with
    ``part_id`` and optional price / month / volume overrides.
    """
    if path is None or not Path(path).is_file():
        return None, f"No commercial file at {path}"

    raw = pd.read_csv(path)
    if raw.empty:
        return None, f"Commercial file empty: {path}"

    rename = {}
    for col in raw.columns:
        key = _norm_col(col)
        if key in _ALIASES:
            rename[col] = _ALIASES[key]
    work = raw.rename(columns=rename)
    if "part_id" not in work.columns:
        return None, f"Commercial file missing part_id column: {path}"

    work["part_id"] = work["part_id"].astype(str).str.strip()
    work = work[work["part_id"].ne("")].drop_duplicates("part_id", keep="last")

    for col in (
        "bg_unit_price",
        "nomination_unit_price",
        "sop_unit_price",
        "volume",
    ):
        if col in work.columns:
            work[col] = pd.to_numeric(work[col], errors="coerce")

    for col in ("nomination_month", "sop_month"):
        if col in work.columns:
            work[col] = (
                pd.to_datetime(work[col], errors="coerce").dt.strftime("%Y-%m")
            )

    # Prefer explicit BG; else nomination unit price.
    if "bg_unit_price" not in work.columns and "nomination_unit_price" in work.columns:
        work["bg_unit_price"] = work["nomination_unit_price"]

    return work, f"Loaded {len(work)} commercial baseline row(s) from {path.name}"
