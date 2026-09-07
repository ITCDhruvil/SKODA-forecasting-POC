# Reasoning Simplification — Design

**Date:** 2026-09-07
**Status:** Approved for planning
**Scope label:** Architectural

## Problem

The dashboard's "reasoning" is spread across five surfaces (per-part *Why?*,
Geo scenario panel, Geo HITL panel, Technical FAQ, confidence blurbs). A
non-technical buyer cannot read it:

- The per-part reason restates the same 2–3 facts three times (`summary`,
  `story`, and each `drivers[].evidence`). `story` is a `" ".join(bits)`
  wall of text with no structure.
- The reason is **not** derived from the forecasting model. It is a parallel
  narrative hand-built in `export._reason_for_part` from exposure heuristics
  (`import_dep`, `localisation`, `material_intensity`) × mediator moves. It
  can and does contradict the forecast — real payload `TGN-LGT-00351`:
  `summary` says "mainly because of World risk (geopolitics)" while `story`
  says "Lower import share softens the geopolitics link".
- Numbers a buyer cannot interpret leak into the UI: `magnitude 17.488…`,
  `signalToErrorRatio 3.3`, `expectedErrorPct 3.009`, GPR moves as
  `+67.3%` (a z-score index, not a price), mediation `partialCorr 0.1404`.
- Econometrician vocabulary in the UI: mediator, exposure, channel,
  counterfactual shock, mediation diagnostic, event study, MoM.
