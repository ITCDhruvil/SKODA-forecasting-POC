# Automotive Spare Parts — Monthly Price Forecasting (POC)

End-to-end proof of concept for forecasting monthly prices of automotive spare
parts: data sourcing, synthetic panel generation anchored on real price data,
leak-free feature engineering, statistical and ML forecasting, honest
evaluation, and a generated report.

## Quick start

```bash
pip install -r requirements.txt
pip install -e .          # src/ layout, so the package needs installing
python -m price_forecasting.pipeline --config config.yaml --stage all
```

Or without installing, by pointing Python at `src/`:

```bash
# PowerShell
$env:PYTHONPATH="src"; python -m price_forecasting.pipeline --stage all
# bash
PYTHONPATH=src python -m price_forecasting.pipeline --stage all
```

Outputs land in:

| Path | Contents |
|---|---|
| `reports/report.md` | Full summary report with metrics and figures |
| `reports/dataset_audit.md` | The dataset search and why it concluded as it did |
| `reports/figures/` | Six PNG figures |
| `data/raw/parts_prices.csv` | Generated price panel |
| `data/processed/forecasts.csv` | Forward forecasts with intervals |

Individual stages can be run alone — each caches its output:

```bash
python -m price_forecasting.pipeline --stage source      # fetch BLS anchor
python -m price_forecasting.pipeline --stage generate    # build the panel
python -m price_forecasting.pipeline --stage preprocess  # clean + features
python -m price_forecasting.pipeline --stage evaluate    # holdout + backtest
python -m price_forecasting.pipeline --stage forecast    # forward forecasts
python -m price_forecasting.pipeline --stage report      # figures + report
```

```bash
python -m pytest tests/ -q
```

## Dashboard

React + TypeScript + Tailwind app in `dashboard/`. It reads a single
`dashboard.json` written by the pipeline's `export` stage — no server, no CORS,
and **no hardcoded figures anywhere in the UI**, so it cannot drift away from
what the pipeline actually produced.

```bash
python -m price_forecasting.pipeline --stage all   # writes dashboard/public/dashboard.json
cd dashboard
npm install
npm run dev        # http://localhost:5173
```

Six views: **Dashboard** (KPIs, forecast vs actual, category mix, top movers,
horizon bars, alerts), **Forecast** (model comparison + backtest stability),
**Parts**, **Validation**, **Alerts**, and **Data Source**.

## Hierarchical model: project → vendor → category → part

### Data structure

One row per (part, month). Every record carries the full hierarchy, the part's
characteristics, the FX rates prevailing at purchase time, and the price:

| Group | Columns |
|---|---|
| **Project** | `project_code`, `project`, `oem`, `segment`, `project_volume`, `project_localisation` |
| **Vendor** | `vendor_code`, `vendor`, `vendor_origin`, `vendor_import_dependency`, `vendor_reprice_months` |
| **Category** | `category_code`, `category`, `material` |
| **Part** | `part_id`, `complexity_tier`, `weight_kg`, `annual_part_volume` |
| **FX** | `fx_eurinr`, `fx_usdinr` (rate at purchase) |
| **Target** | `price` (INR) |
| **Ground truth** | `true_eur_beta`, `true_usd_beta`, `true_fx_lag` — *excluded from features* |

6 vehicle programmes (SKODA Kushaq/Slavia/Kylaq, VW Taigun/Virtus, plus the CKD
SKODA Kodiaq as a deliberate high-FX-exposure outlier) × 20 tier-1 vendors ×
10 categories. Vendors are constrained to categories they credibly supply, so
the vendor dimension carries real signal rather than noise.

### How FX reaches a price — two channels

```
price[p,t] = base[p] × project_factor × vendor_factor
           × macro[t]              # REAL BLS index
           × fx_multiplier[p,t]    # REAL ECB rates, lagged & elasticity-weighted
           × seasonal × trend × noise × break
```

**Direct (EUR/INR — import invoicing).** The part or a sub-assembly is bought in
euros. Scaled by vendor import dependency, damped by project localisation.

**Indirect (USD/INR — commodity).** Steel, copper and oil-linked polymers are
priced off USD benchmarks *even when bought domestically*. **Not** damped by
localisation — which is exactly why the two channels are separate. A fully
localised fastener has ~0 direct exposure but full steel exposure.

Localisation is applied per-category, not uniformly: a programme reaches 95%
localisation by localising steel and plastics, so the content that stays
imported is precisely the semiconductor-heavy categories.

| Category | EUR beta | USD beta |
|---|---|---|
| Sensors | **0.144** | 0.152 |
| Electrical | 0.077 | 0.166 |
| Fasteners | 0.0002 | **0.211** |
| Body Stampings | 0.0004 | **0.229** |

Pass-through is **lagged 2–6 months** (contracts reprice quarterly; inventory
buffers absorb the first shock) and **partial** (vendors absorb 18–38% in margin).

### Interpreting predictions at each level

