# Automotive Component Price Forecasting — Proof of Concept

**Prepared for:** SKODA / VW India technical review
**Status:** Working proof of concept, end to end
**Scope of this document:** what was built, what it found, and what is required next

---

## 1. What this is

A working system that forecasts spare-part prices monthly, organised the way a
purchasing organisation actually works: **project → vendor → category → part**,
with foreign exchange as a modelled cost driver.

It is a proof of concept, not a product. The pipeline, models, validation and
interface are complete and reproducible; the part-level price history is
simulated because that data exists only inside OEM purchasing systems.

---

## 2. Headline findings

### Commercial

**₹283K of the modelled basket is forecast to rise more than 5% over six months**
— 73 of 480 parts. Critically, that exposure is **concentrated**: 62% of it sits
with four vendors, and Minda Industries alone accounts for 24%.

Concentration is the actionable part. Exposure spread thinly across forty
suppliers is a market problem; exposure sitting with four is a negotiation.

### Technical

| Finding | Detail |
|---|---|
| Model accuracy (simulated future) | **2.20% MAPE**, 40% better than a seasonal-naive baseline |
| Distance from theoretical best | **72% of achievable** — irreducible noise is 1.57%, leaving 0.62pp of real headroom |
| Accuracy on **real** published data | **No fitted model beat the naive baseline** (0.336% vs 1.400%) |
| FX effect | **Detectable** (SNR 27) but **not attributable** (r = 0.92 with time trend) |

The third and fourth rows are the ones worth reading twice. They are reported
because the validation was built to be capable of failing, and did.

---

## 3. What is real and what is simulated

| Layer | Status | Source |
|---|---|---|
| Macro price trend | **Real** | US BLS, Motor Vehicle Parts index (`CUUR0000SETC`) |
| EUR/INR exchange rate | **Real** | European Central Bank |
| USD/INR exchange rate | **Real** | European Central Bank |
| Part-level price history | **Simulated** | Generated to specification |

Both real sources are public and require **no API key or licence**.

The part layer is simulated because no public source publishes monthly piece
prices per SKU per vendor per programme. It is replaced by customer
purchase-order history in deployment, and no other stage of the pipeline changes.

**Consequence, stated plainly:** absolute accuracy figures measure how well the
system recovers a known process. They are not a prediction of real-world
performance. The transferable results are the methodology, the leakage
guarantees and the relative ranking of models.

---

## 4. How FX reaches a part price

Two channels, modelled separately because they behave differently:

**Direct — import invoicing (EUR/INR).** The part or a sub-assembly is bought in
euros. Scaled by vendor import dependency, damped by programme localisation.

**Indirect — commodity (USD/INR).** Steel, copper, aluminium and oil-linked
polymers are priced off USD benchmarks *even when bought domestically*.
Localisation does **not** protect against this.

That distinction matters commercially: a fully localised steel fastener has
almost zero direct FX exposure but full commodity exposure. Blending the two into
one elasticity would show it as protected when it is not.

Pass-through is **lagged two to six months** (contracts reprice quarterly or
annually; inventory buffers absorb the first shock) and **partial** (vendors
absorb 18–38% in margin).

---

## 5. What the model does not do

Stated deliberately — an unstated limitation found by a reviewer costs more
credibility than the limitation itself.

1. **The part-level layer is synthetic.** Accuracy figures are not real-world claims.
2. **FX is not separably identifiable** on this window. The rupee fell in 26 of 35 months, so the FX path is collinear with the time trend. Fixable with a longer window or commodity spot prices as separate inputs.
3. **Prediction intervals are measurably optimistic** — 67% empirical coverage against an 80% nominal target.
4. **Tree models cannot extrapolate.** Mitigated by predicting returns rather than levels, but it still shows as saturation in FX shock scenarios.
5. **No changepoint detection.** Structural breaks are survived with degraded accuracy, not detected.
6. **Only two exogenous drivers.** Commodity spot prices, freight rates and vehicle volumes are catalogued but not built.

---

## 6. The parameter roadmap

**39 drivers catalogued across 10 groups. 7 are implemented.**

| Group | Drivers | Live |
|---|---|---|
| Currency & financial | 4 | 1 |
| Commodities & raw materials | 5 | 0 |
| Geopolitical & trade | 5 | 0 |
| Logistics & supply chain | 4 | 0 |
| Macro-economic | 4 | 1 |
| Demand & programme | 4 | 2 |
| Supplier | 4 | 1 |
| Regulatory & compliance | 3 | 0 |
| Part & engineering | 3 | 1 |
| Commercial | 3 | 1 |

Each entry carries its impact channel, named data providers, update frequency,
publication latency, and an integration effort grade. **48 of the referenced
sources are free.**

Highest-value additions, in order:

1. **Commodity spot prices** (steel, aluminium, copper) — decouples the commodity channel from FX and resolves most of the identification problem
2. **Container freight rates** — direct landed-cost component, free daily source available
3. **Customs duty notifications** — discrete, dated, knowable in advance
4. **Geopolitical risk index** — upstream driver that moves currency, energy and freight together

---

## 7. What is required from SKODA

**Essential:** purchase-order history at part level — part number, programme,
vendor, category, transaction date, unit price. Monthly, 24–36 months.

**Valuable:** vendor master data (origin, import share, contract cadence), part
characteristics (weight, material, tooling status), programme volumes.

Nothing in the pipeline assumes synthetic data. The generator is one
interchangeable stage.

---

## 8. Engineering quality

- **29 automated tests**, including two explicit data-leakage assertions
- **Time-based splits only**; training rows filtered on target month, not feature month
- **Reproducible**: fixed seed, byte-identical regeneration, library versions captured per run
- **No hardcoded values** — every tunable in `config.yaml`; no figure hardcoded in the interface
- **Runtime**: full pipeline ~45 minutes on a laptop; no external compute or licence cost

Two defects were found and fixed by these checks during development: a
backward-fill data leak (caught by the interior-perturbation leakage test) and an
extrapolation bias in the model target (fixed by predicting log-returns, which cut
error 19.5% and reduced bias eight-fold).

---

## 9. Recommendation

The methodology is sound and the engineering is production-shaped. The binding
constraint is data, not modelling.

**Proposed next phase:** a 6–8 week engagement against real purchase-order
history, adding commodity spot prices and freight rates, delivering a validated
accuracy figure on SKODA's own data — and a forecast ledger that can be scored
month by month rather than taken on trust.

---

*All figures generated by the pipeline described. Reproduce with:*
`python -m price_forecasting.pipeline --stage all`
