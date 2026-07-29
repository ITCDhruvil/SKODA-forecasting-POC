"""Catalogue of every driver that could feed automotive component price forecasting.

The POC currently models a handful of these. This module defines the full space
so a customer can see the roadmap: what is live, what could be connected with
modest effort, and what is a larger programme.

Why this exists as code rather than a slide: the ``implemented`` status is
derived from the model's actual feature list, so the catalogue cannot claim
something is live once it has been removed. Everything else - impact channel,
data sources, effort - is curated reference knowledge and is stated as such.

Structure of a driver entry:

* **impact channel** - the mechanism by which it reaches a piece price. A driver
  with no plausible channel does not belong in a pricing model regardless of how
  interesting it looks.
* **sources** - concrete providers, with whether they are free or paid, how
  often they update, and how quickly. "Real-time" claims are useless without
  publication latency: a quarterly series cannot drive a monthly forecast.
* **effort** - integration cost, honestly graded. Most of the value sits in the
  low and medium tiers.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Dict, List, Sequence, Tuple

from .logging_utils import get_logger

logger = get_logger(__name__)

# Status values:
#   implemented - a feature derived from this driver is in the trained model
#   available   - public data exists and could be wired in without new licences
#   roadmap     - needs a commercial feed, customer data, or modelling work
STATUS_IMPLEMENTED = "implemented"
STATUS_AVAILABLE = "available"
STATUS_ROADMAP = "roadmap"


@dataclass(frozen=True)
class Source:
    """Where a driver's data comes from."""

    provider: str
    access: str          # "free" | "paid" | "customer"
    frequency: str
    latency: str
    endpoint: str = ""


@dataclass(frozen=True)
class Driver:
    """One candidate forecasting parameter."""

    id: str
    name: str
    group: str
    description: str
    impact_channel: str
    direction: str
    effort: str                       # "low" | "medium" | "high"
    example: str
    sources: Tuple[Source, ...]
    status: str = STATUS_AVAILABLE
    # Feature-name prefixes that indicate this driver is actually in the model.
    # Empty means it cannot be auto-detected and the declared status stands.
    feature_prefixes: Tuple[str, ...] = ()

    def as_dict(self) -> Dict[str, object]:
        payload = asdict(self)
        payload["sources"] = [asdict(s) for s in self.sources]
        payload.pop("feature_prefixes", None)
        return payload


# --------------------------------------------------------------------------- #
# 1. Currency and financial
# --------------------------------------------------------------------------- #

CURRENCY: List[Driver] = [
    Driver(
        id="fx_spot",
        name="FX spot rates (EUR/INR, USD/INR)",
        group="Currency & financial",
        description=(
            "Exchange rate between the pricing currency and the currencies that "
            "imported content and global commodities are invoiced in."
        ),
        impact_channel=(
            "Two channels. Direct: foreign-invoiced parts and sub-assemblies "
            "reprice one-for-one with the rate. Indirect: USD-benchmarked "
            "commodities raise input cost even for domestically bought parts."
        ),
        direction="Domestic currency weakens -> imported input cost rises -> price rises, lagged 2-6 months",
        effort="low",
        example=(
            "EUR/INR moved from 90.8 to 109.3 over the modelled window (+20.4%), "
            "which on a 95%-localised programme still lifts sensor and lighting "
            "categories materially because those are the content that stays imported."
        ),
        sources=(
            Source("European Central Bank (via Frankfurter)", "free", "Daily", "Same day", "https://api.frankfurter.app"),
            Source("Reserve Bank of India reference rate", "free", "Daily", "Same day"),
        ),
        status=STATUS_IMPLEMENTED,
        feature_prefixes=("fx_",),
    ),
    Driver(
        id="fx_forward",
        name="FX forward curve / implied volatility",
        group="Currency & financial",
        description=(
            "Market-implied expectations of future exchange rates, and the "
            "uncertainty around them."
        ),
        impact_channel=(
            "Forward points are the market's own forecast of the driver we most "
            "care about. Implied volatility indicates how wide the forecast "
            "interval should be, which spot alone cannot tell you."
        ),
        direction="Widening forward premium -> higher expected future input cost",
        effort="medium",
        example=(
            "A steep INR forward premium ahead of a known policy event signals "
            "expected depreciation before it shows up in spot."
        ),
        sources=(
            Source("Refinitiv / Bloomberg", "paid", "Real-time", "Live"),
            Source("NSE currency derivatives", "free", "Daily", "Next day"),
        ),
    ),
    Driver(
        id="interest_rates",
        name="Policy and lending rates",
        group="Currency & financial",
        description="Central bank policy rate and corporate borrowing cost.",
        impact_channel=(
            "Working-capital cost for suppliers. Tier-2 and tier-3 vendors "
            "carrying inventory on credit pass financing cost into piece price, "
            "especially on long payment terms."
        ),
        direction="Rates rise -> supplier financing cost rises -> upward price pressure",
        effort="low",
        example="RBI repo rate changes feed vendor working-capital cost within roughly a quarter.",
        sources=(
            Source("Reserve Bank of India", "free", "Policy meetings", "Same day"),
            Source("FRED (global policy rates)", "free", "Daily", "Same day"),
        ),
    ),
    Driver(
        id="hedging_position",
        name="Internal FX hedging position",
        group="Currency & financial",
        description="The company's own forward cover on foreign-currency payables.",
        impact_channel=(
            "Determines how much of an FX move actually reaches the P&L. A fully "
            "hedged quarter is insulated regardless of what spot does."
        ),
        direction="Higher hedge ratio -> lower realised FX impact",
        effort="low",
        example="A 70% hedged position converts a 10% depreciation into roughly a 3% realised cost increase.",
        sources=(Source("Customer treasury system", "customer", "Monthly", "Internal"),),
        status=STATUS_ROADMAP,
    ),
]