`--stage fxscenario` rolls the part-level model up each dimension:

- **Project** — programme cost trajectory. Kodiaq (CKD, 35% localised) tops the
  6-month roll-up at **+1.74%** vs VW Virtus at **+0.39%**.
- **Vendor** — negotiation priority. Lumax **+4.71%** vs Subros **−2.15%**.
- **Category** — hedging priority. Electrical **+5.69%** vs HVAC **−2.83%**.

### FX scenarios, and an honest limitation

Shocking FX and re-predicting gives the response for positive shocks:

| shock | basket | implied pass-through |
|---|---|---|
| +2% | +1.05% | 0.53 |
| +5% | +1.56% | 0.31 |
| +10% | +1.73% | 0.17 |

Correctly signed and monotone increasing, but **saturating** — and negative
shocks are incoherent (−10% → −0.23%, −2% → +0.23%). Both are the tree
extrapolation limit: a shocked feature moves outside the training range where
trees are flat.

**The deeper limitation, measured rather than assumed:**

```
FX cumulative path vs elapsed time     r = 0.92
EURINR vs USDINR (levels)              r = 0.93
BLS macro index vs USDINR              r = 0.90
EURINR vs USDINR (monthly returns)     r = 0.12   ← the only independent variation
```

Over a window where the rupee depreciated in 26 of 35 months, **FX is not
separable from the time trend**. "Prices rose because FX moved" and "prices rose
because time passed" are the same statement in this data. This is why only
stationary FX *returns* are exposed as features — levels are trend proxies — and
why exposure is identified **cross-sectionally** (in a given month, high-import
vendors must move more than domestic ones) rather than over time.

The pipeline reports this directly. `validate_fx_learning` correlates the
model's revealed category exposure against the generator's true betas:
**Spearman 0.54 — "partial" recovery.** Ordering is partly right, not reliably.

Note the distinction the diagnostics make, because it is easy to conflate:
`fx_signal_to_noise` says the effect is **detectable** (SNR 27);
`fx_trend_collinearity` says it is **not attributable** (r = 0.92). Both are
true. Separating FX properly needs a window containing reversals, or currencies
that genuinely diverge — not a longer run of the same monotonic trend.

## Simulated-future test (`--stage futuretest`)

Generates `future_test_months` beyond the normal history, hides them, trains every
model on the visible part only, forecasts blind, then reveals and scores per
horizon.

```
model            MAE     RMSE    MAPE     bias    worst month
xgboost        $2.184   $3.767   2.20%   +0.06%   Nov 2026 (2.48%)
sarima         $2.345   $3.794   2.51%   +0.33%   Nov 2026 (2.88%)
seasonal_naive $3.655   $6.489   3.58%   -2.72%   Nov 2026 (4.06%)
```

Error grows with horizon as it should: h1 1.67% → h6 2.46%.

### The extrapolation fix

**Gradient-boosted trees cannot extrapolate.** A tree predicts the mean of a
training leaf, so every prediction is bounded by the largest target seen in
training. On an upward-trending price series the model structurally undershoots
once reality climbs past that ceiling, and the bias grows with horizon. The
symptom was visible on the holdout chart: predictions never rose above ~$96.5
while actuals reached $98.25, with the worst gap (−2.95%) in March.

Fix: predict `log(price[t+h] / price[t])` instead of the level. That target is
stationary; the level is reconstructed as `price[t] × exp(prediction)` and is
unbounded above. Switchable via `modeling.xgboost_target_mode`.

| target mode | MAPE | bias |
|---|---|---|
| `level` | 2.726% | +0.48% |
| **`log_return`** | **2.195%** | **+0.06%** |

**19.5% lower error, bias cut ~8×**, and it flipped the ranking — XGBoost now
beats SARIMA.

### How low *can* the error go?

The generator injects AR(1) noise with known parameters, so a portion of every
future price is unpredictable by construction. That gives a hard floor:

| | value |
|---|---|
| irreducible floor | **1.57% MAPE** |
| achieved | 2.20% MAPE |
| efficiency | **72% of the best attainable** |
| real headroom | 0.62pp |

So per-part error is close to optimal, not "too high" — most of that 2.2% is
noise nobody could forecast.

**The aggregate line is a different question.** Idiosyncratic noise averages out
across 320 parts, so the mean-price line carries a noise band of only ~0.11%.
Any visible gap there is *systematic* model error, not sampling noise, and
remains worth fixing.

## Is the model actually right? (real-data validation)

This is the only part of the project that makes a real-world accuracy claim.
Everything else is scored against the synthetic panel, which proves the pipeline
recovers a known generative process but says nothing about reality.

Two mechanisms, both in `src/price_forecasting/validation.py`:

1. **Real-series backtest** — hold out the last 6 *actually published* BLS
   months, fit only on what preceded them, score against what really happened.
   Back-extrapolated months are excluded; validating against our own
   reconstruction would be circular.