- The Geo tab renders ~7 stacked reasoning cards, none behind disclosure.
- The confidence explainer paragraph is duplicated (DrillDownTree + FAQ).
- Provenance caveats ("checked against a live/cached feed", "offline backup
  series — verify before acting") repeat on every driver line.

## Goal

One reasoning engine, driven by the model's own feature attribution, with a
simple progressive-disclosure UI. The reason must reconcile to the forecast
by construction.

## Non-goals

- No new forecasting model. LightGBM was considered and rejected: same GBT
  family, ~noise-level accuracy delta on a synthetic panel, and the
  documented 19.5% win in this repo came from the target definition
  (log-return vs level), not the library. XGBoost already exposes native
  TreeSHAP.
- No MLOps platform work (serving API, drift monitors, CI/CD, retrain
  automation). Tracked separately.
- No real purchase-order data. This stays a synthetic POC; all honesty
  framing (BLS backtest lead, "naive wins on real data" insight) is kept.
- No frontend test runner (none exists today).

## Decisions locked during brainstorming

| # | Decision |
|---|---|
| Q1 | Reason source = **model feature attribution** (TreeSHAP), not a written narrative. |
| Q2 | **No LightGBM.** Keep XGBoost as the shipped model. |
| Q3 | Take the one real modelling upgrade: **XGBoost quantile intervals**, replacing the empirical residual-ratio bands. |
| Q4 | Scope **C**: per-part reason + portfolio reason + Geo tab consolidation (7 cards → 3). FAQ gets only the edits forced by mechanic changes. |
| Q5 | Momentum / lag / target-encoding contributions: **split visually (option B)** — external buckets prominent, trend + structural shown as one muted "starting point" line, full reconciling breakdown behind disclosure. |

---

## Section 1 — Architecture & data flow

New module: `src/price_forecasting/attribution.py`. Single responsibility:
turn the shipped XGBoost forecast into a signed, reconciling driver
breakdown per part.

```
forecasting.generate_forward_forecasts
  ├─ trains xgb_model, holds origin_rows (feature frame, one row/part)
  ├─ NEW: attribution.explain_forecasts(xgb_model, origin_rows, horizon)
  │      → booster.predict(DMatrix, pred_contribs=True)   # TreeSHAP, native to xgboost, no new dep
  │      → per part: per-feature contribution vector (log-return units) + bias term
  │      → group features into buckets (Section 2 map)
  │      → convert each bucket: log-return contribution → INR and %  (via origin price)
  │      → returns tidy DataFrame: part_id, bucket, contrib_pct, contrib_inr, direction
  └─ merged into forecasts; persisted to data/processed/attribution.parquet
```

`export.py` reads `attribution.parquet` instead of hand-building drivers.
`forecast_explain.py` becomes pure string formatting over the buckets. The
heuristic block in `export._reason_for_part` (exposure × mediator_moves) is
deleted.

**Key invariant:** per part, `sum(bucket_contribs) + bias ≈ predicted
log-return`. The reason cannot disagree with the number. The contradiction
bug is removed by construction, not patched.

Attribution is computed for the **shipped horizon only** (the dashboard's
`primary` = `forecasts[model == "xgboost"]` at `horizon.max()`), matching
what the UI displays.

## Section 2 — Bucket map

Grouping is by feature-name prefix. Interaction features (`_x_import`,
`_x_content`, `_x_mat`) belong to their parent channel.

| Bucket | Group | Feature prefixes / names |
|---|---|---|
| **FX** | external | `fx_eurinr_*`, `fx_usdinr_*` (incl. `_x_import`, `_x_content`) |
| **Sector inflation** | external | `macro_index`, `macro_mom_pct`, `macro_yoy_pct` |
| **Freight** | external | `freight_ret_*` (incl. `_x_import`) |
| **Material costs** | external | `material_intensity`, `cmd_steel_*`, `cmd_aluminium_*`, `cmd_copper_*`, `cmd_matched_*` |
| **Geopolitics** | external | `gpr_z_*`, `chokepoint_*`, `geo_event_*` |
| **Seasonality** | external | `month_sin`, `month_cos`, `month_of_year` |
| **Recent trend** | starting point | `price_lag_*`, `price_roll_*`, `price_mom_pct`, `price_yoy_pct`, `price_expanding_mean`, `price_vs_expanding_mean`, `months_since_start` |
| **Part / vendor structural** | starting point | `hier_*`, raw categoricals (project / vendor / category / material / complexity_tier / weight_kg / *_volume / project_localisation / vendor_import_dependency / vendor_reprice_months), bias term, `price_was_imputed`, `outlier_flag`, `insufficient_history` |

The bucket map is defined as an ordered list of `(bucket_name, group,
predicate)` in `attribution.py`. A test asserts every column returned by
`get_feature_columns()` matches exactly one bucket (unmapped feature = test
failure).

UI treatment (Q5 = B):
- **Prominent:** external buckets, ranked by `|contrib|`, max 3, under the
  heading "What's pushing it".
- **Muted:** the two starting-point buckets collapsed to one line —
  "Starting point: mostly carryover from an existing <up/down> trend."
- **Disclosure:** full signed table of all 8 buckets, reconciling to the
  forecasted %, behind "See full breakdown".

`true_*` betas are already excluded from features (ground truth). No change.

## Section 3 — Reason payload contract (`dashboard.json`)

`tree[].vendors[].categories[].parts[].reason`:

```jsonc
{
  "available": true,
  "headline": "Forecast +9.9% (+₹395). Mostly geopolitics and freight.",
  "direction": "up",
  "changePct": 9.9,
  "changeInr": 395,
  "drivers": [                       // external buckets only, |contrib| desc, max 3
    { "bucket": "Geopolitics", "direction": "up",   "sizePct": 6.1,  "sizeInr": 244, "weight": "large", "sourcesVerified": true  },
    { "bucket": "Freight",     "direction": "down", "sizePct": -1.8, "sizeInr": -72, "weight": "small", "sourcesVerified": false }
  ],
  "startingPoint": "Mostly carryover from an existing upward trend.",
  "trust": { "level": "high", "line": "Move is 3× the model's typical error — direction is worth acting on." },
  "breakdown": [                     // ALL 8 buckets; sum(sizePct) reconciles to changePct
    { "bucket": "Geopolitics",  "sizePct": 6.1 },
    { "bucket": "Recent trend", "sizePct": 4.0 }
    // ...
  ],
  "sourcesNote": "1 of 2 external drivers uses backup data — verify freight before acting."
}
```

Rules:
- `weight` = large / medium / small from `|contrib|` tertiles across that
  part's own buckets. Replaces raw `magnitude`.
- Every number pre-rounded in Python: `sizePct` 1 dp, `sizeInr` 0 dp,
  `trust` ratio 1 dp. Removes false precision.
- `sourcesVerified` per bucket = AND of `isReal` over that bucket's
  contributing mediator series. One `sourcesNote` per block, never per line.
- `startingPoint` composed from the two structural buckets' net direction
  and share.
- Removed keys: `summary`, `story`, `tip`, `causalityNote`. The causality
  disclaimer becomes a static UI constant, not per-part payload.

Portfolio version — `geoAnalysis.hitl.forecastDrivers` — takes the
**identical shape** (`headline`, `direction`, `drivers`, `startingPoint`,
`trust` omitted, `breakdown`, `sourcesNote`), built by the same code with
bucket contributions averaged across all parts and `changeInr` as portfolio
mean.

## Section 4 — `forecast_explain.py` + `export.py`

**`forecast_explain.py`** (~175 → ~60 lines). Remove
`explain_part_forecast`, `_driver_plain`, `_source_plain`, `_dir_word`'s
provenance coupling. New single entry point:

```python
def build_reason(
    *,
    change_pct: float,
    change_inr: float,
    direction: str,
    buckets: list[BucketContribution],   # from attribution.parquet
    trust_level: str,
    expected_error_ratio: float,
) -> dict: ...
```

Pure, deterministic, offline templating:
- top ≤3 external buckets → `headline` + `drivers`
- two structural buckets → `startingPoint`
- `trust_level` + ratio → `trust.line` (plain wording, no "signal-to-error
  ratio" phrase in the sentence itself)
- `sourcesNote` from per-bucket `sourcesVerified`

**`export.py`** — `_reason_for_part` shrinks to a lookup into
`attribution.parquet` + a `build_reason(...)` call (~10 lines). Delete
`_push`, the `candidates` list, the `mediator_moves` exposure arithmetic,
and now-unused imports (`CATEGORY_MATERIAL_INTENSITY`, `MATERIAL_COMMODITY`
— verify no other caller first). Portfolio builder in the geo/HITL export
path calls the same `build_reason` with aggregated buckets.

## Section 5 — Edge cases

- **SARIMA-fallback / thin-history parts** (no XGBoost feature row):
  `reason.available = false`,
  `headline = "Not enough history for a driver breakdown — this
  forecast is a trend and seasonality projection only."` No fabricated
  drivers.
- **Reconciliation guard:** `attribution.explain_forecasts` asserts
  `abs(sum(bucket_contribs) + bias - predicted_log_return) < 1e-6` per part.
  On mismatch: log a warning and set that part's `reason.available = false`
  rather than ship inconsistent math.
- **Tiny moves:** `abs(changePct) < 0.15` → `headline = "Forecast roughly
  flat."`, `drivers = []`, UI skips the driver list.
- **Bug fold-in 1 (contradiction):** resolved — the headline driver is the
  largest actual contributor.
- **Bug fold-in 2 (false precision):** resolved — all payload numbers
  rounded at export.

## Section 6 — Quantile intervals

`modeling.py::GlobalXGBModel` gains an optional interval head. Per horizon,
one additional booster:

```python
XGBRegressor(objective="reg:quantileerror", quantile_alpha=[0.1, 0.5, 0.9], ...)
```

- Point forecast still comes from the existing mean / log-return booster —
  unchanged, so every current point-accuracy number holds.
- `predict_interval(frame, h) -> (lower, upper)` from the q0.1 / q0.9 heads,
  reconstructed to price level identically to point forecasts
  (`price[t] * exp(q)` under `log_return`).
- `forecasting.py`: for **xgboost** rows only, replace
  `point * band["lower_ratio"]` / `upper_ratio` with the quantile bands.
  SARIMA keeps analytic intervals; seasonal-naive keeps NaN.
- `evaluation.py`: keep `extrapolate_intervals` + `interval_ratios` — still
  used to score coverage, and as a fallback when quantile heads produce
  crossing quantiles (widen-and-warn; never ship `upper < lower`).
- Config additions:
  - `modeling.interval_mode: quantile | empirical_ratio` (default `quantile`)
  - `modeling.interval_quantiles: [0.1, 0.9]`
- Dashboard payload: no shape change (`lower` / `upper` already present).
- FAQ "Are the prediction intervals trustworthy?" rewritten to report the
  measured empirical coverage of the new quantile bands.

## Section 7 — Frontend

New directory `dashboard/src/components/reason/`:

- **`ReasonBlock.tsx`** — renders the Section-3 payload:
  header `headline` → external `drivers` rows (`bucket · ↑/↓ ·
  large/med/small · sizeInr`) → muted `startingPoint` line →
  `<ConfidenceHint>` → collapsed `<details>` "See full breakdown"
  (`breakdown` as a signed bar list reconciling to `changePct`) → footer
  `sourcesNote`. Prop `variant: "part" | "portfolio"` (portfolio hides
  `trust`).
- **`ConfidenceHint.tsx`** — trust line + level pill. Single source of the
  confidence wording. Delete the duplicated paragraph in `DrillDownTree`
  and the copy the FAQ inlines.

Wiring:
- `DrillDownTree.tsx::PartRow` — replace the ~70-line inline reason `<div>`
  (summary / story / tip / drivers / causalityNote) with
  `<ReasonBlock reason={part.reason} variant="part" />`. The "Why?" toggle
  is unchanged.
- `GeoHitlPanel.tsx` — the "Why prices moved" block becomes
  `<ReasonBlock reason={drivers} variant="portfolio" />`.
- `types.ts` — `Reason` type updated to the Section-3 shape;
  `TreePart.reason` and `GeoHitlBlock.forecastDrivers` reference it.
- De-jargon Geo UI strings: mediator → "market factor", counterfactual
  shock → "what-if", event study → "past episode", "MoM" → "month over
  month".

## Section 8 — Geo tab consolidation (`GeoScenarioPanel.tsx`)

7 cards → 3:

1. **Analyst review queue** — `GeoHitlPanel` queue + alert cards, behaviour
   unchanged.
2. **Why prices moved this month** — shared `<ReasonBlock variant="portfolio">`.
3. **`<details>` "Method & diagnostics"** (collapsed) — holds, content
   verbatim, headings reworded: framework layers, mediation diagnostic,
   event-studies chart, counterfactual bars + roll-up table, mediator
   provenance. One plain-language intro sentence. Nothing deleted — demoted
   from 5 always-open cards to one opt-in section.

`App.tsx` `TITLES.geo.subtitle` reworded to plain language.

## Section 9 — Testing

- **`tests/test_attribution.py`** (new):
  - reconciliation: `sum(bucket_contribs) + bias ≈ predicted log-return`
    for every part
  - bucket map covers every `get_feature_columns()` column (unmapped =
    fail)
  - SARIMA-only / thin-history part → `available = false`
  - tiny move → flat headline, no drivers
  - determinism: seeded run → byte-identical reason strings
- **`tests/test_smoke.py`** (extend):
  - every `dashboard.json` `reason` matches the new schema; no `story` /
    `tip` / `causalityNote` keys remain anywhere
  - quantile bands: `lower < point < upper`, relative width widens with
    horizon
- **Frontend:** no test runner exists; none added. Manual verification via
  `preview_start` — Hierarchy "Why?" expansion and the Geo tab.
- Full `python -m price_forecasting.pipeline --stage all` run + visual
  check before the work is called done.

## Files touched

**Python**
- `src/price_forecasting/attribution.py` — new
- `src/price_forecasting/forecast_explain.py` — rewrite (~175 → ~60 lines)
- `src/price_forecasting/export.py` — `_reason_for_part` gutted, portfolio
  reason path rerouted
- `src/price_forecasting/forecasting.py` — call attribution; quantile bands
  for xgboost rows
- `src/price_forecasting/modeling.py` — `GlobalXGBModel` interval head,
  `predict_interval`
- `src/price_forecasting/evaluation.py` — quantile-band coverage scoring;
  ratio fallback
- `src/price_forecasting/config.py` + `config.yaml` — `interval_mode`,
  `interval_quantiles`
- `src/price_forecasting/pipeline.py` — persist `attribution.parquet` (if a
  stage wiring change is needed)
- `tests/test_attribution.py` — new; `tests/test_smoke.py` — extended

**Frontend**
- `dashboard/src/components/reason/ReasonBlock.tsx` — new
- `dashboard/src/components/reason/ConfidenceHint.tsx` — new
- `dashboard/src/components/DrillDownTree.tsx` — PartRow reason block swap,
  drop duplicated confidence paragraph
- `dashboard/src/components/GeoHitlPanel.tsx` — reason block swap
- `dashboard/src/components/GeoScenarioPanel.tsx` — 7 → 3 cards, Method
  disclosure
- `dashboard/src/components/FaqPanel.tsx` — intervals answer rewrite;
  confidence answer points at shared wording
- `dashboard/src/App.tsx` — geo subtitle
- `dashboard/src/types.ts` — `Reason` type

## Open risks

- **TreeSHAP interaction attribution.** `pred_contribs=True` gives main
  effects only (no pairwise `pred_interactions`). Interaction features like
  `fx_*_x_import` carry their own contribution row and are bucketed with
  their parent channel, so this is fine — noted so the plan does not reach
  for `pred_interactions` (slow, unneeded).
- **Structural buckets may dominate.** On a strongly trending part, "Recent
  trend" can exceed every external bucket. Q5 = B handles this: the muted
  line will read "mostly carryover", which is the honest answer. No code
  branch needed beyond the wording template.
- **Quantile crossing** at short horizons on thin data — handled by the
  widen-and-warn fallback to empirical ratios.
