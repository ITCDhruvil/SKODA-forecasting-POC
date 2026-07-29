"""Hierarchical component price panel: project -> vendor -> category -> part.

Why synthetic at the part level: no public source publishes monthly piece prices
per automotive SKU per vendor per vehicle programme. That data exists only inside
OEM purchasing systems. Two things here *are* real and drive the panel's shape:

* the BLS motor-vehicle-parts price index, supplying the macro trend, and
* ECB EUR/INR and USD/INR reference rates, supplying the FX effect.

Price for part *p* in month *t* is a product of independent, individually
interpretable factors:

    price[p,t] = base[p]                    # lognormal about category median
               * project_factor[p]          # programme volume leverage
               * vendor_factor[p]           # supplier price positioning
               * macro[t]                   # REAL BLS index, normalised
               * fx_multiplier[p,t]         # REAL FX, lagged & elasticity-weighted
               * seasonal[cat,t]            # category demand cycle
               * (1 + drift[p]) ** t        # programme cost-down / escalation
               * exp(noise[p,t])            # AR(1) market volatility
               * break[p,t]                 # structural break, a few parts

Multiplicative because these effects are proportional: a 10% rupee depreciation
moves a Rs 6,900 powertrain casting by more rupees than a Rs 42 fastener, but by
a similar percentage within a category.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from .config import Config
from .data_sourcing import MacroSeries
from .fx import FxSeries
from .hierarchy import (
    CATEGORIES,
    CATEGORIES_BY_CODE,
    CATEGORY_VENDORS,
    MATERIALS,
    PROJECTS,
    VENDORS_BY_CODE,
    FxExposure,
    fx_multiplier,
    resolve_fx_exposure,
)
from .logging_utils import get_logger

logger = get_logger(__name__)

COMPLEXITY_TIERS = ("A", "B", "C")

# Structural breaks, applied in catalogue order to a handful of parts.
# (anomaly_type, start_fraction, magnitude, duration_months or None)
BREAK_SPECS: List[Tuple[str, float, float, Optional[int]]] = [
    ("supplier_resourcing", 0.52, -0.19, None),   # moved to a cheaper vendor
    ("tariff_step", 0.64, 0.16, None),            # customs duty change
    ("semiconductor_shortage", 0.70, 0.34, 4),    # allocation premium, reverts
    ("tooling_amortised", 0.58, -0.12, None),     # tooling paid off, price drops
    ("commodity_spike", 0.76, 0.22, 3),           # steel spike, reverts
]


@dataclass
class GenerationDiagnostics:
    """What the generator actually produced, for the report."""

    n_parts: int = 0
    n_projects: int = 0
    n_vendors: int = 0
    n_categories: int = 0
    n_months: int = 0
    n_anomaly_parts: int = 0
    mean_eur_beta: float = 0.0
    mean_usd_beta: float = 0.0
    fx_price_impact_pct: float = 0.0

    def as_dict(self) -> Dict[str, object]:
        return {
            "parts": self.n_parts,
            "projects": self.n_projects,
            "vendors": self.n_vendors,
            "categories": self.n_categories,
            "months": self.n_months,
            "anomaly_parts": self.n_anomaly_parts,
            "mean_eur_beta": round(self.mean_eur_beta, 4),
            "mean_usd_beta": round(self.mean_usd_beta, 4),
            "fx_price_impact_pct": round(self.fx_price_impact_pct, 3),
        }


# --------------------------------------------------------------------------- #
# Catalogue
# --------------------------------------------------------------------------- #


def _seasonal_factor(months: pd.DatetimeIndex, peak_month: int, amplitude: float) -> np.ndarray:
    """Cosine seasonal multiplier peaking in ``peak_month``."""
    phase = 2.0 * np.pi * (months.month.to_numpy() - peak_month) / 12.0
    return 1.0 + amplitude * np.cos(phase)


def _ar1_noise(n: int, phi: float, sigma: float, rng: np.random.Generator) -> np.ndarray:
    """AR(1) log-noise started from its stationary distribution."""
    noise = np.empty(n, dtype=float)
    stationary_sd = sigma / np.sqrt(max(1.0 - phi**2, 1e-9))
    noise[0] = rng.normal(0.0, stationary_sd)
    for t in range(1, n):
        noise[t] = phi * noise[t - 1] + rng.normal(0.0, sigma)
    return noise


def _break_factor(
    n_months: int, start_fraction: float, magnitude: float, duration: Optional[int]
) -> np.ndarray:
    factor = np.ones(n_months, dtype=float)
    start = min(max(int(round(start_fraction * n_months)), 1), n_months - 1)
    if duration is None:
        factor[start:] = 1.0 + magnitude
    else:
        factor[start : min(start + duration, n_months)] = 1.0 + magnitude
    return factor


def build_part_catalogue(config: Config, rng: np.random.Generator) -> pd.DataFrame:
    """Mint parts across the project x vendor x category hierarchy.

    Vendors are drawn only from those credible for the category, so the vendor
    dimension carries real signal. Each project gets a spread across every
    category, because a vehicle programme buys from all of them.
    """
    gen = config.generation
    n_parts = gen.n_parts

    rows: List[Dict[str, object]] = []
    seen: set = set()
    index = 0
    guard = 0

    while len(rows) < n_parts:
        guard += 1
        if guard > n_parts * 60:
            raise RuntimeError("could not mint enough unique parts; widen the catalogue")

        # Rotate deterministically so every project and category is represented
        # proportionally rather than left to sampling luck.
        project = PROJECTS[index % len(PROJECTS)]
        category = CATEGORIES[(index // len(PROJECTS)) % len(CATEGORIES)]
        index += 1

        vendor_code = str(rng.choice(CATEGORY_VENDORS[category.code]))
        vendor = VENDORS_BY_CODE[vendor_code]

        complexity = str(rng.choice(COMPLEXITY_TIERS, p=[0.45, 0.35, 0.20]))
        variant = int(rng.integers(1, 40))
        key = (project.code, vendor.code, category.code, complexity, variant)
        if key in seen:
            continue
        seen.add(key)

        exposure = resolve_fx_exposure(
            project, vendor, category, config.fx.base_pass_through,
            config.fx.default_pass_through_lag,
        )

        complexity_multiplier = {"A": 0.78, "B": 1.0, "C": 1.45}[complexity]
        base_price = float(
            rng.lognormal(mean=np.log(category.base_price_inr), sigma=category.price_sigma)
        ) * complexity_multiplier * vendor.price_index * project.volume_discount

        material_name, _ = MATERIALS[category.dominant_material]

        rows.append(
            {
                "part_id": f"{project.code}-{category.code}-{len(rows):05d}",
                "part_name": (
                    f"{category.name} {complexity}{variant:02d} - "
                    f"{project.name} ({vendor.name})"
                ),
                # --- hierarchy dimensions ---
                "project_code": project.code,
                "project": project.name,
                "oem": project.oem,
                "segment": project.segment,
                "project_volume": project.annual_volume,
                "project_localisation": round(project.localisation, 3),
                "vendor_code": vendor.code,
                "vendor": vendor.name,
                "vendor_origin": vendor.origin,
                "vendor_import_dependency": round(vendor.import_dependency, 3),
                "vendor_reprice_months": vendor.contract_reprice_months,
                "category_code": category.code,
                "category": category.name,
                # --- part characteristics ---
                "material": material_name,
                "complexity_tier": complexity,
                "annual_part_volume": int(
                    project.annual_volume * rng.uniform(0.8, 1.2) * rng.choice([1, 1, 2, 4])
                ),
                "weight_kg": round(
                    float(np.clip(rng.lognormal(np.log(1.6), 0.9), 0.02, 60.0)), 3
                ),
                "base_price_inr": round(base_price, 2),
                # --- generative truth, excluded from features ---
                "true_eur_beta": exposure.eur_beta,
                "true_usd_beta": exposure.usd_beta,
                "true_fx_lag": exposure.lag_months,
                "drift": float(rng.normal(gen.drift_mu, gen.drift_sigma)),
            }
        )

    catalogue = pd.DataFrame(rows)
    logger.info(
        "minted %d parts across %d projects x %d vendors x %d categories; "
        "price range Rs %.0f - Rs %.0f",
        len(catalogue),
        catalogue["project_code"].nunique(),
        catalogue["vendor_code"].nunique(),
        catalogue["category_code"].nunique(),
        catalogue["base_price_inr"].min(),
        catalogue["base_price_inr"].max(),
    )
    return catalogue


# --------------------------------------------------------------------------- #
# Panel generation
# --------------------------------------------------------------------------- #


def generate_price_panel(
    config: Config,
    macro: MacroSeries,
    fx: Dict[str, FxSeries],
    rng: Optional[np.random.Generator] = None,
) -> pd.DataFrame:
    """Generate the long-format monthly price panel.

    Args:
        config: Pipeline configuration.
        macro: Real BLS index covering the history window.
        fx: Real FX series keyed by pair, covering the same window.
        rng: Optional generator; defaults to one seeded from config.

    Returns:
        Long DataFrame, one row per (part, month), with hierarchy columns, part
        characteristics, the FX rates prevailing that month, and the price.
    """
    gen = config.generation
    if rng is None:
        rng = np.random.default_rng(config.project.random_seed)

    catalogue = build_part_catalogue(config, rng)
    months = macro.values.index
    n_months = len(months)
    macro_factor = macro.normalized().to_numpy()

    eur_pair, usd_pair = _resolve_pairs(config, fx)
    # Cumulative log change from month zero, per pair. The FX multiplier applies
    # a part-specific lag and beta to these paths.
    fx_log_paths = {
        pair: np.log(series.values.to_numpy() / float(series.values.iloc[0]))
        for pair, series in fx.items()
    }

    anomaly_assignment = _assign_breaks(catalogue, gen.n_anomaly_parts, n_months)

    frames = []
    fx_impacts = []

    for record in catalogue.to_dict("records"):
        category = CATEGORIES_BY_CODE[record["category_code"]]

        exposure = FxExposure(
            eur_beta=record["true_eur_beta"],
            usd_beta=record["true_usd_beta"],
            lag_months=int(record["true_fx_lag"]),
        )
        fx_effect = fx_multiplier(exposure, fx_log_paths, eur_pair, usd_pair)
        fx_impacts.append(float(fx_effect[-1] - 1.0))

        seasonal = _seasonal_factor(months, category.seasonal_peak_month, category.seasonal_amplitude)
        noise = _ar1_noise(n_months, gen.noise_phi, gen.noise_sigma, rng)
        trend = (1.0 + record["drift"]) ** np.arange(n_months)

        anomaly_type, break_path = anomaly_assignment.get(
            record["part_id"], (None, np.ones(n_months))
        )

        price = (
            record["base_price_inr"]
            * macro_factor
            * fx_effect
            * seasonal
            * trend
            * np.exp(noise)
            * break_path
        )

        frame = pd.DataFrame({"month": months, "price": np.round(price, 2)})
        for column in (
            "part_id", "part_name", "project_code", "project", "oem", "segment",
            "project_volume", "project_localisation", "vendor_code", "vendor",
            "vendor_origin", "vendor_import_dependency", "vendor_reprice_months",
            "category_code", "category", "material", "complexity_tier",
            "annual_part_volume", "weight_kg", "true_eur_beta", "true_usd_beta",
            "true_fx_lag",
        ):
            frame[column] = record[column]

        frame["is_anomaly_part"] = anomaly_type is not None
        frame["anomaly_type"] = anomaly_type or ""
        frames.append(frame)

    panel = pd.concat(frames, ignore_index=True)

    # Attach the FX rates prevailing in each month. These are the model's
    # legitimate FX inputs - the rate is public and known at purchase time.
    for pair, series in fx.items():
        panel[f"fx_{pair.lower()}"] = panel["month"].map(series.values)

    panel = _inject_missing_values(panel, config, rng)

    diagnostics = GenerationDiagnostics(
        n_parts=int(panel["part_id"].nunique()),
        n_projects=int(panel["project_code"].nunique()),
        n_vendors=int(panel["vendor_code"].nunique()),
        n_categories=int(panel["category_code"].nunique()),
        n_months=n_months,
        n_anomaly_parts=len(anomaly_assignment),
        mean_eur_beta=float(catalogue["true_eur_beta"].mean()),
        mean_usd_beta=float(catalogue["true_usd_beta"].mean()),
        fx_price_impact_pct=float(np.mean(fx_impacts) * 100),
    )

    logger.info(
        "generated panel: %d rows | %d parts | %d months (%s to %s)",
        len(panel), diagnostics.n_parts, n_months,
        months.min().date(), months.max().date(),
    )
    logger.info(
        "hierarchy: %d projects, %d vendors, %d categories",
        diagnostics.n_projects, diagnostics.n_vendors, diagnostics.n_categories,
    )
    logger.info(
        "FX transmission: mean EUR beta %.4f, mean USD beta %.4f -> FX moved "
        "the average part price by %+.2f%% over the window",
        diagnostics.mean_eur_beta, diagnostics.mean_usd_beta,
        diagnostics.fx_price_impact_pct,
    )
    if anomaly_assignment:
        logger.info(
            "structural breaks on %d part(s): %s",
            len(anomaly_assignment),
            ", ".join(f"{pid} ({atype})" for pid, (atype, _) in anomaly_assignment.items()),
        )

    panel.attrs["diagnostics"] = diagnostics.as_dict()
    return panel


def _resolve_pairs(config: Config, fx: Dict[str, FxSeries]) -> Tuple[str, str]:
    """Identify which pair carries the import channel and which the commodity one."""
    eur_pair = usd_pair = None
    for spec in config.fx.pairs:
        pair = f"{spec['base']}{spec['quote']}"
        if spec.get("channel") == "commodity":
            usd_pair = pair
        else:
            eur_pair = pair

    available = list(fx)
    eur_pair = eur_pair or available[0]
    usd_pair = usd_pair or available[-1]

    if eur_pair not in fx or usd_pair not in fx:
        raise KeyError(
            f"configured FX pairs {eur_pair}/{usd_pair} not present in fetched "
            f"series {available}"
        )
    return eur_pair, usd_pair


def _assign_breaks(
    catalogue: pd.DataFrame, n_anomaly_parts: int, n_months: int
) -> Dict[str, Tuple[str, np.ndarray]]:
    """Spread structural breaks across the catalogue, deterministically."""
    assignment: Dict[str, Tuple[str, np.ndarray]] = {}
    count = min(n_anomaly_parts, len(BREAK_SPECS), len(catalogue))
    if count == 0:
        return assignment

    stride = max(len(catalogue) // count, 1)
    for i in range(count):
        anomaly_type, start_fraction, magnitude, duration = BREAK_SPECS[i]
        row = catalogue.iloc[min(i * stride, len(catalogue) - 1)]
        assignment[row["part_id"]] = (
            anomaly_type,
            _break_factor(n_months, start_fraction, magnitude, duration),
        )
    return assignment


def _inject_missing_values(
    panel: pd.DataFrame, config: Config, rng: np.random.Generator
) -> pd.DataFrame:
    """Knock out a small share of observations.

    Real purchasing feeds have gaps: a vendor misses a price submission, a part
    is superseded mid-quarter. Injecting them exercises the cleaning stage
    against the problem it exists to solve.
    """
    rate = config.generation.missing_value_rate
    if rate <= 0:
        return panel

    eligible = panel.groupby("part_id", sort=False).cumcount() > 0
    mask = eligible & (rng.random(len(panel)) < rate)
    panel.loc[mask, "price"] = np.nan

    logger.info(
        "injected %d missing prices (%.2f%% of panel) to exercise cleaning",
        int(mask.sum()), 100.0 * mask.sum() / len(panel),
    )
    return panel


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #


def save_panel(config: Config, panel: pd.DataFrame) -> Path:
    """Write the panel to ``data/raw/parts_prices.csv``."""
    config.paths.data_raw.mkdir(parents=True, exist_ok=True)
    out_path = config.paths.data_raw / "parts_prices.csv"
    panel.to_csv(out_path, index=False, date_format="%Y-%m-%d")
    logger.info("wrote price panel to %s (%.1f KB)", out_path, out_path.stat().st_size / 1024)
    return out_path


def load_panel(config: Config) -> pd.DataFrame:
    """Read the panel back, restoring dtypes."""
    path = config.paths.data_raw / "parts_prices.csv"
    if not path.is_file():
        raise FileNotFoundError(f"{path} not found. Run the 'generate' stage first.")
    panel = pd.read_csv(path, parse_dates=["month"])
    panel["anomaly_type"] = panel["anomaly_type"].fillna("")
    return panel
