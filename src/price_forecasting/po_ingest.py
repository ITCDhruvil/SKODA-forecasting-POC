"""Purchase-order ingest: the path from customer history to the model panel.

The POC trains on a synthetic ``parts_prices.csv``. Production replaces that
file with monthly-aggregated PO / invoice lines mapped into the same schema
so preprocessing, XGBoost, and the dashboard keep working unchanged.

Expected raw file (configurable)::

    data/raw/purchase_orders.csv

Minimal columns::

    part_id, month, unit_price
    [optional] quantity, currency, po_id, invoice_date, ...

Master / dimension columns may live on the same rows or be filled from
defaults. After aggregation the output is one row per (part_id, month) with
the panel columns :mod:`data_generation` already uses.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from .config import Config
from .logging_utils import get_logger

logger = get_logger(__name__)

# Columns the rest of the pipeline assumes on the panel.
PANEL_REQUIRED = (
    "month",
    "price",
    "part_id",
    "part_name",
    "project_code",
    "project",
    "oem",
    "segment",
    "project_volume",
    "project_localisation",
    "vendor_code",
    "vendor",
    "vendor_origin",
    "vendor_import_dependency",
    "vendor_reprice_months",
    "category_code",
    "category",
    "material",
    "complexity_tier",
    "annual_part_volume",
    "weight_kg",
    "is_anomaly_part",
    "anomaly_type",
)

# Raw PO file: at least these three after alias normalisation.
PO_MINIMAL = ("part_id", "month", "unit_price")

# Friendly aliases customers often send.
COLUMN_ALIASES: Dict[str, Tuple[str, ...]] = {
    "part_id": ("part_id", "part_number", "sku", "material_number", "item_id"),
    "month": ("month", "period", "invoice_month", "posting_month"),
    "unit_price": ("unit_price", "price", "unit_cost", "net_price", "invoice_price"),
    "quantity": ("quantity", "qty", "invoice_qty", "po_qty"),
    "invoice_date": ("invoice_date", "po_date", "posting_date", "document_date"),
    "part_name": ("part_name", "description", "material_description"),
    "project_code": ("project_code", "programme_code", "project_id"),
    "project": ("project", "programme", "vehicle_line"),
    "vendor_code": ("vendor_code", "supplier_code", "vendor_id"),
    "vendor": ("vendor", "supplier", "vendor_name"),
    "category_code": ("category_code", "commodity_code"),
    "category": ("category", "commodity", "product_group"),
    "vendor_origin": ("vendor_origin", "supplier_origin", "origin"),
    "material": ("material", "primary_material"),
    "currency": ("currency", "curr"),
}


@dataclass(frozen=True)
class PoIngestReport:
    """What happened during PO → panel conversion."""

    source_path: str
    n_raw_rows: int
    n_parts: int
    n_months: int
    n_panel_rows: int
    month_start: str
    month_end: str
    aggregation: str
    currency: str
    warnings: Tuple[str, ...]

    def as_dict(self) -> Dict[str, object]:
        return {
            "sourcePath": self.source_path,
            "nRawRows": self.n_raw_rows,
            "nParts": self.n_parts,
            "nMonths": self.n_months,
            "nPanelRows": self.n_panel_rows,
            "monthStart": self.month_start,
            "monthEnd": self.month_end,
            "aggregation": self.aggregation,
            "currency": self.currency,
            "warnings": list(self.warnings),
            "skuLayer": "purchase_orders",
            "isReal": True,
        }


class PoIngestError(ValueError):
    """Raised when a PO file cannot be mapped into the panel schema."""


def po_file_path(config: Config) -> Path:
    return config.paths.data_raw / config.sku.purchase_orders_filename


def po_file_exists(config: Config) -> bool:
    return po_file_path(config).is_file()


def resolve_sku_mode(config: Config) -> str:
    """Return ``purchase_orders`` or ``synthetic`` after applying ``auto``."""
    mode = config.sku.mode
    if mode == "purchase_orders":
        if not po_file_exists(config):
            raise PoIngestError(
                f"sku.mode=purchase_orders but file not found: {po_file_path(config)}"
            )
        return "purchase_orders"
    if mode == "synthetic":
        return "synthetic"
    # auto
    if po_file_exists(config):
        return "purchase_orders"
    return "synthetic"


def _rename_aliases(frame: pd.DataFrame) -> pd.DataFrame:
    renamed = frame.copy()
    lower_map = {c.lower().strip(): c for c in renamed.columns}
    for canonical, aliases in COLUMN_ALIASES.items():
        if canonical in renamed.columns:
            continue
        for alias in aliases:
            if alias.lower() in lower_map:
                renamed = renamed.rename(columns={lower_map[alias.lower()]: canonical})
                break
    return renamed


def _month_from_row(frame: pd.DataFrame) -> pd.Series:
    if "month" in frame.columns:
        months = pd.to_datetime(frame["month"], errors="coerce")
    elif "invoice_date" in frame.columns:
        months = pd.to_datetime(frame["invoice_date"], errors="coerce")
    else:
        raise PoIngestError(
            "PO file needs a month column or invoice_date to derive month"
        )
    if months.isna().all():
        raise PoIngestError("could not parse any month / invoice_date values")
    return months.dt.to_period("M").dt.to_timestamp()


def load_purchase_orders(config: Config, path: Optional[Path] = None) -> pd.DataFrame:
    """Load and normalise the raw PO CSV (not yet month-aggregated)."""
    path = path or po_file_path(config)
    if not path.is_file():
        raise PoIngestError(f"purchase order file not found: {path}")

    frame = pd.read_csv(path)
    if frame.empty:
        raise PoIngestError(f"purchase order file is empty: {path}")

    frame = _rename_aliases(frame)
    missing = [c for c in ("part_id", "unit_price") if c not in frame.columns]
    if missing:
        raise PoIngestError(
            f"PO file missing required column(s) {missing}. "
            f"Accepted aliases: { {k: COLUMN_ALIASES[k] for k in ('part_id', 'unit_price')} }"
        )

    frame["month"] = _month_from_row(frame)
    frame["part_id"] = frame["part_id"].astype(str).str.strip()
    frame["unit_price"] = pd.to_numeric(frame["unit_price"], errors="coerce")
    frame = frame.dropna(subset=["part_id", "month", "unit_price"])
    frame = frame[frame["unit_price"] > 0]
    if frame.empty:
        raise PoIngestError("no valid PO rows after cleaning (need positive unit_price)")

    if "quantity" in frame.columns:
        frame["quantity"] = pd.to_numeric(frame["quantity"], errors="coerce").fillna(1.0)
        frame.loc[frame["quantity"] <= 0, "quantity"] = 1.0
    else:
        frame["quantity"] = 1.0

    logger.info(
        "loaded %d PO line(s) from %s (%d part(s), %d month(s))",
        len(frame),
        path.name,
        frame["part_id"].nunique(),
        frame["month"].nunique(),
    )
    return frame


def _volume_weighted_price(group: pd.DataFrame) -> float:
    qty = group["quantity"].to_numpy(dtype=float)
    price = group["unit_price"].to_numpy(dtype=float)
    total_qty = float(qty.sum())
    if total_qty <= 0:
        return float(price.mean())
    return float(np.average(price, weights=qty))


def _fill_dimension(frame: pd.DataFrame, column: str, default) -> pd.Series:
    if column in frame.columns:
        series = frame[column]
        if series.isna().all() or (series.astype(str).str.strip() == "").all():
            return pd.Series(default, index=frame.index)
        return series.fillna(default)
    return pd.Series(default, index=frame.index)


def aggregate_po_to_panel(
    po: pd.DataFrame,
    config: Config,
    *,
    source_path: str = "",
) -> Tuple[pd.DataFrame, PoIngestReport]:
    """Collapse PO lines to one (part_id, month) panel row."""
    warnings: List[str] = []

    rows = []
    for (part_id, month), group in po.groupby(["part_id", "month"], sort=True):
        price = _volume_weighted_price(group)
        first = group.iloc[0]

        def col(name: str, default):
            if name in group.columns and pd.notna(first.get(name)) and str(first.get(name)).strip():
                return first[name]
            return default

        project_code = str(col("project_code", "UNK-PROJ"))
        vendor_code = str(col("vendor_code", "UNK-VND"))
        category_code = str(col("category_code", "UNK"))

        rows.append(
            {
                "month": month,
                "price": price,
                "part_id": str(part_id),
                "part_name": str(col("part_name", part_id)),
                "project_code": project_code,
                "project": str(col("project", project_code)),
                "oem": str(col("oem", "OEM")),
                "segment": str(col("segment", "unknown")),
                "project_volume": float(col("project_volume", 10000)),
                "project_localisation": float(col("project_localisation", 0.5)),
                "vendor_code": vendor_code,
                "vendor": str(col("vendor", vendor_code)),
                "vendor_origin": str(col("vendor_origin", "domestic")),
                "vendor_import_dependency": float(col("vendor_import_dependency", 0.5)),
                "vendor_reprice_months": int(col("vendor_reprice_months", 6)),
                "category_code": category_code,
                "category": str(col("category", category_code)),
                "material": str(col("material", "unknown")),
                "complexity_tier": str(col("complexity_tier", "standard")),
                "annual_part_volume": float(col("annual_part_volume", group["quantity"].sum() * 12)),
                "weight_kg": float(col("weight_kg", 1.0)),
                "is_anomaly_part": False,
                "anomaly_type": "",
                # Ground-truth betas unknown for real PO — leave as NaN so they
                # stay out of features and FX-recovery tests skip gracefully.
                "true_eur_beta": np.nan,
                "true_usd_beta": np.nan,
                "true_fx_lag": np.nan,
                "true_steel_beta": np.nan,
                "true_freight_beta": np.nan,
                "true_gpr_beta": np.nan,
            }
        )

    panel = pd.DataFrame(rows).sort_values(["part_id", "month"]).reset_index(drop=True)

    # Clamp exposure fields into [0, 1]
    for col in ("project_localisation", "vendor_import_dependency"):
        panel[col] = panel[col].clip(0.0, 1.0)

    short = (
        panel.groupby("part_id")["month"].count()
        < config.preprocessing.min_history_months
    )
    n_short = int(short.sum())
    if n_short:
        warnings.append(
            f"{n_short} part(s) have fewer than "
            f"{config.preprocessing.min_history_months} months; they will use "
            "the short-history fallback in modeling."
        )

    currency = "INR"
    if "currency" in po.columns and po["currency"].notna().any():
        currency = str(po["currency"].dropna().iloc[0])

    report = PoIngestReport(
        source_path=source_path or str(po_file_path(config)),
        n_raw_rows=int(len(po)),
        n_parts=int(panel["part_id"].nunique()),
        n_months=int(panel["month"].nunique()),
        n_panel_rows=int(len(panel)),
        month_start=panel["month"].min().strftime("%Y-%m"),
        month_end=panel["month"].max().strftime("%Y-%m"),
        aggregation="volume_weighted_mean_unit_price",
        currency=currency,
        warnings=tuple(warnings),
    )
    logger.info(
        "aggregated PO → panel: %d part(s) × %d month(s) = %d row(s) [%s → %s]",
        report.n_parts,
        report.n_months,
        report.n_panel_rows,
        report.month_start,
        report.month_end,
    )
    return panel, report


def build_panel_from_purchase_orders(
    config: Config,
) -> Tuple[pd.DataFrame, PoIngestReport]:
    """End-to-end: load PO CSV → monthly panel ready for preprocess."""
    path = po_file_path(config)
    po = load_purchase_orders(config, path)
    return aggregate_po_to_panel(po, config, source_path=str(path))


def panel_to_purchase_order_lines(
    panel: pd.DataFrame,
    *,
    seed: int = 42,
) -> pd.DataFrame:
    """Convert a synthetic panel into demo PO lines (1–3 invoices per month).

    Used to create a sample ``purchase_orders.csv`` so the ingest path can be
    exercised without a customer file.
    """
    rng = np.random.default_rng(seed)
    lines: List[Dict[str, object]] = []
    for _, row in panel.iterrows():
        n_inv = int(rng.integers(1, 4))
        weights = rng.dirichlet(np.ones(n_inv))
        month = pd.Timestamp(row["month"])
        for i, w in enumerate(weights):
            jitter = float(rng.normal(0.0, 0.008))
            lines.append(
                {
                    "part_id": row["part_id"],
                    "part_name": row["part_name"],
                    "invoice_date": (month + pd.Timedelta(days=5 + 7 * i)).strftime(
                        "%Y-%m-%d"
                    ),
                    "unit_price": round(float(row["price"]) * (1.0 + jitter), 4),
                    "quantity": int(max(1, round(50 * w))),
                    "currency": "INR",
                    "project_code": row["project_code"],
                    "project": row["project"],
                    "oem": row.get("oem", "OEM"),
                    "segment": row.get("segment", "unknown"),
                    "project_volume": row.get("project_volume", 10000),
                    "project_localisation": row.get("project_localisation", 0.5),
                    "vendor_code": row["vendor_code"],
                    "vendor": row["vendor"],
                    "vendor_origin": row.get("vendor_origin", "domestic"),
                    "vendor_import_dependency": row.get("vendor_import_dependency", 0.5),
                    "vendor_reprice_months": row.get("vendor_reprice_months", 6),
                    "category_code": row["category_code"],
                    "category": row["category"],
                    "material": row.get("material", "unknown"),
                    "complexity_tier": row.get("complexity_tier", "standard"),
                    "annual_part_volume": row.get("annual_part_volume", 1000),
                    "weight_kg": row.get("weight_kg", 1.0),
                    "po_id": f"PO-{row['part_id']}-{month.strftime('%Y%m')}-{i+1}",
                }
            )
    return pd.DataFrame(lines)


def write_example_po_template(path: Path) -> Path:
    """Write a tiny header-only template customers can fill."""
    path.parent.mkdir(parents=True, exist_ok=True)
    cols = [
        "part_id",
        "part_name",
        "invoice_date",
        "unit_price",
        "quantity",
        "currency",
        "project_code",
        "project",
        "vendor_code",
        "vendor",
        "vendor_origin",
        "vendor_import_dependency",
        "project_localisation",
        "category_code",
        "category",
        "material",
    ]
    pd.DataFrame(columns=cols).to_csv(path, index=False)
    return path