# --------------------------------------------------------------------------- #
# 2. Commodities and raw materials
# --------------------------------------------------------------------------- #

COMMODITIES: List[Driver] = [
    Driver(
        id="steel",
        name="Steel prices (HRC, CRC, alloy)",
        group="Commodities & raw materials",
        description="Hot and cold rolled coil, and alloy grades used in stampings, chassis and fasteners.",
        impact_channel=(
            "Dominant input cost for stampings, chassis, fasteners and brake "
            "components - often 50-70% of piece cost. Priced off global "
            "benchmarks even when bought domestically."
        ),
        direction="Steel rises -> direct cost-up in steel-intensive categories, lagged by contract cadence",
        effort="medium",
        example=(
            "The 2021 HRC spike roughly doubled coil prices and triggered "
            "widespread cost-up claims across stamping vendors."
        ),
        sources=(
            Source("SteelMint / BigMint India", "paid", "Weekly", "Same week"),
            Source("MEPS International", "paid", "Monthly", "Mid-month"),
            Source("World Bank Pink Sheet", "free", "Monthly", "~1 week"),
            Source("LME steel scrap", "paid", "Daily", "Live"),
        ),
    ),
    Driver(
        id="aluminium_copper",
        name="Aluminium and copper (LME)",
        group="Commodities & raw materials",
        description="Non-ferrous metals used in powertrain castings, HVAC, wiring harness and motors.",
        impact_channel=(
            "Copper drives wiring harness, alternators and motors; aluminium "
            "drives castings, heat exchangers and increasingly body structures. "
            "Both are exchange-traded, so pass-through is fast and visible."
        ),
        direction="LME rises -> electrical and HVAC categories reprice within 1-3 months",
        effort="low",
        example="Copper above $10,000/t materially raises harness and motor cost per vehicle.",
        sources=(
            Source("London Metal Exchange", "paid", "Daily", "Live"),
            Source("World Bank Pink Sheet", "free", "Monthly", "~1 week"),
            Source("MCX India", "free", "Daily", "Same day"),
        ),
    ),
    Driver(
        id="crude_polymer",
        name="Crude oil and polymer feedstock",
        group="Commodities & raw materials",
        description="Brent/WTI and downstream resins - PP, ABS, PA, PVC - used in trim and under-bonnet parts.",
        impact_channel=(
            "Polymer prices track crude with a one to two month lag. Interior "
            "trim, bumpers, hoses and sealing systems are polymer-dominated."
        ),
        direction="Crude rises -> polymer feedstock rises -> trim and sealing categories rise, ~2 month lag",
        effort="low",
        example="Interior trim and sealing categories track naphtha-linked resin contracts closely.",
        sources=(
            Source("US EIA", "free", "Weekly", "Same week", "https://api.eia.gov"),
            Source("ICIS polymer indices", "paid", "Weekly", "Same week"),
            Source("World Bank Pink Sheet", "free", "Monthly", "~1 week"),
        ),
    ),
    Driver(
        id="rare_earth_battery",
        name="Rare earths and battery metals",
        group="Commodities & raw materials",
        description="Neodymium, dysprosium, lithium, cobalt, nickel - EV motors, batteries and sensors.",
        impact_channel=(
            "Permanent-magnet motors and battery packs. Supply is geographically "
            "concentrated, so price is as much a geopolitical variable as an "
            "industrial one."
        ),
        direction="Supply restriction -> sharp, step-like increases in EV powertrain cost",
        effort="medium",
        example=(
            "China's 2023 export controls on gallium and germanium moved "
            "semiconductor and sensor input costs within weeks."
        ),
        sources=(
            Source("Benchmark Mineral Intelligence", "paid", "Weekly", "Same week"),
            Source("Fastmarkets", "paid", "Daily", "Live"),
            Source("USGS commodity summaries", "free", "Annual", "Months"),
        ),
        status=STATUS_ROADMAP,
    ),
    Driver(
        id="energy_cost",
        name="Industrial electricity and gas tariffs",
        group="Commodities & raw materials",
        description="Energy input cost for foundries, forging, heat treatment and paint shops.",
        impact_channel=(
            "Energy-intensive processes - casting, forging, glass, heat treatment "
            "- carry double-digit energy shares of conversion cost."
        ),
        direction="Industrial tariff rises -> conversion cost rises in energy-intensive categories",
        effort="medium",
        example=(
            "The 2022 European gas crisis pushed energy surcharges into foundry "
            "and glass contracts across the continent."
        ),
        sources=(
            Source("Central Electricity Authority (India)", "free", "Monthly", "~1 month"),
            Source("Eurostat energy prices", "free", "Semi-annual", "Months"),
        ),
    ),
]

