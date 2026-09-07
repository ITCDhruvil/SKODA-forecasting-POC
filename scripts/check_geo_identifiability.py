"""Where is geo exposure actually identifiable — and at which hierarchy level?

Freight and GPR exposure are planted through vendor import dependency and
project localisation, not through the category. This checks the beta spread and
implied signal-to-noise at each rollup level, so the shock-recovery test can be
run where the variation actually lives.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

logging.disable(logging.WARNING)

from price_forecasting.config import load_config  # noqa: E402
from price_forecasting.data_generation import generate_price_panel  # noqa: E402
from price_forecasting.data_sourcing import load_macro_anchor  # noqa: E402
from price_forecasting.fx import load_fx_series  # noqa: E402
from price_forecasting.geo_scenario import (  # noqa: E402
    geo_signal_to_noise,
    geo_trend_collinearity,
)
from price_forecasting.geopolitical import load_geo_bundle  # noqa: E402
from price_forecasting.preprocessing import PreprocessingReport, clean_panel  # noqa: E402

config = load_config(ROOT / "config.yaml")
config = dataclasses.replace(
    config,
    generation=dataclasses.replace(config.generation, n_parts=180, n_anomaly_parts=4),
)
config.paths.ensure()

macro = load_macro_anchor(config)
fx = load_fx_series(config, macro.values.index)
geo = load_geo_bundle(config, macro.values.index)
panel = generate_price_panel(config, macro, fx, geo=geo)
clean = clean_panel(panel, config, PreprocessingReport())

print(json.dumps(geo_signal_to_noise(clean, config, geo), indent=2))
print("\nTrend collinearity:")
print(json.dumps(geo_trend_collinearity(geo), indent=2))

print("\n=== Beta spread by rollup level ===")
swings = {"steel": 0.1191, "freight": 0.32, "gpr": 1.1226}
noise_sd = config.generation.noise_sigma / np.sqrt(1 - config.generation.noise_phi**2)
months = float(clean["month"].nunique())

for beta_col, channel in (
    ("true_steel_beta", "steel"),
    ("true_freight_beta", "freight"),
    ("true_gpr_beta", "gpr"),
):
    print(f"\n{channel} ({beta_col}):")
    for level in ("category", "vendor", "project"):
        if level not in clean.columns:
            continue
        grouped = clean.groupby(level)[beta_col].mean()
        spread = float(grouped.max() - grouped.min())
        parts_per_group = float(clean.groupby(level)["part_id"].nunique().mean())
        group_noise = float(noise_sd * 100 / np.sqrt(max(parts_per_group * months, 1.0)))
        signal = spread * swings[channel] * 100
        snr = signal / group_noise if group_noise else float("inf")
        print(
            f"  {level:9s} n={grouped.size:2d} spread={spread:.5f} "
            f"signal={signal:.3f}% noise={group_noise:.4f}% SNR={snr:6.2f}"
        )
