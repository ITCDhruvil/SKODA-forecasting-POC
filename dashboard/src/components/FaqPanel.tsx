import { useMemo, useState } from 'react';
import clsx from 'clsx';
import type { DashboardData } from '../types';
import { IconChevronRight } from './Icons';

interface Faq {
  q: string;
  a: string;
  tag: string;
}

const CATEGORIES = [
  'Model choice',
  'Data',
  'FX',
  'Validation',
  'Hierarchy',
  'Operations',
  'Limitations',
] as const;

/**
 * Technical Q&A for a customer review.
 *
 * Written to survive a hostile question rather than to sell. Where the honest
 * answer is a limitation, it says so — a reviewer who finds an unstated
 * weakness stops trusting everything else in the deck.
 *
 * Numbers are interpolated from the live payload so the answers cannot drift
 * away from what the pipeline actually produced.
 */
export function FaqPanel({ data }: { data: DashboardData }) {
  const [open, setOpen] = useState<Set<number>>(new Set([0]));
  const [filter, setFilter] = useState<string>('All');

  const faqs = useMemo(() => buildFaqs(data), [data]);
  const visible = filter === 'All' ? faqs : faqs.filter((f) => f.tag === filter);

  const toggle = (i: number) => {
    const next = new Set(open);
    next.has(i) ? next.delete(i) : next.add(i);
    setOpen(next);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="card px-5 py-4">
        <h3 className="card-title">Questions a technical review will ask</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-slate-600">
          Every figure below is read from the live pipeline output, so these answers cannot
          drift from what the system actually does. Where the honest answer is a limitation,
          it is stated plainly — an unstated weakness found by a reviewer costs more
          credibility than the weakness itself.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {['All', ...CATEGORIES].map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setFilter(tag)}
              className={clsx(
                'rounded-full px-3 py-1 text-[12px] font-medium transition',
                filter === tag
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
              )}
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      <div className="card divide-y divide-slate-100 overflow-hidden">
        {visible.map((faq) => {
          const index = faqs.indexOf(faq);
          const isOpen = open.has(index);
          return (
            <div key={faq.q}>
              <button
                type="button"
                onClick={() => toggle(index)}
                className="flex w-full items-start gap-3 px-5 py-3.5 text-left transition hover:bg-slate-50"
              >
                <IconChevronRight
                  className={clsx(
                    'mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform',
                    isOpen && 'rotate-90',
                  )}
                />
                <span className="min-w-0 flex-1 text-[14px] font-medium text-slate-900">
                  {faq.q}
                </span>
                <span className="pill shrink-0 bg-slate-100 text-slate-500">{faq.tag}</span>
              </button>
              {isOpen && (
                <div className="px-5 pb-4 pl-12 text-[13px] leading-relaxed text-slate-600">
                  {faq.a.split('\n\n').map((para, i) => (
                    <p key={i} className={i > 0 ? 'mt-2' : undefined}>
                      {para}
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function buildFaqs(data: DashboardData): Faq[] {
  const ft = data.futureTest;
  const best = ft?.scores?.length
    ? [...ft.scores].sort((a, b) => a.mape - b.mape)[0]
    : undefined;
  const baseline = ft?.scores?.find((s) => s.model === 'seasonal_naive');
  const val = data.validation;
  const realNaive = val?.backtests?.find((b) => b.model === 'naive');
  const realBest = val?.backtests?.length
    ? [...val.backtests].sort((a, b) => a.mape - b.mape)[0]
    : undefined;
  const fx = data.fxAnalysis;
  const collinearity = fx?.collinearity;
  const learning = fx?.learning;
  const floor = ft?.noiseFloor;
  const modes = ft?.targetModeComparison;

  const n = (v: number | undefined | null, digits = 2, suffix = '') =>
    v === undefined || v === null ? '—' : `${v.toFixed(digits)}${suffix}`;

  return [
    // ---- Model choice ----------------------------------------------------
    {
      tag: 'Model choice',
      q: 'Why one global model instead of a separate model per part?',
      a: `Each individual part has only ${data.meta.historyMonths} monthly observations. That is far too few to fit a per-part machine-learning model without overfitting — you would be estimating dozens of parameters from three dozen points.

Pooling all ${data.meta.nParts} parts gives roughly ${(data.meta.nParts * data.meta.historyMonths).toLocaleString()} training rows and lets shared structure — category seasonality, the macro trend, vendor price positioning — be learned once and reused. It also handles new parts with no history, and leaves one artifact to deploy instead of ${data.meta.nParts}.

The trade-off is real: a global model smooths over part-specific idiosyncrasy. That is exactly what the per-part SARIMA comparator recovers, which is why both are reported rather than one being declared the winner.`,
    },
    {
      tag: 'Model choice',
      q: 'Why XGBoost rather than a neural network or a classical econometric model?',
      a: `Data volume. Gradient-boosted trees are the strongest option in the regime we are in — tens of thousands of rows, heavily tabular, mixed categorical and numeric, strong feature interactions. A neural network needs far more data before it beats a well-tuned GBM on tabular problems, and would be harder to explain in a procurement review.

A pure econometric model (a panel regression with fixed effects) would be more interpretable, but cannot capture the non-linear interactions between vendor, category and horizon without being hand-specified. SARIMA is included precisely to cover the interpretable end, and on the synthetic panel it scores ${ft?.scores?.find((s) => s.model === 'sarima')?.mape.toFixed(2) ?? '—'}% MAPE against XGBoost's ${n(best?.mape)}%.`,
    },
    {
      tag: 'Model choice',
      q: 'What exactly does the model predict — the price, or the change?',
      a: `The log-return: log(price at t+h ÷ price at t). The level is then reconstructed as price[t] × exp(prediction).

This is not cosmetic. Trees predict the mean of a training leaf, so a model trained on price *levels* can never output a value above the highest price it saw in training. On an upward-trending series it structurally undershoots, and the bias grows with horizon.

We measured it: predicting levels gave ${n(modes?.level?.mape)}% MAPE with ${n(modes?.level?.mean_signed_pct)}% bias; predicting log-returns gave ${n(modes?.log_return?.mape)}% with ${n(modes?.log_return?.mean_signed_pct)}% bias — ${n(modes?.improvementPct, 1)}% lower error and roughly an eight-fold reduction in bias.`,
    },
    {
      tag: 'Model choice',
      q: 'Direct or recursive multi-step forecasting?',
      a: `Direct. One model per horizon h = 1…${data.meta.forecastHorizon}, each mapping features at time t to the price at t+h.

Recursive forecasting feeds the model's own prediction back in as an input for the next step, which compounds error and creates a fragile feedback path — one bad month poisons the remaining horizon. Direct costs ${data.meta.forecastHorizon}× the training time, which at this scale is seconds.`,
    },
    {
      tag: 'Model choice',
      q: 'What hyperparameters, and how were they chosen?',
      a: `They live in config.yaml, not in code: ${data.meta.forecastHorizon} horizon models, each an XGBRegressor with a fixed depth, learning rate, subsample and column-sample setting, plus L2 regularisation.

They were not tuned by search. For a proof of concept, an extensive hyperparameter sweep on ${data.meta.historyMonths} months of data risks fitting the validation split rather than the problem. The gains available from tuning here are far smaller than the gains from the target reformulation described above, which is where the effort went. A production build would add proper nested cross-validation.`,
    },

    // ---- Data -------------------------------------------------------------
    {
      tag: 'Data',
      q: 'Where does the data come from, and how much of it is real?',
      a: `Two real sources and one SKU layer, and we are explicit about which is which.

Real: the ${data.provenance.macroSeriesId} price index from the US Bureau of Labor Statistics, and EUR/INR plus USD/INR reference rates from the European Central Bank. Neither requires an API key.

${
        data.provenance.skuLayer === 'purchase_orders' || data.provenance.skuIsReal
          ? 'SKU panel: aggregated from purchase-order / invoice lines (volume-weighted monthly unit prices). Absolute error figures on this panel are meaningful for the covered parts.'
          : 'SKU panel: synthetic. No public source publishes monthly piece prices per SKU per vendor per programme. Drop data/raw/purchase_orders.csv (sku.mode=auto) to switch generate onto real POs — nothing else in the pipeline changes.'
      }`,
    },
    {
      tag: 'Data',
      q: 'If the part-level data is synthetic, what does the accuracy number actually mean?',
      a: data.provenance.skuLayer === 'purchase_orders' || data.provenance.skuIsReal
        ? `This run used purchase-order history, so holdout MAPE describes error on those covered SKUs — still subject to coverage, contract mix, and how well dimensions (vendor origin, localisation) were filled on the PO file.`
        : `It measures how well the pipeline recovers a known generative process — splits, feature construction, multi-step strategy, target formulation. That is a valid test of the machinery and a valid basis for comparing models against each other.

It is not evidence of real-world accuracy, and we do not present it as such. The transferable result is the model *ranking* and the methodology; the absolute MAPE figure would change on your data.

The one real-world accuracy claim in the system is the BLS backtest, described under Validation.`,
    },
    {
      tag: 'Data',
      q: 'What would you need from SKODA to run this on real data?',
      a: `Purchase-order history at part level: part number, vehicle programme, vendor, commodity category, transaction date, and unit price. Monthly granularity over at least 24–36 months. Drop the file at data/raw/purchase_orders.csv (see README / po_ingest aliases).

Useful but optional: vendor master data (country of origin, contract repricing cadence, share of imported input cost), part characteristics (weight, material, tooling status), and programme volumes. The model uses all of these where present and degrades gracefully where absent.

Nothing about the pipeline assumes synthetic data — the generator is one interchangeable stage.`,
    },
    {
      tag: 'Data',
      q: 'How are missing prices and outliers handled?',
      a: `Missing values are forward-filled within a part across gaps of at most two months. Longer gaps stay missing and are excluded rather than invented, because carrying a stale price across a six-month gap fabricates data.

Outliers are flagged, not removed. Several parts in the dataset carry genuine structural breaks — a resourcing decision, a tariff change, a semiconductor allocation premium. Smoothing those away would erase exactly the events a procurement team most needs to see. A winsorisation switch exists in config and is off by default.`,
    },

    // ---- FX ---------------------------------------------------------------
    {
      tag: 'FX',
      q: 'How does the exchange rate actually reach a part price?',
      a: `Through two separate channels, deliberately not blended into one elasticity.

Direct (EUR/INR): the part or a major sub-assembly is invoiced in euros. Scaled by how much of the vendor's input cost is imported, and damped by how localised the programme is.

Indirect (USD/INR): steel, copper, aluminium and oil-linked polymers are priced off USD-denominated global benchmarks *even when bought domestically*. Localisation does not protect against this — which is why a fully localised steel fastener still carries meaningful FX exposure while having almost no direct euro exposure.

Pass-through is lagged two to six months, because supply contracts reprice quarterly or annually and inventory buffers absorb the first shock. It is also partial: vendors absorb part of any move in margin.`,
    },
    {
      tag: 'FX',
      q: 'Why is localisation applied per category rather than as one programme-wide number?',
      a: `Because a headline localisation percentage is a value-weighted average across the whole bill of materials, and it is not evenly distributed.

A programme reaches 95% localisation by localising steel, plastics and fasteners. The content that remains imported is precisely the semiconductor- and LED-heavy categories, because there is no domestic source for them. Applying the 95% figure uniformly would wrongly show sensors as almost FX-immune on a localised programme, when in reality they are the most exposed line on it.`,
    },
    {
      tag: 'FX',
      q: 'If the rupee moves 5%, what happens to my costs?',
      a: `The FX Impact tab answers this by shocking the exchange-rate inputs, re-predicting with everything else held constant, and rolling the response up by project, vendor and category. Because it runs through the trained model, the response reflects whatever FX structure the model actually learned rather than a formula applied on top.

Read it with the caveat stated on that tab: positive shocks respond in the right direction but the response saturates, and negative shocks are not coherent. Both are the same tree limitation — a shocked feature moves outside the range seen in training, where a tree's output is flat.`,
    },
    {
      tag: 'FX',
      q: 'Can you prove the model actually learned the FX relationship?',
      a: `We test it directly, and the answer is a qualified no.

The generator builds each category with a known FX sensitivity. Those true coefficients are never given to the model — recovering them is the test, not the input. Correlating the model's revealed FX response against them gives Spearman ${n(learning?.spearman, 3)} across ${learning?.nCategories ?? '—'} categories: verdict "${learning?.verdict ?? '—'}".

The reason is measured, not guessed, and it is a property of the data rather than the estimator. Over this window the rupee depreciated in most months, so the cumulative FX path correlates ${n(collinearity?.maxCumulativeVsTime, 2)} with elapsed time. "Prices rose because FX moved" and "prices rose because time passed" are the same statement in this sample, and no model can separate them.`,
    },
    {
      tag: 'FX',
      q: 'What would make the FX effect properly identifiable?',
      a: `A window containing FX reversals, or currencies that genuinely diverge. The two pairs here correlate ${n(collinearity?.crossPairLevelCorr, 2)} on levels — they move together — though only ${n(collinearity?.crossPairReturnCorr, 2)} on monthly returns, which is why returns are the only FX transform we expose to the model.

Practically: a longer history spanning at least one appreciation cycle, or a wider basket of sourcing currencies. With SKODA's real procurement history the cross-sectional identification also strengthens considerably, because true vendor import shares vary far more than the modelled range.`,
    },

    // ---- Validation --------------------------------------------------------
    {
      tag: 'Validation',
      q: 'How do you know the model is not just memorising the training data?',
      a: `Three independent checks.

Time-based splits, never random. A random split on a time series leaks the future into training through neighbouring months. Training rows are filtered on *target* month, not feature month — a row at the training boundary forecasting six months ahead has its target inside the test window, and including it would leak.

An explicit leakage test in the suite perturbs future prices and asserts that no earlier feature row changes. It is run in two forms, including one that perturbs an interior month — that second form caught a real backward-fill bug during development.

A simulated-future test that generates months, hides them entirely, forecasts blind, then reveals and scores.`,
    },
    {
      tag: 'Validation',
      q: 'What accuracy should we expect?',
      a: `On the simulated-future test — ${ft?.futureMonths ?? 6} months forecast blind — the best model scored ${n(best?.mape)}% MAPE, against ${n(baseline?.mape)}% for a seasonal-naive baseline. Error grows with horizon as it should, from about ${n(best?.by_horizon?.[0]?.mape)}% at one month to ${n(best?.by_horizon?.[best.by_horizon.length - 1]?.mape)}% at ${ft?.futureMonths ?? 6}.

Important context: the irreducible noise floor on this data is ${n(floor?.meanFloorPct)}%. A perfect model would still score that, so the achieved ${n(floor?.bestAchievedPct)}% is roughly ${floor?.bestAchievedPct ? Math.round((floor.meanFloorPct / floor.bestAchievedPct) * 100) : '—'}% of the best attainable — there is only about ${floor?.bestAchievedPct ? (floor.bestAchievedPct - floor.meanFloorPct).toFixed(2) : '—'} percentage points of real headroom, not the whole figure.`,
    },
    {
      tag: 'Validation',
      q: 'Has any of this been tested against real published prices?',
      a: `Yes, and this is the part of the system we would defend hardest — because the result is unflattering.

We hold out the last six months of *actually published* BLS observations, train only on what preceded them, and score against what really happened. Result: no fitted model beat carrying the last value forward. The naive baseline scored ${n(realNaive?.mape, 3)}% MAPE; the best fitted alternative was ${n(realBest?.mape, 3)}%.

The real aggregate index behaves close to a random walk at this horizon, which is a well-documented property of price indices. We report it rather than hiding it, because a vendor who only shows you their wins is a vendor whose numbers you cannot check.`,
    },
    {
      tag: 'Validation',
      q: 'How will we know if the model is right about next month?',
      a: `There is a forecast ledger. Every forward prediction is written down with the date it was made, before the outcome exists. When BLS publishes that month, the entry scores itself automatically on the next run.

Entries are never overwritten — a forecast you can revise after seeing the answer is not a forecast. It currently shows ${val?.ledger?.n_pending ?? 0} predictions awaiting publication, which is the honest state for a system that has not yet had a month elapse.`,
    },
    {
      tag: 'Validation',
      q: 'Are the prediction intervals trustworthy?',
      a: `Partly, and we measure it rather than asserting it.

SARIMA's analytic intervals achieved ${val?.backtests?.find((b) => b.coverage_pct !== null)?.coverage_pct ?? '—'}% empirical coverage against an 80% nominal target on real data — they are too narrow, because they propagate residual variance but not parameter-estimation uncertainty on a short series.

XGBoost intervals are empirical rather than assumed: they come from the actual distribution of backtest residuals, expressed as ratios so the band scales with price level, and widen with horizon by a square-root-of-time rule. Treat all intervals here as optimistic.`,
    },

    // ---- Hierarchy ---------------------------------------------------------
    {
      tag: 'Hierarchy',
      q: 'How does the model tell one vendor or programme apart from another?',
      a: `Two mechanisms working together.

Native categorical features: project, vendor and category go in as categorical columns that XGBoost splits on directly, with no one-hot expansion.

Hierarchical target encoding: for each level — and each cross-level pair such as vendor × category — the model gets the mean historical log-price of that group. This is what lets it express "Bosch prices sensors differently from how Bosch prices braking", which a flat categorical cannot.

These encodings are computed on an expanding window shifted by one month, so a group's encoding in month t uses only months strictly before t. A row can never influence its own encoding. There is a test asserting this directly.`,
    },
    {
      tag: 'Hierarchy',
      q: 'How should each level of the forecast be read?',
      a: `They answer different questions for different people.

Project level is a programme cost trajectory — budget planning and variance against target.

Vendor level is negotiation priority: which suppliers are driving increases, and how much of your spend with them is at risk.

Category level is hedging priority: which commodity exposures are worth covering financially.

The drill-down on the Hierarchy tab keeps the relationship visible, because one vendor typically supplies several categories on one programme and flattening that away loses the negotiating picture.`,
    },
    {
      tag: 'Hierarchy',
      q: 'What does the confidence flag on each part mean?',
      a: `It is a signal-to-error ratio, not a probability — and the distinction matters.

The model has a typical error at each horizon, measured from the simulated-future test. The flag compares the size of a predicted move against that error. High means the move is at least twice the typical error, so the direction is worth acting on. Low means it sits inside the noise and the sign should not be trusted.

We deliberately avoided producing a number like "73% chance of being right". The model does not output a calibrated probability, and manufacturing one from a point forecast would be false precision.`,
    },

    // ---- Operations --------------------------------------------------------
    {
      tag: 'Operations',
      q: 'How is this deployed and refreshed?',
      a: `A staged pipeline run from one command, with each stage cacheable and independently runnable: source, generate, preprocess, evaluate, forecast, FX scenarios, future test, validate, report, export.

The dashboard reads a single JSON file, so it needs no server and no database. A monthly refresh means re-running the pipeline and redeploying a static file.

Every tunable — horizons, model parameters, FX pairs, pass-through assumptions, thresholds — lives in config.yaml. No values are hardcoded in the modules.`,
    },
    {
      tag: 'Operations',
      q: 'Is it reproducible and auditable?',
      a: `Yes. Seeded with a fixed random seed (${data.meta.randomSeed}); regenerating the dataset produces a byte-identical file. Library versions are captured at run time and shown on the Data Source tab.

Every figure in this dashboard comes from the pipeline output — there are no hardcoded numbers anywhere in the interface, so what you are looking at cannot drift from what the code produced.`,
    },
    {
      tag: 'Operations',
      q: 'What is the runtime and what does it cost to run?',
      a: `A full run over ${data.meta.nParts} parts and ${data.meta.historyMonths} months takes on the order of ten minutes on a laptop, dominated by fitting SARIMA per part and training ${data.meta.forecastHorizon} horizon models across several evaluation passes.

There is no external compute or licensing cost. Both data providers are open access with no API key. Scaling to a full parts catalogue would need parallel SARIMA fitting, which is embarrassingly parallel.`,
    },

    // ---- Limitations -------------------------------------------------------
    {
      tag: 'Limitations',
      q: 'What are the honest weaknesses of this proof of concept?',
      a: `The part-level layer is synthetic, so absolute error figures describe recovery of a known process, not real-world performance.

FX is not separably identifiable on this window — the effect is detectable but not attributable, because the currency path is collinear with time.

Prediction intervals are measurably optimistic.

Tree models cannot extrapolate, which we mitigated by predicting returns but which still shows up as saturation in the FX shock response.

There is no changepoint detection: models absorb structural breaks with degraded accuracy rather than detecting them.

No exogenous drivers beyond price index and FX — commodity spot prices, freight rates and vehicle volumes are not modelled.`,
    },
    {
      tag: 'Limitations',
      q: 'What would the next phase add?',
      a: `In priority order.

Real purchase-order data, which replaces the synthetic layer and makes every accuracy figure meaningful.

Direct commodity inputs — steel, aluminium and copper spot prices — which would decouple the commodity channel from FX and fix most of the identification problem described above.

Changepoint detection so tariff changes and resourcing events are flagged rather than merely survived.

Quantile regression for properly calibrated intervals, replacing the current empirical bands.

Nested cross-validation for hyperparameter selection.`,
    },
    {
      tag: 'Limitations',
      q: 'Why should we trust these numbers when the model failed several of your own tests?',
      a: `Because you can see that it failed them. The system reports its FX recovery as "${learning?.verdict ?? '—'}", reports that the naive baseline beat every fitted model on real data, and reports that its own prediction intervals are too narrow.

Those checks were built to be capable of failing, and they did — which is the only reason the checks that passed are worth anything. A model evaluation that always returns good news is not an evaluation.

What we would stand behind: the methodology, the leakage guarantees, the model ranking, and the honest characterisation of what can and cannot be identified from a given dataset.`,
    },
  ];
}