# --------------------------------------------------------------------------- #
# 3. Geopolitical and trade
# --------------------------------------------------------------------------- #

GEOPOLITICAL: List[Driver] = [
    Driver(
        id="geopolitical_risk",
        name="Geopolitical risk / armed conflict",
        group="Geopolitical & trade",
        description=(
            "Quantified conflict and geopolitical tension, both globally and "
            "along specific sourcing corridors."
        ),
        impact_channel=(
            "Conflict is an upstream driver rather than a direct one. It moves "
            "currency, energy, freight and insurance simultaneously - which is "
            "precisely why it is worth modelling separately: those channels are "
            "correlated during a shock in a way normal-times data will not show."
        ),
        direction="Escalation -> currency weakness + energy spike + freight/insurance premium, compounding",
        effort="medium",
        example=(
            "Russia's invasion of Ukraine simultaneously moved palladium (catalytic "
            "converters), neon (semiconductor lithography), energy and wire harness "
            "supply out of western Ukraine - four separate channels from one event."
        ),
        sources=(
            Source("Caldara & Iacoviello Geopolitical Risk Index", "free", "Monthly", "~1 month", "https://www.matteoiacoviello.com/gpr.htm"),
            Source("ACLED conflict data", "free", "Weekly", "~1 week"),
            Source("World Bank political stability indicator", "free", "Annual", "Months"),
        ),
    ),
    Driver(
        id="tariffs_duty",
        name="Import duties, tariffs and trade remedies",
        group="Geopolitical & trade",
        description="Customs duty rates, anti-dumping measures and countervailing duties on components and raw material.",
        impact_channel=(
            "A step change straight onto landed cost of imported content. Unlike "
            "most drivers this is discrete and dated - it is knowable in advance "
            "from the notification, which makes it unusually forecastable."
        ),
        direction="Duty increase -> immediate step-up in landed cost of affected tariff lines",
        effort="medium",
        example=(
            "Indian customs duty changes on CKD kits and specific component lines "
            "land in the annual Union Budget with a known effective date."
        ),
        sources=(
            Source("CBIC India tariff notifications", "free", "Ad hoc", "On publication"),
            Source("WTO Tariff Download Facility", "free", "Annual", "Months"),
            Source("UN Comtrade", "free", "Monthly", "~2 months"),
        ),
    ),
    Driver(
        id="export_controls",
        name="Sanctions and export controls",
        group="Geopolitical & trade",
        description="Restrictions on specific materials, technologies, entities or destinations.",
        impact_channel=(
            "Forces resourcing to alternative suppliers, usually at higher cost "
            "and with requalification expense. Effect is a permanent level shift "
            "rather than a cyclical move."
        ),
        direction="New control -> resourcing cost + qualification cost -> permanent step up",
        effort="high",
        example="Semiconductor export controls reshaped ECU and sensor sourcing across the industry.",
        sources=(
            Source("OFAC / EU sanctions lists", "free", "Ad hoc", "On publication"),
            Source("BIS Entity List", "free", "Ad hoc", "On publication"),
        ),
        status=STATUS_ROADMAP,
    ),
    Driver(
        id="trade_agreements",
        name="Free trade agreements and rules of origin",
        group="Geopolitical & trade",
        description="Preferential tariff access and the local-content thresholds required to claim it.",
        impact_channel=(
            "Determines the duty actually paid on imported content, and sets the "
            "localisation percentage that makes a programme FX-resilient in the "
            "first place."
        ),
        direction="FTA in force -> lower effective duty on qualifying content",
        effort="high",
        example="India-EFTA and India-UK agreements change the effective duty on European-sourced content.",
        sources=(
            Source("WTO RTA database", "free", "Ad hoc", "On publication"),
            Source("Ministry of Commerce (India)", "free", "Ad hoc", "On publication"),
        ),
        status=STATUS_ROADMAP,
    ),
    Driver(
        id="chokepoints",
        name="Shipping chokepoint disruption",
        group="Geopolitical & trade",
        description="Suez/Red Sea, Panama Canal, Strait of Hormuz, Taiwan Strait transit status.",
        impact_channel=(
            "Rerouting adds transit days and freight cost, and forces air freight "
            "for line-stopping parts. Hits landed cost and lead time together."
        ),
        direction="Chokepoint disruption -> freight + insurance + expedite cost, within weeks",
        effort="medium",
        example=(
            "Red Sea diversions from late 2023 added roughly 10-14 days to "
            "Asia-Europe transit and multiplied container rates."
        ),
        sources=(
            Source("IMF PortWatch", "free", "Daily", "~2 days", "https://portwatch.imf.org"),
            Source("Suez Canal Authority statistics", "free", "Monthly", "~1 month"),
        ),
    ),
]

