import { useState } from 'react';
import clsx from 'clsx';
import {
  Bar,
  BarChart,
  Cell,
  CartesianGrid,
  Line,
  ComposedChart,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { FxAnalysis } from '../types';
import { formatSigned } from '../lib/format';
import { IconAlert, IconCheck, IconTrending } from './Icons';

const LEVELS = [
  { id: 'category', label: 'Category' },
  { id: 'vendor', label: 'Vendor' },
  { id: 'project', label: 'Project' },
];

/**
 * FX scenario analysis.
 *
 * Shocks the FX inputs, re-predicts with everything else held constant, and
 * rolls the response up the hierarchy. Because the model is a single global
 * estimator, the shock propagates through whatever FX structure it actually
 * learned — this is not a formula applied on top of the forecast.
 *
 * The diagnostics below the scenarios matter as much as the scenarios: they say
 * whether the FX response can be trusted at all on this data.
 */
export function FxScenarioPanel({ fx }: { fx?: FxAnalysis }) {
  const scenarios = fx?.scenarios ?? [];
  const [level, setLevel] = useState('category');

  // Gate on actual content rather than an `available` flag. A payload written
  // by an earlier pipeline version may predate the flag entirely, and refusing
  // to render data that is plainly present would be a worse failure than
  // trusting it.
  if (!fx || scenarios.length === 0) {
    return (
      <div className="card p-6">
        <h3 className="text-[15px] font-semibold text-slate-900">
          FX scenario analysis not run
        </h3>
        <p className="mt-1 text-sm text-slate-600">Generate it with:</p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-[12px] text-slate-100">
          python -m price_forecasting.pipeline --stage fxscenario{'\n'}
          python -m price_forecasting.pipeline --stage export
        </pre>
      </div>
    );
  }

  const sorted = [...scenarios].sort((a, b) => a.shockPct - b.shockPct);
  const largest = sorted[sorted.length - 1];
  const levelRows = largest.byLevel?.[level] ?? [];
  const learning = fx.learning;
  const collinearity = fx.collinearity;
  const snr = fx.signalToNoise;
  const provenance = fx.provenance;

  return (
    <div className="flex flex-col gap-4">
      {/* ---- FX provenance ------------------------------------------------ */}
      {provenance?.pairs?.length ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {provenance.pairs.map((pair) => (
            <div key={pair.pair} className="card px-5 py-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-[13px] font-medium text-slate-600">
                    {pair.base}/{pair.quote}
                  </div>
                  <div className="mt-1 text-[24px] font-bold leading-none text-slate-900">
                    {pair.lastRate.toFixed(2)}
                  </div>
                </div>
                <span
                  className={clsx(
                    'pill',
                    pair.isReal ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700',
                  )}
                >
                  {pair.isReal ? 'real ECB' : 'fallback'}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs">
                <span
                  className={clsx(
                    'font-semibold',
                    pair.totalMovePct >= 0 ? 'text-red-600' : 'text-emerald-600',
                  )}
                >
                  {formatSigned(pair.totalMovePct, 2)}
                </span>
                <span className="text-slate-500">
                  over the window &middot; from {pair.firstRate.toFixed(2)}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* ---- Shock response ----------------------------------------------- */}
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Price Response to an FX Shock</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              A positive shock means the rupee weakens, so imported input costs rise
            </p>
          </div>
        </div>

        <div className="px-2 pb-2">
          <ResponsiveContainer width="100%" height={250}>
            <ComposedChart
              data={sorted.map((s) => ({
                label: `${s.shockPct > 0 ? '+' : ''}${s.shockPct}%`,
                response: s.overallPriceChangePct,
                passThrough: s.impliedElasticity,
              }))}
              margin={{ top: 14, right: 20, left: 4, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: '#64748b' }}
                tickLine={false}
                axisLine={{ stroke: '#e2e8f0' }}
              />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 11, fill: '#64748b' }}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(v: number) => `${v.toFixed(1)}%`}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11, fill: '#94a3b8' }}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip
                cursor={{ fill: '#f8fafc' }}
                contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }}
                formatter={(value, name) => [
                  value == null
                    ? '--'
                    : name === 'response'
                      ? `${Number(value).toFixed(3)}%`
                      : Number(value).toFixed(3),
                  name === 'response' ? 'Basket change' : 'Implied pass-through',
                ]}
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />
              <ReferenceLine yAxisId="left" y={0} stroke="#94a3b8" />
              <Bar
                yAxisId="left"
                dataKey="response"
                name="Basket change"
                radius={[5, 5, 0, 0]}
                maxBarSize={48}
              >
                {sorted.map((s) => (
                  <Cell
                    key={s.name}
                    fill={s.overallPriceChangePct >= 0 ? '#dc2626' : '#059669'}
                  />
                ))}
              </Bar>
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="passThrough"
                name="Implied pass-through"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="border-t border-slate-200 bg-amber-50 px-5 py-2.5 text-[11px] leading-relaxed text-amber-800">
          <strong>Read this with care.</strong> Positive shocks respond in the right
          direction but the response <em>saturates</em>, and negative shocks are
          incoherent. Both are the tree-extrapolation limit: a shocked feature moves
          outside the training range, where a tree is flat.
        </div>
      </div>

      {/* ---- Response by hierarchy level ---------------------------------- */}
      <div className="card">
        <div className="card-header flex-wrap">
          <div>
            <h3 className="card-title">Where a {largest.name} Move Lands</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Same shock, broken down by {level}
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
            {LEVELS.filter((l) => (largest.byLevel?.[l.id]?.length ?? 0) > 0).map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setLevel(l.id)}
                className={clsx(
                  'rounded-md px-3 py-1.5 text-[13px] font-medium transition',
                  l.id === level
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900',
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-2 pb-4">
          <ResponsiveContainer width="100%" height={Math.max(200, levelRows.length * 26)}>
            <BarChart
              data={levelRows.map((r) => ({ name: r.name, changePct: r.changePct }))}
              layout="vertical"
              margin={{ top: 6, right: 36, left: 8, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: '#64748b' }}
                tickLine={false}
                axisLine={{ stroke: '#e2e8f0' }}
                tickFormatter={(v: number) => `${v.toFixed(1)}%`}
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 11, fill: '#475569' }}
                tickLine={false}
                axisLine={false}
                width={150}
              />
              <Tooltip
                cursor={{ fill: '#f8fafc' }}
                contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }}
                formatter={(value) => [
                  value == null ? '--' : `${Number(value).toFixed(3)}%`,
                  'Price response',
                ]}
              />
              <ReferenceLine x={0} stroke="#94a3b8" />
              <Bar dataKey="changePct" radius={[0, 5, 5, 0]} maxBarSize={20}>
                {levelRows.map((r) => (
                  <Cell key={r.name} fill={r.changePct >= 0 ? '#dc2626' : '#059669'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ---- Did the model learn FX? -------------------------------------- */}
      {learning?.available && (
        <div className="card p-5">
          <div className="flex items-start gap-3">
            {learning.verdict === 'recovered' ? (
              <IconCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            ) : (
              <IconAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            )}
            <div className="min-w-0 flex-1">
              <h3 className="text-[15px] font-semibold capitalize text-slate-900">
                FX structure: {learning.verdict}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-600">
                The generator built each category with a known FX sensitivity. Correlating
                the model's revealed response against those true betas gives{' '}
                <strong>Spearman {learning.spearman?.toFixed(3)}</strong> across{' '}
                {learning.nCategories} categories. The true betas are never features —
                recovering them is the test, not the input.
              </p>

              {learning.rows?.length ? (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-y border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-500">
                        <th className="py-1.5 pr-3 font-semibold">Category</th>
                        <th className="py-1.5 px-3 text-right font-semibold">True beta</th>
                        <th className="py-1.5 pl-3 text-right font-semibold">
                          Model response
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {learning.rows.map((row) => (
                        <tr key={row.category}>
                          <td className="py-1.5 pr-3 text-slate-800">{row.category}</td>
                          <td className="py-1.5 px-3 text-right tabular-nums text-slate-600">
                            {row.trueBeta.toFixed(4)}
                          </td>
                          <td className="py-1.5 pl-3 text-right tabular-nums text-slate-900">
                            {formatSigned(row.modelledChangePct, 3)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* ---- Why: detectable vs attributable ------------------------------- */}
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Detectable vs Attributable</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Two different questions that are easy to conflate
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 px-5 pb-5 lg:grid-cols-2">
          {snr?.available && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
              <div className="flex items-center gap-2">
                <IconTrending className="h-4 w-4 text-emerald-600" />
                <span className="text-[13px] font-semibold text-emerald-900">
                  Detectable — yes
                </span>
              </div>
              <div className="mt-2 text-[26px] font-bold leading-none text-slate-900">
                SNR {snr.snr}
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-slate-600">
                The most-vs-least exposed category differ by{' '}
                <strong>{snr.signalPct?.toFixed(2)}%</strong> in price, against{' '}
                <strong>{snr.categoryMeanNoisePct?.toFixed(3)}%</strong> of noise on a
                category mean. The effect is comfortably large enough to see.
              </p>
            </div>
          )}

          {collinearity?.available && (
            <div
              className={clsx(
                'rounded-lg border p-4',
                collinearity.separable
                  ? 'border-emerald-200 bg-emerald-50/50'
                  : 'border-red-200 bg-red-50/50',
              )}
            >
              <div className="flex items-center gap-2">
                <IconAlert
                  className={clsx(
                    'h-4 w-4',
                    collinearity.separable ? 'text-emerald-600' : 'text-red-600',
                  )}
                />
                <span
                  className={clsx(
                    'text-[13px] font-semibold',
                    collinearity.separable ? 'text-emerald-900' : 'text-red-900',
                  )}
                >
                  Attributable — {collinearity.separable ? 'yes' : 'no'}
                </span>
              </div>
              <div className="mt-2 text-[26px] font-bold leading-none text-slate-900">
                r = {collinearity.maxCumulativeVsTime}
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-slate-600">
                The cumulative FX path correlates{' '}
                <strong>{collinearity.maxCumulativeVsTime}</strong> with elapsed time. So
                "prices rose because FX moved" and "prices rose because time passed" are
                the same statement here — no estimator can separate them.
              </p>
            </div>
          )}
        </div>

        {collinearity?.byPair?.length ? (
          <div className="overflow-x-auto border-t border-slate-200">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-slate-50/60 text-left text-[10px] uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-2 font-semibold">Pair</th>
                  <th className="px-3 py-2 text-right font-semibold">
                    Cumulative vs time
                  </th>
                  <th className="px-5 py-2 text-right font-semibold">Rising months</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {collinearity.byPair.map((row) => (
                  <tr key={row.pair}>
                    <td className="px-5 py-2 font-medium text-slate-800">{row.pair}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-600">
                      {row.cumulativeVsTime.toFixed(3)}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums text-slate-600">
                      {row.risingMonthsPct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="border-t border-slate-200 bg-slate-50 px-5 py-3 text-[11px] leading-relaxed text-slate-600">
          Currency pairs correlate{' '}
          <strong>{collinearity?.crossPairLevelCorr}</strong> on levels but only{' '}
          <strong>{collinearity?.crossPairReturnCorr}</strong> on monthly returns — which
          is why only stationary returns are exposed as model features, and why exposure
          is identified across parts within a month rather than over time. Separating FX
          properly needs a window containing reversals, or currencies that genuinely
          diverge.
        </div>
      </div>

      {/* ---- Ground-truth exposure ---------------------------------------- */}
      {fx.trueExposure?.length ? (
        <div className="card overflow-hidden">
          <div className="card-header">
            <div>
              <h3 className="card-title">Designed FX Exposure by Category</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Two channels: direct import invoicing (EUR) and USD-benchmarked
                commodities
              </p>
            </div>
            <span className="pill bg-slate-100 text-slate-600">ground truth</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-y border-slate-200 bg-slate-50/60 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-2.5 font-semibold">Category</th>
                  <th className="px-3 py-2.5 font-semibold">Material</th>
                  <th className="px-3 py-2.5 text-right font-semibold">EUR beta</th>
                  <th className="px-3 py-2.5 text-right font-semibold">USD beta</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Total</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Lag</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {fx.trueExposure.map((row) => (
                  <tr key={row.code}>
                    <td className="px-5 py-2.5 font-medium text-slate-900">
                      {row.category}
                    </td>
                    <td className="px-3 py-2.5 text-slate-500">{row.material}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-blue-700">
                      {row.eurBeta.toFixed(4)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-amber-700">
                      {row.usdBeta.toFixed(4)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">
                      {row.totalBeta.toFixed(4)}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-slate-500">
                      {row.lagMonths}mo
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-slate-200 bg-slate-50 px-5 py-2.5 text-[11px] leading-relaxed text-slate-600">
            Steel-heavy categories carry almost no EUR exposure but full USD exposure:
            a locally-bought steel coil is still priced off a global benchmark, so
            localisation does not protect against it. That is why the two channels are
            modelled separately rather than blended into one elasticity.
          </div>
        </div>
      ) : null}
    </div>
  );
}