2. **Forward forecast ledger** (`data/processed/forecast_ledger.json`) — records
   each forward forecast with the date it was made. Re-running `--stage validate`
   after a BLS release automatically scores any entry whose month has since
   published. Existing entries are never overwritten: a forecast you can revise
   after seeing the outcome is not a forecast.

```bash
python -m price_forecasting.pipeline --stage validate   # re-run monthly
```

### The result, stated plainly

**On real BLS data, no fitted model beat carrying the last value forward.**

| model | MAPE (real published data) |
|---|---|
| **naive (last value)** | **0.336%** |
| drift | 0.625% |
| sarima | 1.400% |

SARIMA over-predicted all six months, and its 80% prediction interval contained
**none** of them. The real index is near-flat and mean-reverting, so a random
walk is genuinely the right model for it at this horizon — a well-known result
for aggregate price indices.

This directly contradicts the synthetic evaluation, where SARIMA (2.53% MAPE)
comfortably beat seasonal-naive (5.07%). That contrast is the most useful thing
in this repo: **synthetic benchmarks rank models against the process you
invented, not against reality.** The dashboard leads with this finding rather
than the flattering one.

## Why the data looks like this

**No public dataset provides monthly prices per automotive SKU.** The search is
documented in `reports/dataset_audit.md`. In short: Kaggle's automotive parts
datasets are cross-sectional (attributes → one price, no date column); Hyndman's
`carparts` panel is intermittent *demand*, not price; FRED has suitable index
series but was unreachable from this environment.

The BLS public API *does* serve real monthly automotive price indices with no API
key — but only at **industry-aggregate level**.

So this POC uses a **hybrid**: the real BLS CPI series for Motor Vehicle Parts
and Equipment (`CUUR0000SETC`) drives the trend, and a synthetic SKU layer
supplies the per-part structure — category seasonality, idiosyncratic drift,
autocorrelated noise, structural breaks — that no public source offers.

The boundary is stated rather than blurred: **the inflation path is real, the
per-part variation around it is simulated.**

If the BLS API is unreachable the pipeline falls back to a synthetic inflation
curve and flags that prominently in every output, so an offline run is never
mistaken for a grounded one.

## Design decisions

**36 months of history, not 12.** The brief asked for a year. A seasonal SARIMA
with a 12-month cycle cannot be identified from 12 observations — it needs at
least two full cycles — and an 80/20 split on 12 points leaves ~9 training rows.
History is 36 months; the dataset overview and category figures still headline
the most recent 12.

**One global XGBoost, not 320 per-part models.** Each series has only 36 points,
far too few for a per-part ML model. Pooling gives ~11.5k rows and lets shared
structure be learned once. The trade-off — losing part-specific idiosyncrasy —
is exactly what the per-part SARIMA comparator recovers.

**Direct multi-horizon, not recursive.** One model per horizon *h*, each mapping
features at *t* to price at *t+h*. Recursive forecasting would regenerate lag
features from its own predictions, compounding error through a fragile feedback
path.

**A seasonal-naive baseline is mandatory.** Without `price[t+h] = price[t+h-12]`
to compare against, an impressive MAPE says nothing about whether the modelling
added value. The report states plainly if a model fails to beat it.

**Outliers are flagged, not removed.** Three of the four injected anomalies are
permanent level shifts; smoothing them away would erase the robustness test they
exist to provide.

## Structure

```
config.yaml                    every tunable; no hardcoded values in modules
src/price_forecasting/
  config.py                    typed config loading + cross-field validation
  logging_utils.py             logging setup, version banner
  data_sourcing.py             BLS API fetch, cache, fallback, audit artifact
  data_generation.py           synthetic SKU panel anchored on the BLS index
  preprocessing.py             cleaning, outlier flags, leak-free features
  modeling.py                  seasonal naive, per-part SARIMA, global XGBoost
  evaluation.py                metrics, holdout, rolling-origin backtest
  forecasting.py               forward forecasts with prediction intervals
  visualization.py             six report figures
  report.py                    renders reports/report.md
  pipeline.py                  CLI orchestrator
tests/test_smoke.py            leakage, determinism, metric and guard tests
```

## The leakage guarantee

Every feature stamped month *t* uses only information available at *t*: window
operations are trailing, never centred, and all are grouped by `part_id`.
Training rows are filtered on **target month**, not feature month — a row at the
training boundary with h=6 has its target six months later, inside the test
window.

`tests/test_smoke.py` asserts this two ways: perturbing the final month, and
perturbing an interior month (which is what catches backward-fill leaks). The
second test exists because it found a real one.

## Known limitations

Detailed in section 7 of the generated report. The important ones: the SKU layer
is synthetic, so absolute error figures describe recovery of a known generative
process rather than real-world performance — the *relative ranking* of models is
the transferable result. Prediction intervals are measurably optimistic. There is
no changepoint detection; models survive structural breaks rather than detecting
them.