# --------------------------------------------------------------------------- #
# 4. Logistics and supply chain
# --------------------------------------------------------------------------- #

LOGISTICS: List[Driver] = [
    Driver(
        id="container_freight",
        name="Container freight rates",
        group="Logistics & supply chain",
        description="Spot and contract ocean freight on the lanes that carry imported content.",
        impact_channel=(
            "Direct landed-cost component for imported parts. Matters most for "
            "low-value/high-volume items where freight is a large share of "
            "delivered cost."
        ),
        direction="Freight rates rise -> landed cost of imported content rises, 1-2 month lag",
        effort="low",
        example=(
            "Drewry's composite index moved roughly 5x during 2021 and again "
            "during the 2024 Red Sea disruption."
        ),
        sources=(
            Source("Drewry World Container Index", "paid", "Weekly", "Same week"),
            Source("Freightos Baltic Index", "free", "Daily", "Same day"),
            Source("Baltic Dry Index", "free", "Daily", "Same day"),
        ),
    ),
    Driver(
        id="port_congestion",
        name="Port congestion and dwell time",
        group="Logistics & supply chain",
        description="Berth waiting times and container dwell at origin and destination ports.",
        impact_channel=(
            "Lengthens lead time, forces safety stock, and triggers expedite "
            "premiums. Shows up as cost before it shows up as a freight rate."
        ),
        direction="Congestion rises -> inventory carrying and expedite cost rise",
        effort="medium",
        example="JNPT and Nhava Sheva dwell times directly affect inbound schedules for Pune assembly.",
        sources=(
            Source("IMF PortWatch", "free", "Daily", "~2 days"),
            Source("Indian Ports Association", "free", "Monthly", "~1 month"),
        ),
    ),
    Driver(
        id="air_freight",
        name="Air freight rates",
        group="Logistics & supply chain",
        description="Air cargo cost, used for line-stopping and launch-critical parts.",
        impact_channel=(
            "The escape valve when ocean fails. Air freight cost is the true price "
            "of a supply disruption and is often absorbed invisibly in logistics "
            "budgets rather than piece price."
        ),
        direction="Disruption -> air freight substitution -> sharp, temporary landed-cost spike",
        effort="medium",
        example="Semiconductor shortages routinely justified air freighting ECUs at many multiples of ocean cost.",
        sources=(
            Source("TAC Index", "paid", "Weekly", "Same week"),
            Source("IATA air cargo market analysis", "free", "Monthly", "~1 month"),
        ),
    ),
    Driver(
        id="semiconductor_supply",
        name="Semiconductor lead times and allocation",
        group="Logistics & supply chain",
        description="MCU and power-semiconductor lead times, foundry utilisation and allocation status.",
        impact_channel=(
            "Allocation premiums and broker-market purchases. During shortage the "
            "spot price for a controller can exceed contract price many times over."
        ),
        direction="Lead times extend -> allocation premium on electronics and sensors",
        effort="medium",
        example=(
            "The 2021-22 shortage produced broker prices at 10-100x contract for "
            "some automotive MCUs and idled assembly lines industry-wide."
        ),
        sources=(
            Source("Susquehanna lead time index", "paid", "Monthly", "~1 month"),
            Source("SIA billings report", "free", "Monthly", "~1 month"),
            Source("TrendForce", "paid", "Monthly", "~1 month"),
        ),
    ),
]

# --------------------------------------------------------------------------- #
# 5. Macro-economic
# --------------------------------------------------------------------------- #

