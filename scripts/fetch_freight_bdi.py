"""Fetch freight / shipping-cost proxy into data/raw.

Default source: FRED Transportation Services Index — Freight (``TSIFRGHT``).
Writes ``freight_monthly.csv`` and refreshes ``freight_monthly.json`` so the
next pipeline ``source`` stage marks freight as real.

    python scripts/fetch_freight_bdi.py
    python scripts/fetch_freight_bdi.py --url https://fred.stlouisfed.org/graph/fredgraph.csv?id=TSIFRGHT
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from price_forecasting.config import load_config
from price_forecasting.data_sourcing import load_macro_anchor
from price_forecasting.geopolitical import (
    FRED_FREIGHT_CSV,
    _align_to_months,
    _http_get,
    _parse_freight_frame,
    _write_freight_cache,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument(
        "--url",
        default="",
        help="CSV URL (default: geo.freight_url or FRED TSIFRGHT)",
    )
    args = parser.parse_args()

    config = load_config(args.config)
    url = (args.url or config.geo.freight_url or FRED_FREIGHT_CSV).strip()
    timeout = max(config.sourcing.request_timeout_seconds, 90)
    print(f"fetching {url} …")
    payload = _http_get(url, timeout)
    frame = pd.read_csv(__import__("io").BytesIO(payload))
    series = _parse_freight_frame(frame)

    macro = load_macro_anchor(config)
    aligned = _align_to_months(series, macro.values.index)

    csv_path = config.paths.data_raw / config.geo.freight_filename
    out = pd.DataFrame(
        {
            "month": [m.strftime("%Y-%m-%d") for m in aligned.index],
            "value": [float(v) for v in aligned.to_numpy()],
        }
    )
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(csv_path, index=False)

    json_cache = config.paths.data_raw / "freight_monthly.json"
    _write_freight_cache(
        json_cache, aligned, "fred-tsi-freight", note=f"Fetched via {url[:80]}"
    )
    print(f"wrote {csv_path} ({len(out)} months)")
    print(f"wrote {json_cache}")
    print("Re-run: python -m price_forecasting.pipeline --stage source")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
