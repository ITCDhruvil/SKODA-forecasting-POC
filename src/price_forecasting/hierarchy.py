"""The project / vendor / category hierarchy, and how FX reaches a part price.

Master data for the three dimensions the model must differentiate:

* **Project** - a vehicle programme (SKODA Kushaq). Carries annual volume, which
  drives negotiating leverage, and a localisation percentage, which determines
  how much of the bill of materials is bought in rupees rather than imported.
* **Vendor** - a tier-1 supplier. Carries import dependency (share of *their*
  input cost that is foreign-invoiced), the currency split of that exposure, how
  often their contract reprices, and how much FX movement they absorb in margin
  rather than passing on.
* **Category** - a component class. Carries two separate FX elasticities,
  because a part is exposed to currency through two different channels.

The two FX channels
-------------------

**Direct (import invoicing).** The part, or a major sub-assembly of it, is
bought in EUR. A weaker rupee raises the invoice one-for-one, damped only by how
much of the programme is localised and how much the vendor absorbs. Sensors,
lighting and electrical carry most of this.

**Indirect (commodity).** Steel, copper, aluminium and oil-linked polymers are
priced off USD-denominated global benchmarks *even when bought domestically*. A
weaker rupee raises the rupee cost of a locally-bought steel coil. Localisation
does **not** protect against this, which is exactly why the two channels are
modelled separately rather than as one blended elasticity - fasteners are almost
fully localised yet still fully exposed to steel.

Pass-through is lagged. Supply contracts reprice quarterly or annually and
inventory buffers absorb the first shock, so an FX move in month *t* shows up in
prices two to four months later depending on the vendor's contract cadence.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple

import numpy as np


@dataclass(frozen=True)
class Project:
    """A vehicle programme.

    Attributes:
        code: Short identifier used in part numbers.
        name: Model name.
        oem: Manufacturer.
        segment: Body style / market segment.
        annual_volume: Units per year. High volume buys lower part prices.
        localisation: Share of bill-of-materials value sourced domestically.
            Damps the *direct* FX channel only.
    """

    code: str
    name: str
    oem: str
    segment: str
    annual_volume: int
    localisation: float

    @property
    def volume_discount(self) -> float:
        """Price multiplier from programme scale.

        A 150k/yr programme commands materially better piece prices than a
        12k/yr CKD line. Log-scaled: the marginal benefit of extra volume falls
        off, which is how real tiered piece-price agreements behave.
        """
        return float(1.0 - 0.055 * np.log10(max(self.annual_volume, 1) / 10_000.0))


@dataclass(frozen=True)
class Vendor:
    """A tier-1 supplier.

    Attributes:
        code: Short identifier.
        name: Supplier name.
        origin: ``domestic`` or ``international``.
        import_dependency: Share of the vendor's own input cost that is
            foreign-invoiced. Drives the direct FX channel.
        eur_share: Of that imported cost, the fraction invoiced in EUR. The
            remainder is treated as USD.
        contract_reprice_months: How often the supply agreement reprices. Longer
            cadence means slower, later FX pass-through.
        margin_absorption: Fraction of an FX move the vendor eats rather than
            passing on. Vendors with pricing power absorb less.
        price_index: Baseline price positioning versus the category median.
    """

    code: str
    name: str
    origin: str
    import_dependency: float
    eur_share: float
    contract_reprice_months: int
    margin_absorption: float
    price_index: float


@dataclass(frozen=True)
class Category:
    """A component category and its cost drivers.

    Attributes:
        code: Short identifier used in part numbers.
        name: Human-readable category.
        base_price_inr: Median piece price in rupees.
        price_sigma: Lognormal spread across parts in the category.
        fx_elasticity_import: Price response per unit log-move in the import
            currency, before vendor and project modulation.
        fx_elasticity_commodity: Price response per unit log-move in the
            commodity currency. Not damped by localisation.
        dominant_material: Primary input material.
        seasonal_peak_month: Month of peak demand pressure.
        seasonal_amplitude: Fractional swing about the annual mean.
        extra_lag_months: Category-specific pass-through delay on top of the
            vendor's contract cadence.
    """

    code: str
    name: str
    base_price_inr: float
    price_sigma: float
    fx_elasticity_import: float
    fx_elasticity_commodity: float
    dominant_material: str
    seasonal_peak_month: int
    seasonal_amplitude: float
    extra_lag_months: int


# --------------------------------------------------------------------------- #
# Master data
# --------------------------------------------------------------------------- #

# SKODA/VW India programmes. The first five sit on the localised MQB-A0-IN
# platform; Kodiaq is a CKD import and is deliberately included as the
# high-FX-exposure outlier that makes the localisation term matter.
PROJECTS: List[Project] = [
    Project("KUS", "SKODA Kushaq", "SKODA", "Compact SUV", 48_000, 0.95),
    Project("SLV", "SKODA Slavia", "SKODA", "Sedan", 31_000, 0.95),
    Project("KYL", "SKODA Kylaq", "SKODA", "Sub-4m SUV", 62_000, 0.96),
    Project("TGN", "VW Taigun", "Volkswagen", "Compact SUV", 44_000, 0.94),
    Project("VRT", "VW Virtus", "Volkswagen", "Sedan", 27_000, 0.94),
    Project("KDQ", "SKODA Kodiaq", "SKODA", "Full-size SUV (CKD)", 4_200, 0.35),
]

VENDORS: List[Vendor] = [
    # Domestic tier-1s: low import dependency, but still commodity-exposed.
    Vendor("SFL", "Sundram Fasteners", "domestic", 0.12, 0.25, 6, 0.35, 0.92),
    Vendor("BFL", "Bharat Forge", "domestic", 0.18, 0.30, 6, 0.30, 1.02),
    Vendor("END", "Endurance Technologies", "domestic", 0.20, 0.35, 3, 0.32, 0.97),
    Vendor("MND", "Minda Industries", "domestic", 0.28, 0.30, 3, 0.30, 0.99),
    Vendor("SNA", "Sona BLW", "domestic", 0.24, 0.45, 6, 0.28, 1.05),
    Vendor("GAB", "Gabriel India", "domestic", 0.16, 0.30, 6, 0.35, 0.94),
    Vendor("LUM", "Lumax Industries", "domestic", 0.34, 0.40, 3, 0.30, 0.98),
    Vendor("SND", "Sandhar Technologies", "domestic", 0.22, 0.30, 6, 0.33, 0.95),
    Vendor("JBM", "JBM Auto", "domestic", 0.14, 0.25, 12, 0.38, 0.93),
    Vendor("RNE", "Rane Group", "domestic", 0.19, 0.30, 6, 0.32, 0.96),
    Vendor("SUB", "Subros", "domestic", 0.31, 0.35, 3, 0.29, 1.00),
    Vendor("VRC", "Varroc Engineering", "domestic", 0.26, 0.40, 3, 0.31, 0.98),
    # International tier-1s operating in India: high import dependency, mostly
    # EUR-invoiced, quarterly repricing, and enough pricing power to pass more on.
    Vendor("BSH", "Bosch India", "international", 0.62, 0.75, 3, 0.18, 1.18),
    Vendor("CNT", "Continental India", "international", 0.58, 0.72, 3, 0.20, 1.15),
    Vendor("ZFI", "ZF India", "international", 0.55, 0.78, 3, 0.20, 1.14),
    Vendor("VLO", "Valeo India", "international", 0.54, 0.74, 3, 0.22, 1.12),
    Vendor("MHL", "Mahle India", "international", 0.49, 0.70, 6, 0.24, 1.09),
    Vendor("DNS", "Denso India", "international", 0.52, 0.35, 3, 0.21, 1.13),
    Vendor("APT", "Aptiv India", "international", 0.60, 0.55, 3, 0.19, 1.16),
    Vendor("BRS", "Brose India", "international", 0.51, 0.80, 6, 0.23, 1.10),
]

# Elasticities are per unit log-move in the relevant rate, before vendor and
# project modulation. Sensors and lighting are semiconductor- and LED-die-heavy
# so carry high import elasticity; fasteners and stampings are almost fully
# localised yet remain fully steel-exposed, which is the whole point of keeping
# the commodity channel separate.
# Elasticity spread is deliberately wide, because real exposure is. An imported
# semiconductor sensor and a domestically pressed steel bracket do not sit
# within 1.6x of each other on FX sensitivity - the first is almost entirely
# foreign-invoiced, the second almost entirely a domestic steel purchase. A
# narrow spread would also make category-level exposure statistically
# unidentifiable: the largest-vs-smallest effect would fall below the monthly
# noise, and no model could rank categories from it.
CATEGORIES: List[Category] = [
    Category("FST", "Fasteners", 42.0, 0.30, 0.06, 0.58, "steel", 4, 0.012, 0),
    Category("BDY", "Body Stampings", 780.0, 0.38, 0.08, 0.62, "steel", 5, 0.018, 0),
    Category("CHS", "Chassis", 3_150.0, 0.36, 0.18, 0.55, "steel", 3, 0.022, 1),
    Category("ITR", "Interior Trim", 1_640.0, 0.42, 0.22, 0.50, "polymer", 8, 0.020, 1),
    Category("BRK", "Braking", 2_480.0, 0.34, 0.32, 0.42, "iron/friction", 10, 0.026, 1),
    Category("PWT", "Powertrain", 6_900.0, 0.40, 0.40, 0.45, "aluminium", 6, 0.024, 1),
    Category("HVC", "HVAC", 5_400.0, 0.35, 0.55, 0.35, "aluminium/copper", 7, 0.045, 2),
    Category("ELC", "Electrical", 2_950.0, 0.44, 0.80, 0.25, "copper/semiconductor", 1, 0.055, 2),
    Category("LGT", "Lighting", 4_100.0, 0.40, 0.85, 0.18, "LED/polycarbonate", 11, 0.048, 2),
    Category("SNS", "Sensors", 1_880.0, 0.46, 0.95, 0.15, "semiconductor", 5, 0.030, 2),
]

PROJECTS_BY_CODE = {p.code: p for p in PROJECTS}
VENDORS_BY_CODE = {v.code: v for v in VENDORS}
CATEGORIES_BY_CODE = {c.code: c for c in CATEGORIES}

# Which vendors are credible suppliers for which category. Sundram Fasteners
# does not supply sensors; Bosch does not supply body stampings. Constraining
# this makes the vendor dimension carry real information instead of noise.
CATEGORY_VENDORS: Dict[str, List[str]] = {
    "FST": ["SFL", "BFL", "JBM", "SND"],
    "BDY": ["JBM", "BFL", "SND", "END"],
    "CHS": ["BFL", "END", "GAB", "SNA", "ZFI"],
    "BRK": ["END", "RNE", "BSH", "CNT", "ZFI"],
    "PWT": ["SNA", "BFL", "MHL", "ZFI", "END"],
    "ITR": ["MND", "VRC", "SND", "BRS", "LUM"],
    "HVC": ["SUB", "DNS", "VLO", "MHL"],
    "ELC": ["MND", "VRC", "BSH", "APT", "CNT", "DNS"],
    "LGT": ["LUM", "VRC", "MND", "VLO"],
    "SNS": ["BSH", "CNT", "DNS", "APT", "VLO"],
}

MATERIALS = {
    "steel": ("Steel", 1.0),
    "iron/friction": ("Cast iron", 1.0),
    "aluminium": ("Aluminium", 1.0),
    "aluminium/copper": ("Aluminium", 1.0),
    "polymer": ("Polymer", 1.0),
    "copper/semiconductor": ("Copper", 1.0),
    "LED/polycarbonate": ("Polycarbonate", 1.0),
    "semiconductor": ("Silicon", 1.0),
}


# --------------------------------------------------------------------------- #
# FX exposure
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class FxExposure:
    """Resolved per-part FX sensitivity.

    These are the *true* coefficients used to generate prices. They are ground
    truth for validating that the model has recovered the FX relationship, and
    are deliberately excluded from the model's feature set - recovering them is
    the test, not the input.

    Attributes:
        eur_beta: Price response per unit log-move in EUR/INR.
        usd_beta: Price response per unit log-move in USD/INR.
        lag_months: Delay before an FX move reaches price.
    """

    eur_beta: float
    usd_beta: float
    lag_months: int

    @property
    def total_beta(self) -> float:
        return self.eur_beta + self.usd_beta


def resolve_fx_exposure(
    project: Project,
    vendor: Vendor,
    category: Category,
    base_pass_through: float,
    default_lag: int,
    localisation_damping: float = 0.85,
) -> FxExposure:
    """Combine project, vendor and category into a part's FX sensitivity.

    The two channels are treated differently on purpose:

    * **Direct (EUR)** is scaled by the vendor's import dependency *and* damped
      by project localisation. A 96%-localised Kylaq part from a domestic vendor
      has almost no direct exposure; the same category on the CKD Kodiaq has a
      lot.
    * **Indirect (USD commodity)** is scaled by the category's material
      intensity and is **not** damped by localisation, because a domestically
      bought steel coil is still priced off a USD benchmark.

    Both are reduced by the vendor's margin absorption and the global
    pass-through ceiling, since suppliers rarely pass on 100% of a move.
    """
    retained = (1.0 - vendor.margin_absorption) * base_pass_through

    # Localisation is a value-weighted average across the whole bill of
    # materials, and it is not uniform by category. A programme reaches 95%
    # localisation by localising steel, plastics and fasteners - the content
    # that *stays* imported is precisely the semiconductor- and LED-heavy
    # categories, because there is no domestic source for them. So a category's
    # own import elasticity determines how much of the headline localisation
    # figure actually applies to it: high-import categories are barely damped,
    # commodity categories are damped almost fully.
    effective_localisation = project.localisation * (1.0 - category.fx_elasticity_import)

    # Direct channel: needs imported content to exist at all.
    import_intensity = vendor.import_dependency * (
        1.0 - localisation_damping * effective_localisation
    )
    eur_beta = (
        category.fx_elasticity_import * import_intensity * vendor.eur_share * retained
    )

    # The non-EUR slice of imported invoicing is USD-denominated, so it joins
    # the commodity channel rather than disappearing.
    usd_import_component = (
        category.fx_elasticity_import * import_intensity * (1.0 - vendor.eur_share)
    )
    # Commodity channel: applies regardless of where the part is physically
    # bought, because the benchmark is global.
    usd_beta = (category.fx_elasticity_commodity + usd_import_component) * retained

    lag = default_lag + category.extra_lag_months
    # A vendor repricing annually reacts later than one repricing quarterly.
    if vendor.contract_reprice_months >= 12:
        lag += 2
    elif vendor.contract_reprice_months >= 6:
        lag += 1

    return FxExposure(
        eur_beta=round(float(eur_beta), 6),
        usd_beta=round(float(usd_beta), 6),
        lag_months=int(lag),
    )


def fx_multiplier(
    exposure: FxExposure,
    fx_log_returns: Dict[str, np.ndarray],
    eur_pair: str,
    usd_pair: str,
) -> np.ndarray:
    """Multiplicative FX effect over time for one part.

    ``fx_log_returns`` holds, per pair, the cumulative log change from the first
    month. The lag is applied by shifting that path forward, so month *t* sees
    the FX level from *t - lag*, with the pre-lag period held at zero effect.
    """
    n = len(next(iter(fx_log_returns.values())))
    lag = exposure.lag_months

    def _lagged(path: np.ndarray) -> np.ndarray:
        shifted = np.zeros(n, dtype=float)
        if lag < n:
            shifted[lag:] = path[: n - lag]
        return shifted

    effect = exposure.eur_beta * _lagged(fx_log_returns[eur_pair])
    effect = effect + exposure.usd_beta * _lagged(fx_log_returns[usd_pair])
    return np.exp(effect)


def exposure_summary() -> List[Dict[str, object]]:
    """Ground-truth FX betas for a representative part in each category.

    Used in the report and dashboard to show what the model *should* recover.
    Computed against a mid-range vendor and a highly-localised project so the
    numbers describe the typical case rather than the extreme.
    """
    reference_project = PROJECTS_BY_CODE["KUS"]
    rows = []
    for category in CATEGORIES:
        vendors = [VENDORS_BY_CODE[v] for v in CATEGORY_VENDORS[category.code]]
        exposures = [
            resolve_fx_exposure(reference_project, vendor, category, 0.55, 2)
            for vendor in vendors
        ]
        rows.append(
            {
                "category": category.name,
                "code": category.code,
                "material": category.dominant_material,
                "eurBeta": round(float(np.mean([e.eur_beta for e in exposures])), 4),
                "usdBeta": round(float(np.mean([e.usd_beta for e in exposures])), 4),
                "totalBeta": round(float(np.mean([e.total_beta for e in exposures])), 4),
                "lagMonths": int(np.round(np.mean([e.lag_months for e in exposures]))),
            }
        )
    rows.sort(key=lambda r: r["totalBeta"], reverse=True)
    return rows