MACRO: List[Driver] = [
    Driver(
        id="parts_price_index",
        name="Automotive parts price index",
        group="Macro-economic",
        description="Published price index for motor vehicle parts - the sector's own inflation measure.",
        impact_channel=(
            "Captures the shared cost trend across the whole category that no "
            "single commodity explains: labour, overhead, margin and mix."
        ),
        direction="Index rises -> broad upward pressure across all parts",
        effort="low",
        example="The BLS motor vehicle parts index rose about 4.9% across the modelled window.",
        sources=(
            Source("US Bureau of Labor Statistics", "free", "Monthly", "~2 weeks", "https://api.bls.gov/publicAPI/v1"),
            Source("MOSPI WPI (India)", "free", "Monthly", "~2 weeks"),
        ),
        status=STATUS_IMPLEMENTED,
        feature_prefixes=("macro_",),
    ),
    Driver(
        id="wpi_cpi",
        name="Domestic inflation (WPI / CPI)",
        group="Macro-economic",
        description="Wholesale and consumer price inflation in the manufacturing country.",
        impact_channel=(
            "Most long-term supply agreements contain escalation clauses indexed "
            "to WPI. This is contractual pass-through, not an estimated effect."
        ),
        direction="WPI rises -> contractual escalation triggers at the next reset",
        effort="low",
        example="Indian LTAs commonly index conversion cost to WPI-manufactured with an annual reset.",
        sources=(
            Source("MOSPI (India)", "free", "Monthly", "~2 weeks"),
            Source("Reserve Bank of India database", "free", "Monthly", "~2 weeks"),
        ),
    ),
    Driver(
        id="labour_cost",
        name="Wage and labour cost index",
        group="Macro-economic",
        description="Manufacturing wage growth and minimum wage revisions.",
        impact_channel=(
            "Conversion cost for labour-intensive operations - assembly, wiring "
            "harness, trim - where labour can exceed material cost."
        ),
        direction="Wages rise -> conversion cost rises in labour-intensive categories",
        effort="medium",
        example="Harness assembly is labour-dominated, so state minimum wage revisions move it directly.",
        sources=(
            Source("Labour Bureau (India)", "free", "Monthly", "~1 month"),
            Source("ILO statistics", "free", "Quarterly", "Months"),
        ),
    ),
    Driver(
        id="industrial_production",
        name="Industrial production index",
        group="Macro-economic",
        description="Manufacturing output, as a proxy for capacity tightness across the supply base.",
        impact_channel=(
            "High utilisation across the supplier base reduces your negotiating "
            "leverage: a vendor running full has no reason to discount."
        ),
        direction="High utilisation -> weaker buyer leverage -> firmer prices",
        effort="low",
        example="IIP manufacturing above trend correlates with reduced willingness to accept cost-down.",
        sources=(
            Source("MOSPI IIP", "free", "Monthly", "~6 weeks"),
            Source("FRED industrial production", "free", "Monthly", "~2 weeks"),
        ),
    ),
]

# --------------------------------------------------------------------------- #
# 6. Demand and programme
# --------------------------------------------------------------------------- #

DEMAND: List[Driver] = [
    Driver(
        id="programme_volume",
        name="Programme volume and take rate",
        group="Demand & programme",
        description="Annual build volume per vehicle programme and per variant.",
        impact_channel=(
            "Piece price is contractually tiered on volume. This is usually the "
            "single largest controllable lever on unit cost."
        ),
        direction="Volume rises -> next price tier -> lower piece price",
        effort="low",
        example="A programme moving from 30k to 60k units per year typically unlocks a contractual tier.",
        sources=(
            Source("Customer production plan", "customer", "Monthly", "Internal"),
            Source("SIAM production statistics", "free", "Monthly", "~1 month"),
        ),
        status=STATUS_IMPLEMENTED,
        feature_prefixes=("project_volume", "annual_part_volume"),
    ),
    Driver(
        id="lifecycle_stage",
        name="Model lifecycle stage",
        group="Demand & programme",
        description="Where a programme sits between launch, mid-cycle refresh and run-out.",
        impact_channel=(
            "Cost curves are lifecycle-dependent: launch carries tooling "
            "amortisation and low-volume premiums, maturity delivers learning-"
            "curve cost-down, run-out brings small-lot penalties back."
        ),
        direction="Launch high -> maturity low -> run-out rises again",
        effort="low",
        example="Tooling amortisation completing typically produces a visible one-off step down.",
        sources=(Source("Customer programme calendar", "customer", "Quarterly", "Internal"),),
        status=STATUS_ROADMAP,
    ),
    Driver(
        id="seasonality",
        name="Seasonal demand pattern",
        group="Demand & programme",
        description="Within-year demand cycles at category level.",
        impact_channel=(
            "Aftermarket and service demand peaks tighten supply for shared "
            "components, firming prices seasonally."
        ),
        direction="Seasonal peak -> tighter supply -> firmer prices",
        effort="low",
        example="Battery and lighting demand peaks in winter; cooling components peak pre-summer.",
        sources=(Source("Derived from the price history itself", "free", "Monthly", "Immediate"),),
        status=STATUS_IMPLEMENTED,
        feature_prefixes=("month_sin", "month_cos", "month_of_year"),
    ),
    Driver(
        id="ev_transition",
        name="Powertrain mix shift (ICE to EV)",
        group="Demand & programme",
        description="Share of build moving to electrified powertrains.",
        impact_channel=(
            "Structurally reshapes the parts basket: exhaust, fuel systems and "
            "transmissions decline while power electronics, magnets and thermal "
            "management grow. Declining-volume ICE parts get more expensive per "
            "unit as they lose scale."
        ),
        direction="EV share rises -> ICE part volumes fall -> ICE piece cost rises on lost scale",
        effort="high",
        example="Falling ICE volumes raise per-unit cost on exhaust and fuel system components.",
        sources=(
            Source("Customer product plan", "customer", "Annual", "Internal"),
            Source("SIAM / FADA registration data", "free", "Monthly", "~1 month"),
        ),
        status=STATUS_ROADMAP,
    ),
]

