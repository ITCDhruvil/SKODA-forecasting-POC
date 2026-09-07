"""Compare the sparse and full geo feature sets.

Prints per-family counts, the sparse feature list, and whether either mode
drops a driver below its ``feature_prefixes`` coverage (which would silently
demote it to "catalogued but not implemented" in the dashboard).
"""

from __future__ import annotations

import collections
import dataclasses
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

logging.disable(logging.WARNING)

from price_forecasting.config import load_config  # noqa: E402
from price_forecasting.data_generation import generate_price_panel  # noqa: E402
from price_forecasting.data_sourcing import load_macro_anchor  # noqa: E402
from price_forecasting.fx import load_fx_series  # noqa: E402
from price_forecasting.geopolitical import load_geo_bundle  # noqa: E402
from price_forecasting.parameters import ALL_DRIVERS  # noqa: E402
from price_forecasting.preprocessing import (  # noqa: E402
    PreprocessingReport,
    build_features,
    clean_panel,
)


def family_of(name: str) -> str:
    for prefix, family in (
        ("cmd_", "commodity"),
        ("freight", "freight"),
        ("gpr", "gpr"),
        ("chokepoint", "chokepoint"),
        ("geo_event", "event"),
    ):
        if name.startswith(prefix):
            return family
    return "exposure"


def main() -> int:
    config = load_config(ROOT / "config.yaml")
    config = dataclasses.replace(
        config,
        generation=dataclasses.replace(config.generation, n_parts=40, n_anomaly_parts=1),
    )
    config.paths.ensure()

    macro = load_macro_anchor(config)
    fx = load_fx_series(config, macro.values.index)
    geo = load_geo_bundle(config, macro.values.index)
    panel = generate_price_panel(config, macro, fx, geo=geo)
    clean = clean_panel(panel, config, PreprocessingReport())

    for mode in ("sparse", "full"):
        scoped = dataclasses.replace(
            config, geo=dataclasses.replace(config.geo, feature_mode=mode)
        )
        report = PreprocessingReport()
        frame = build_features(clean, scoped, macro, report, fx=fx, geo=geo)
        geo_features = report.geo_features
        counts = collections.Counter(family_of(name) for name in geo_features)

        print(f"--- {mode}: {len(geo_features)} geo features, {frame.shape[1]} total columns")
        print(f"    families: {dict(sorted(counts.items()))}")
        if mode == "sparse":
            for name in sorted(geo_features):
                print(f"      {name}")

        # Only geo drivers can be demoted by pruning; other drivers are fed by
        # non-geo columns that this mode does not touch.
        geo_driver_ids = {
            "geopolitical_risk",
            "tariffs_duty",
            "chokepoints",
            "steel",
            "aluminium_copper",
            "container_freight",
        }
        uncovered = [
            (driver.id, driver.feature_prefixes)
            for driver in ALL_DRIVERS
            if driver.id in geo_driver_ids
            and driver.feature_prefixes
            and not any(
                name.startswith(prefix)
                for prefix in driver.feature_prefixes
                for name in geo_features
            )
        ]
        print(f"    geo drivers losing prefix coverage: {uncovered or 'none'}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
