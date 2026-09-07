"""Build a demo purchase_orders.csv from the current synthetic panel.

Does not overwrite purchase_orders.csv unless --install is passed (that would
flip sku.mode=auto onto the PO path). By default writes:

  data/raw/purchase_orders.example.csv
  data/raw/purchase_orders.template.csv
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from price_forecasting.config import load_config
from price_forecasting.data_generation import load_panel
from price_forecasting.po_ingest import (
    panel_to_purchase_order_lines,
    write_example_po_template,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument(
        "--install",
        action="store_true",
        help="Also write data/raw/purchase_orders.csv (activates sku.mode=auto)",
    )
    parser.add_argument(
        "--max-parts",
        type=int,
        default=40,
        help="Limit parts in the example file (keeps the sample small)",
    )
    args = parser.parse_args()

    config = load_config(args.config)
    panel = load_panel(config)
    part_ids = sorted(panel["part_id"].unique())[: args.max_parts]
    subset = panel[panel["part_id"].isin(part_ids)].copy()

    lines = panel_to_purchase_order_lines(subset, seed=config.project.random_seed)
    example_path = config.paths.data_raw / "purchase_orders.example.csv"
    example_path.parent.mkdir(parents=True, exist_ok=True)
    lines.to_csv(example_path, index=False)
    print(f"wrote {example_path} ({len(lines)} lines, {len(part_ids)} parts)")

    template_path = config.paths.data_raw / "purchase_orders.template.csv"
    write_example_po_template(template_path)
    print(f"wrote {template_path}")

    if args.install:
        dest = config.paths.data_raw / config.sku.purchase_orders_filename
        lines.to_csv(dest, index=False)
        print(
            f"wrote {dest} — next `pipeline --stage generate` will use purchase orders "
            f"(sku.mode={config.sku.mode})"
        )
    else:
        print(
            "Tip: copy purchase_orders.example.csv → purchase_orders.csv, or re-run "
            "with --install, then `python -m price_forecasting.pipeline --stage generate`"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