# --------------------------------------------------------------------------- #
# 7. Supplier
# --------------------------------------------------------------------------- #

SUPPLIER: List[Driver] = [
    Driver(
        id="vendor_profile",
        name="Vendor profile and import dependency",
        group="Supplier",
        description=(
            "Supplier origin, share of input cost that is foreign-invoiced, "
            "contract repricing cadence and price positioning."
        ),
        impact_channel=(
            "Determines how much of any FX or commodity move a given vendor "
            "passes through, and how quickly. This is what makes exposure "
            "identifiable across suppliers within the same month."
        ),
        direction="Higher import dependency -> larger and faster pass-through",
        effort="low",
        example=(
            "International tier-1s in the modelled data carry roughly ten times "
            "the direct FX exposure of domestic vendors."
        ),
        sources=(Source("Vendor master data", "customer", "Static", "Internal"),),
        status=STATUS_IMPLEMENTED,
        feature_prefixes=("vendor_", "hier_vendor"),
    ),
    Driver(
        id="vendor_financial_health",
        name="Supplier financial health",
        group="Supplier",
        description="Credit rating, leverage, working-capital position and distress signals.",
        impact_channel=(
            "A distressed supplier either raises prices or fails. Both are cost "
            "events; the second is far more expensive because it forces emergency "
            "resourcing."
        ),
        direction="Deteriorating health -> cost-up claims, or resourcing cost on failure",
        effort="medium",
        example="Tier-2 insolvencies during 2020-21 forced emergency resourcing at significant premiums.",
        sources=(
            Source("CRISIL / ICRA ratings", "paid", "Ad hoc", "On publication"),
            Source("MCA filings (India)", "free", "Annual", "Months"),
            Source("Customer supplier risk system", "customer", "Monthly", "Internal"),
        ),
        status=STATUS_ROADMAP,
    ),
    Driver(
        id="sourcing_concentration",
        name="Single-source and concentration risk",
        group="Supplier",
        description="Number of qualified sources per part and geographic concentration of supply.",
        impact_channel=(
            "Single-sourced parts have no competitive tension, so cost-down is "
            "structurally harder and disruption risk is priced in."
        ),
        direction="Single source -> weaker negotiating position -> firmer prices",
        effort="low",
        example="Dual-sourcing a category typically unlocks competitive cost-down at the next negotiation.",
        sources=(Source("Customer sourcing matrix", "customer", "Quarterly", "Internal"),),
        status=STATUS_ROADMAP,
    ),
    Driver(
        id="capacity_utilisation",
        name="Supplier capacity utilisation",
        group="Supplier",
        description="How full a vendor's plant is relative to nameplate capacity.",
        impact_channel=(
            "A vendor running near capacity has no incentive to discount and may "
            "charge premiums for incremental volume."
        ),
        direction="High utilisation -> firmer prices, longer lead times",
        effort="medium",
        example="Capacity-constrained casting suppliers routinely decline incremental volume at standard price.",
        sources=(Source("Supplier reporting / audits", "customer", "Quarterly", "Internal"),),
        status=STATUS_ROADMAP,
    ),
]

# --------------------------------------------------------------------------- #
# 8. Regulatory
# --------------------------------------------------------------------------- #

