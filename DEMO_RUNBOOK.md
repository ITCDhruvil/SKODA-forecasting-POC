# Demo Runbook — Car Parts Price Forecasting POC

**Hold this during the demo.** Numbers below are from the current build; if you
re-run the pipeline they may shift slightly, so re-check the headline three.

---

## Before you walk in (15 minutes)

| # | Action | Why |
|---|---|---|
| 1 | On the **venue network**, run `python -m price_forecasting.pipeline --stage source` | Warms the BLS + ECB cache. If the venue blocks these, you find out now, not on stage. |
| 2 | `cd dashboard && npm run dev` | Leave it running. Do not rebuild during the demo. |
| 3 | Open every tab once: Dashboard, Hierarchy, FX Impact, Future Test, Validation, Data Source, Technical FAQ | Warms the render and confirms nothing is broken. |
| 4 | Open the **Parameters** modal once and close it | Confirms it opens clean. |
| 5 | Set browser zoom to 90%, window maximised | The dashboard is dense; 100% clips the wider tables. |

**Do not run a full pipeline live.** It takes ~45 minutes at 480 parts.

---

## The three numbers to memorise

> **₹283K of spend is forecast to rise more than 5%. 62% of that sits with four vendors.**

> **On real published data, our models lost to the naive baseline — 0.336% vs 1.400% MAPE.**

> **We're at 72% of the theoretically achievable accuracy. Only 0.62 percentage points of real headroom remain.**

---

## Running order — 12 minutes

### 1. Dashboard (45 sec) — orient, don't linger

Point at the **Spend At Risk** card and the red strip below.

> "₹283K of the basket is forecast to rise more than 5% over six months. 73 parts.
> And it isn't spread thin — 62% of that exposure sits with four vendors. Minda
> alone is a quarter of it."

Move on quickly. Don't walk the charts.

### 2. Parameters button (60 sec) — scope

Click **Parameters** in the header.

> "This is the full space of things that move component prices — 39 drivers across
> ten groups. Currency, commodities, geopolitics, logistics, regulation. We've
> built seven. The rest is catalogued so the extension path is explicit."

Expand **Geopolitical & trade**, click **Geopolitical risk / armed conflict**.

> "Conflict isn't a direct price driver — it's an upstream one. It moves currency,
> energy, freight and insurance at the same time. Ukraine moved palladium, neon,
> energy and harness supply from a single event. That's why it's worth modelling
> separately."

Close the modal.

### 3. Hierarchy (3 min) — **this is the money shot**

Expand **VW Taigun** → **Bosch India** → **Braking**.

> "Bosch supplies three categories on this one programme. Braking, Sensors,
> Electrical — each forecast separately, each with its own exposure. This is what
> you walk into a negotiation with."

Point at a part row.

> "Current price, forecast, the 80% interval, and a confidence flag. That flag is
> a signal-to-error ratio, not a probability — it tells you whether the predicted
> move is bigger than the model's own typical error. Most aren't. 301 of 480 parts
> are marked low, meaning don't act on the direction. We'd rather tell you that
> than sell you false precision."

### 4. FX Impact (2 min)

> "Real ECB rates. The rupee moved 20% against the euro over this window."

Scroll to the shock chart.

> "Shock FX ten percent and re-predict — the basket moves +1.7%, concentrated in
> electrical and lighting. Steel categories barely move on the direct channel but
> carry full commodity exposure, because a locally-bought steel coil is still
> priced off a USD benchmark."

Scroll to **Detectable vs Attributable**.

> "And here's where we'll be straight with you. The FX effect is detectable —
> signal-to-noise of 27. But it is *not* attributable, because over this window
> the rupee fell in 26 of 35 months, so the FX path correlates 0.92 with elapsed
> time. 'Prices rose because FX moved' and 'prices rose because time passed' are
> the same sentence in this data. No model separates them. That's a property of
> the sample, not of the estimator — and it's fixable with your history."