REGULATORY: List[Driver] = [
    Driver(
        id="emission_safety_norms",
        name="Emission and safety regulation",
        group="Regulatory & compliance",
        description="Emission standards and mandated safety content.",
        impact_channel=(
            "Adds required content and forces redesign. Effect is a dated step "
            "change tied to the compliance deadline, not a gradual drift."
        ),
        direction="New norm -> added content and redesign cost -> step up at the deadline",
        effort="medium",
        example=(
            "BS-VI raised aftertreatment content substantially; mandated six-airbag "
            "rules added restraint system cost across segments."
        ),
        sources=(
            Source("MoRTH notifications (India)", "free", "Ad hoc", "On publication"),
            Source("UNECE regulations", "free", "Ad hoc", "On publication"),
        ),
    ),
    Driver(
        id="localisation_incentives",
        name="Localisation mandates and incentives",
        group="Regulatory & compliance",
        description="Production-linked incentive schemes and minimum local-content requirements.",
        impact_channel=(
            "Shifts the economics of importing versus localising, which in turn "
            "changes a programme's FX exposure profile."
        ),
        direction="Incentive available -> localisation accelerates -> FX exposure falls",
        effort="high",
        example="India's PLI scheme for auto components changed the make-versus-import calculus for several categories.",
        sources=(Source("Ministry of Heavy Industries (India)", "free", "Ad hoc", "On publication"),),
        status=STATUS_ROADMAP,
    ),
    Driver(
        id="carbon_pricing",
        name="Carbon pricing and border adjustment",
        group="Regulatory & compliance",
        description="Emissions trading prices and carbon border adjustment mechanisms.",
        impact_channel=(
            "Adds cost to carbon-intensive inputs - steel, aluminium, glass - and "
            "to exports into jurisdictions operating a border adjustment."
        ),
        direction="Carbon price rises -> steel and aluminium input cost rises",
        effort="high",
        example="EU CBAM adds reporting and eventually cost to imported steel and aluminium content.",
        sources=(
            Source("EU ETS price (EEX)", "free", "Daily", "Same day"),
            Source("EU CBAM registry", "free", "Quarterly", "Months"),
        ),
        status=STATUS_ROADMAP,
    ),
]

# --------------------------------------------------------------------------- #
# 9. Part and engineering
# --------------------------------------------------------------------------- #

ENGINEERING: List[Driver] = [
    Driver(
        id="part_characteristics",
        name="Part characteristics",
        group="Part & engineering",
        description="Weight, dominant material, complexity tier and category classification.",
        impact_channel=(
            "Sets the baseline cost structure and determines which commodity a "
            "part is exposed to. A steel bracket and a semiconductor sensor of "
            "identical value respond to entirely different drivers."
        ),
        direction="Determines which input cost drivers apply and in what proportion",
        effort="low",
        example="Material composition decides whether a part tracks steel, copper or polymer.",
        sources=(Source("Customer part master / BOM", "customer", "Static", "Internal"),),
        status=STATUS_IMPLEMENTED,
        feature_prefixes=("material", "weight_kg", "complexity_tier", "category_code"),
    ),
    Driver(
        id="engineering_changes",
        name="Engineering change notices",
        group="Part & engineering",
        description="Design changes affecting material, process or tolerance.",
        impact_channel=(
            "A direct, discrete repricing event. ECNs are the single most common "
            "cause of a price change that no market driver can explain."
        ),
        direction="ECN issued -> renegotiated piece price at implementation",
        effort="medium",
        example="A tolerance tightening that forces an added machining operation raises piece cost immediately.",
        sources=(Source("Customer PLM / ECN system", "customer", "Continuous", "Internal"),),
        status=STATUS_ROADMAP,
    ),
    Driver(
        id="tooling_amortisation",
        name="Tooling amortisation schedule",
        group="Part & engineering",
        description="Remaining tooling cost recovered through piece price.",
        impact_channel=(
            "Amortisation completing produces a known, dated step down in piece "
            "price - fully predictable if the schedule is available."
        ),
        direction="Amortisation completes -> step down in piece price",
        effort="low",
        example="A part fully amortised at 200k units drops in price at that cumulative volume.",
        sources=(Source("Customer tooling register", "customer", "Static", "Internal"),),
        status=STATUS_ROADMAP,
    ),
]

# --------------------------------------------------------------------------- #
# 10. Commercial
# --------------------------------------------------------------------------- #

COMMERCIAL: List[Driver] = [
    Driver(
        id="contract_terms",
        name="Contract structure and repricing cadence",
        group="Commercial",
        description="Agreement type, repricing frequency, escalation clauses and cost-down commitments.",
        impact_channel=(
            "Determines when any input cost move is allowed to reach price. A "
            "vendor on an annual reset absorbs six months of commodity movement "
            "that a quarterly vendor passes on immediately."
        ),
        direction="Longer reset -> slower, lumpier pass-through",
        effort="low",
        example="Quarterly-reset vendors show FX pass-through roughly two quarters ahead of annual-reset vendors.",
        sources=(Source("Customer contract repository", "customer", "Static", "Internal"),),
        status=STATUS_IMPLEMENTED,
        feature_prefixes=("vendor_reprice_months",),
    ),
    Driver(
        id="payment_terms",
        name="Payment terms and working capital",
        group="Commercial",
        description="Days payable and any early-payment discount structure.",
        impact_channel=(
            "Extended terms shift financing cost onto the supplier, who prices it "
            "back in. The saving is usually smaller than the price increase."
        ),
        direction="Longer payment terms -> supplier financing cost -> higher piece price",
        effort="low",
        example="Moving from 60 to 120 day terms typically returns as a piece-price increase.",
        sources=(Source("Customer ERP", "customer", "Monthly", "Internal"),),
        status=STATUS_ROADMAP,
    ),
    Driver(
        id="negotiation_calendar",
        name="Negotiation and cost-down calendar",
        group="Commercial",
        description="Scheduled annual negotiations and committed year-on-year cost-down targets.",
        impact_channel=(
            "Produces predictable, dated step changes. Much of the observable "
            "price movement in a mature programme is calendar-driven rather than "
            "market-driven."
        ),
        direction="Negotiation round -> committed cost-down applied on the effective date",
        effort="low",
        example="A committed 3% annual cost-down applied each April is fully predictable from the calendar.",
        sources=(Source("Customer purchasing calendar", "customer", "Annual", "Internal"),),
        status=STATUS_ROADMAP,
    ),
]


ALL_DRIVERS: List[Driver] = (
    CURRENCY + COMMODITIES + GEOPOLITICAL + LOGISTICS + MACRO
    + DEMAND + SUPPLIER + REGULATORY + ENGINEERING + COMMERCIAL
)

GROUP_ORDER = [
    "Currency & financial",
    "Commodities & raw materials",
    "Geopolitical & trade",
    "Logistics & supply chain",
    "Macro-economic",
    "Demand & programme",
    "Supplier",
    "Regulatory & compliance",
    "Part & engineering",
    "Commercial",
]


def build_parameter_catalogue(
    feature_columns: Sequence[str] = (),
) -> Dict[str, object]:
    """Return the driver catalogue, with implementation status verified.

    Any driver declaring ``feature_prefixes`` is marked ``implemented`` only if
    a matching feature is genuinely present in the trained model. A driver that
    claims to be live but has no corresponding feature is demoted to
    ``available`` and logged - the catalogue should never overstate what the
    model actually uses.
    """
    features = list(feature_columns)
    drivers: List[Dict[str, object]] = []
    demoted: List[str] = []

    for driver in ALL_DRIVERS:
        payload = driver.as_dict()

        if driver.feature_prefixes:
            matched = [
                f for f in features
                if any(f.startswith(prefix) for prefix in driver.feature_prefixes)
            ]
            if matched:
                payload["status"] = STATUS_IMPLEMENTED
                payload["matchedFeatures"] = sorted(matched)[:8]
                payload["matchedFeatureCount"] = len(matched)
            elif driver.status == STATUS_IMPLEMENTED and features:
                payload["status"] = STATUS_AVAILABLE
                demoted.append(driver.id)

        drivers.append(payload)

    if demoted:
        logger.warning(
            "%d driver(s) declared implemented but no matching feature was found "
            "in the model; demoted to 'available': %s",
            len(demoted),
            ", ".join(demoted),
        )

    counts = {
        status: sum(1 for d in drivers if d["status"] == status)
        for status in (STATUS_IMPLEMENTED, STATUS_AVAILABLE, STATUS_ROADMAP)
    }
    free_sources = sum(
        1 for d in drivers for s in d["sources"] if s["access"] == "free"
    )

    logger.info(
        "parameter catalogue: %d drivers across %d groups (%d implemented, "
        "%d available, %d roadmap); %d free data sources referenced",
        len(drivers),
        len(GROUP_ORDER),
        counts[STATUS_IMPLEMENTED],
        counts[STATUS_AVAILABLE],
        counts[STATUS_ROADMAP],
        free_sources,
    )

    return {
        "groups": GROUP_ORDER,
        "drivers": drivers,
        "counts": counts,
        "total": len(drivers),
        "note": (
            "Implementation status is verified against the model's actual feature "
            "list, so this catalogue cannot claim a driver is live once it has "
            "been removed. Impact channels, sources and effort grades are curated "
            "domain knowledge, not pipeline output."
        ),
    }