### 5. Validation (2 min) — **lead with the failure**

> "Every other number so far is measured against a synthetic panel. This tab is
> the only real-world accuracy claim we make."

> "We held out six months of actually-published BLS data, trained only on what
> came before, and scored against what really happened. No fitted model beat
> carrying the last value forward. Naive scored 0.336%. SARIMA scored 1.400% and
> its 80% interval contained none of the six actual values."

Pause here. Let it sit.

> "We're showing you that because these checks were built to be capable of
> failing. A model evaluation that only ever returns good news isn't an
> evaluation."

Scroll to the **Forecast Ledger**.

> "Twelve predictions, timestamped, for months BLS hasn't published yet. They
> can't be edited — a forecast you can revise after seeing the answer isn't a
> forecast. Come back in thirty days and grade us."

### 6. Future Test (60 sec)

> "Six months generated, hidden, forecast blind, then revealed. 2.20% MAPE, 40%
> better than the baseline. But the important number is the floor: the data
> contains irreducible noise worth 1.57%. A perfect model still scores that. So
> we're at 72% of achievable, with 0.62 points of real headroom — not the whole
> 2.2%."

### 7. Data Source (60 sec) — prove it's real

> "Three real sources, one synthetic layer, zero API keys."

**If the network is up**, run this in a terminal on screen:

```bash
python -m price_forecasting.pipeline --stage source
```

> "That just hit the US Bureau of Labor Statistics and the European Central Bank,
> live. Nothing here is mocked."

### 8. Technical FAQ (30 sec) — leave open, don't read

> "Twenty-eight questions your team will ask, pre-answered — model choice,
> parameters, validation, limitations. Every number pulled from the live pipeline
> output, so it can't drift from the code."

Scroll to the last question and let them read the title:
*"Why should we trust these numbers when the model failed several of your own tests?"*

---

## Likely questions and short answers

**"Is this real data?"**
Macro trend and FX are real and live. The part-level panel is synthetic because no
public source publishes piece prices per SKU per vendor. Replace it with your
purchase-order history and nothing else in the pipeline changes.

**"Why did your model lose to the naive baseline?"**
On the aggregate index, at this horizon, price indices behave close to random
walks — a well-documented result. That test is on the macro series. On the
part-level panel, where there's cross-sectional structure to learn, the model
beats the baseline by 40%.

**"How accurate will it be on our data?"**
Unknown, honestly. The transferable results are the methodology, the leakage
guarantees and the model ranking. Anyone quoting you an accuracy number before
seeing your data is guessing.

**"How long to production?"**
The pipeline is built. The gap is your data. Give us 24–36 months of purchase-order
history and we re-point the generator stage at it.

**"What's the biggest risk?"**
FX identification. It needs a window containing rate reversals, or commodity spot
prices added as separate inputs to decouple the channels. That's the first item on
the roadmap.

---

## If something breaks

| Problem | Do this |
|---|---|
| Dashboard won't load | `cd dashboard && npm run dev`. If the JSON is missing: `python -m price_forecasting.pipeline --stage export` |
| A tab shows "not run" | That section's payload is missing. Move on — do not debug live. |
| Numbers differ from this sheet | You re-ran the pipeline. Trust the screen, not this sheet. |
| No internet | Everything still works from cache. Skip the live-fetch moment in step 7. |

---

## Do not say

- ~~"The model predicts prices with 97% accuracy"~~ — that's on synthetic data, and it will be the first thing a technical reviewer takes apart.
- ~~"It accounts for geopolitical risk"~~ — it doesn't. It's catalogued, not built.
- ~~"73% chance of being right"~~ — there is no calibrated probability anywhere in this system. Say "signal-to-error ratio".

## Close on this

> "What we'd stand behind today is the methodology, the leakage guarantees, the
> honest characterisation of what can and can't be identified from a dataset —
> and a system that tells you when it doesn't know. What we need from you is the
> purchase-order history. That's the whole gap."
