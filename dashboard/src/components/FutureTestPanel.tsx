import clsx from 'clsx';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { FutureTest } from '../types';
import { formatCurrency, monthLabel } from '../lib/format';
import { IconBeaker, IconCheck } from './Icons';

/**
 * Simulated-future test: six months were generated, hidden, forecast blind,
 * then revealed and scored.
 *
 * Separate from the real-data validation panel on purpose. The hidden months
 * come from the same generative process as training, so this measures how well
 * each model recovers a known process at each horizon - a fair comparison
 * between models, but not a real-world accuracy claim.
 */
export function FutureTestPanel({ futureTest }: { futureTest?: FutureTest }) {
  // Guard against a dashboard.json written before this section existed. An
  // older payload is a normal state (the pipeline may not have re-exported
  // yet), so it must render a prompt rather than crash the whole view.
  if (!futureTest?.scores?.length) {
    return (
      <div className="card p-6">
        <h3 className="text-[15px] font-semibold text-slate-900">
          Simulated-future test not run
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          This dashboard payload has no future-test results yet. Generate them with:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-[12px] text-slate-100">
          python -m price_forecasting.pipeline --stage futuretest{'\n'}
          python -m price_forecasting.pipeline --stage export
        </pre>
      </div>
    );
  }

  const scores = [...futureTest.scores].sort((a, b) => a.mape - b.mape);
  const best = scores[0];
  const baseline = scores.find((s) => s.model === 'seasonal_naive');
  const comparison = futureTest.targetModeComparison;

  const horizonData = best.by_horizon.map((h) => ({
    label: monthLabel(h.target_month),
    horizon: `h${h.horizon}`,
    mape: h.mape,
    bias: h.mean_signed_pct,
  }));

  const modeData =
    comparison?.level && comparison?.log_return
      ? comparison.level.by_horizon.map((h, i) => ({
          label: `h${h.horizon}`,
          level: h.mape,
          log_return: comparison.log_return?.by_horizon[i]?.mape ?? null,
        }))
      : [];

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Verdict ------------------------------------------------------ */}
      <div className="card p-5">
        <div className="flex items-start gap-3">
          <IconBeaker className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-slate-900">
              {futureTest.futureMonths} months generated, hidden, forecast blind, then revealed
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">
              Models trained on data up to <strong>{monthLabel(futureTest.trainEnd ?? '')}</strong>{' '}
              only, then asked to forecast{' '}
              <strong>
                {monthLabel(futureTest.revealedRange?.[0] ?? '')} &ndash;{' '}
                {monthLabel(futureTest.revealedRange?.[1] ?? '')}
              </strong>{' '}
              across {futureTest.nParts} parts. Best model was{' '}
              <strong className="capitalize">{best.model}</strong> at{' '}
              <strong>{best.mape.toFixed(2)}% MAPE</strong>
              {baseline && best.model !== 'seasonal_naive' && (
                <>
                  {' '}
                  &mdash; {(((baseline.mae - best.mae) / baseline.mae) * 100).toFixed(1)}% better
                  than the seasonal-naive baseline.
                </>
              )}
            </p>
            <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-800">
              <strong>What this proves:</strong> {futureTest.disclaimer}
            </p>
          </div>
        </div>
      </div>

      {/* ---- Scorecard ---------------------------------------------------- */}
      <div className="card overflow-hidden">
        <div className="card-header">
          <div>
            <h3 className="card-title">Error Rate on the Revealed Months</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Bias is mean signed error &mdash; negative means the model under-predicts
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-y border-slate-200 bg-slate-50/60 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-5 py-2.5 font-semibold">Model</th>
                <th className="px-3 py-2.5 text-right font-semibold">MAE</th>
                <th className="px-3 py-2.5 text-right font-semibold">RMSE</th>
                <th className="px-3 py-2.5 text-right font-semibold">MAPE</th>
                <th className="px-3 py-2.5 text-right font-semibold">Bias</th>
                <th className="px-5 py-2.5 font-semibold">Worst month</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {scores.map((row, index) => (
                <tr key={row.model} className={index === 0 ? 'bg-emerald-50/40' : undefined}>
                  <td className="px-5 py-2.5 font-medium capitalize text-slate-900">
                    {row.model.replace(/_/g, ' ')}
                    {index === 0 && (
                      <span className="pill ml-2 bg-emerald-100 text-emerald-700">best</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                    {formatCurrency(row.mae, false)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                    {formatCurrency(row.rmse, false)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">
                    {row.mape.toFixed(2)}%
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <span
                      className={
                        Math.abs(row.mean_signed_pct) < 0.5
                          ? 'text-emerald-600'
                          : 'text-amber-600'
                      }
                    >
                      {row.mean_signed_pct >= 0 ? '+' : ''}
                      {row.mean_signed_pct.toFixed(2)}%
                    </span>
                  </td>
                  <td className="px-5 py-2.5 text-slate-600">
                    {monthLabel(row.worst_month)}{' '}
                    <span className="text-[11px] text-slate-400">
                      ({row.worst_month_mape.toFixed(2)}%)
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- Error growth with horizon ------------------------------------ */}
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">
              Error by Horizon &mdash; <span className="capitalize">{best.model}</span>
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              How fast accuracy decays the further ahead you forecast
            </p>
          </div>
        </div>
        <div className="px-2 pb-4">
          <ResponsiveContainer width="100%" height={244}>
            <ComposedChart data={horizonData} margin={{ top: 14, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: '#64748b' }}
                tickLine={false}
                axisLine={{ stroke: '#e2e8f0' }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#64748b' }}
                tickLine={false}
                axisLine={false}
                width={46}
                tickFormatter={(v: number) => `${v}%`}
              />
              <Tooltip
                cursor={{ fill: '#f8fafc' }}
                contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }}
                formatter={(value, name) => [
                  value == null ? '--' : `${Number(value).toFixed(2)}%`,
                  name === 'mape' ? 'MAPE' : 'Bias',
                ]}
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />
              <ReferenceLine y={0} stroke="#cbd5e1" />
              <Bar dataKey="mape" name="MAPE" fill="#2274a5" radius={[5, 5, 0, 0]} maxBarSize={44} />
              <Line
                type="monotone"
                dataKey="bias"
                name="Bias (signed)"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ---- How close is this to the best achievable? --------------------- */}
      {futureTest.noiseFloor && futureTest.noiseFloor.byHorizon.length > 0 && (
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Is the Error Rate Actually Too High?</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Achieved error against the irreducible floor &mdash; the noise no model can
                forecast
              </p>
            </div>
            <span className="pill bg-blue-100 text-blue-700">
              {(
                (futureTest.noiseFloor.meanFloorPct /
                  (futureTest.noiseFloor.bestAchievedPct || 1)) *
                100
              ).toFixed(0)}
              % of best possible
            </span>
          </div>

          <div className="px-5 pb-3">
            <p className="text-[13px] leading-relaxed text-slate-600">
              The generator injects AR(1) noise, so part of every future price is unpredictable
              by construction. A perfect model would still score about{' '}
              <strong>{futureTest.noiseFloor.meanFloorPct.toFixed(2)}% MAPE</strong>. The model
              scores <strong>{futureTest.noiseFloor.bestAchievedPct?.toFixed(2)}%</strong> —
              leaving only{' '}
              <strong>
                {(
                  (futureTest.noiseFloor.bestAchievedPct ?? 0) -
                  futureTest.noiseFloor.meanFloorPct
                ).toFixed(2)}
                pp
              </strong>{' '}
              of real headroom, not the whole 2%.
            </p>
          </div>

          <div className="px-2 pb-4">
            <ResponsiveContainer width="100%" height={222}>
              <ComposedChart
                data={futureTest.noiseFloor.byHorizon}
                margin={{ top: 12, right: 16, left: 4, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  tickLine={false}
                  axisLine={{ stroke: '#e2e8f0' }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  tickLine={false}
                  axisLine={false}
                  width={46}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <Tooltip
                  cursor={{ fill: '#f8fafc' }}
                  contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }}
                  formatter={(value, name) => [
                    value == null ? '--' : `${Number(value).toFixed(2)}%`,
                    name === 'achieved' ? 'Achieved MAPE' : 'Irreducible floor',
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />
                <Bar
                  dataKey="achieved"
                  name="Achieved MAPE"
                  fill="#2274a5"
                  radius={[5, 5, 0, 0]}
                  maxBarSize={44}
                />
                <Line
                  type="monotone"
                  dataKey="floor"
                  name="Irreducible floor"
                  stroke="#dc2626"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                  dot={{ r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="border-t border-slate-200 bg-amber-50 px-5 py-2.5 text-[11px] leading-relaxed text-amber-800">
            <strong>But the aggregate line is a different question.</strong> Idiosyncratic noise
            averages out across {futureTest.nParts} parts, so the mean-price line carries a noise
            band of only ~{futureTest.noiseFloor.aggregateNoisePct.toFixed(2)}%. A visible gap
            there is <em>systematic model error</em>, not noise, and remains worth fixing.
          </div>
        </div>
      )}

      {/* ---- Target mode comparison: the extrapolation fix ----------------- */}
      {comparison?.level && comparison?.log_return && (
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Why Predict Returns, Not Levels</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Gradient-boosted trees cannot extrapolate past their training target range
              </p>
            </div>
            {comparison.improvementPct != null && (
              <span className="pill bg-emerald-100 text-emerald-700">
                <IconCheck className="h-3 w-3" />
                {comparison.improvementPct.toFixed(1)}% lower error
              </span>
            )}
          </div>

          <div className="px-5 pb-2">
            <p className="text-[13px] leading-relaxed text-slate-600">
              A tree predicts the mean of a training leaf, so every prediction is bounded by the
              largest target it saw in training. On an upward-trending price series the model
              structurally undershoots once reality climbs past that ceiling, and the bias grows
              with horizon. Predicting{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px]">
                log(price[t+h] / price[t])
              </code>{' '}
              keeps the target stationary; the level is rebuilt afterwards and can go anywhere.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 px-5 pb-5 lg:grid-cols-[1fr_1.1fr]">
            <div className="flex flex-col justify-center gap-2">
              {(['level', 'log_return'] as const).map((mode) => {
                const row = comparison[mode];
                if (!row) return null;
                const isFix = mode === 'log_return';
                return (
                  <div
                    key={mode}
                    className={clsx(
                      'rounded-lg border p-3',
                      isFix ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[12px] font-medium text-slate-700">
                        {mode}
                      </span>
                      {isFix && (
                        <span className="pill bg-emerald-100 text-emerald-700">in use</span>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-baseline gap-4">
                      <div>
                        <div className="text-[19px] font-bold leading-none text-slate-900">
                          {row.mape?.toFixed(2)}%
                        </div>
                        <div className="text-[10px] text-slate-500">MAPE</div>
                      </div>
                      <div>
                        <div
                          className={clsx(
                            'text-[15px] font-semibold leading-none',
                            Math.abs(row.mean_signed_pct ?? 0) < 0.2
                              ? 'text-emerald-600'
                              : 'text-amber-600',
                          )}
                        >
                          {(row.mean_signed_pct ?? 0) >= 0 ? '+' : ''}
                          {row.mean_signed_pct?.toFixed(2)}%
                        </div>
                        <div className="text-[10px] text-slate-500">bias</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={modeData} margin={{ top: 10, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  tickLine={false}
                  axisLine={{ stroke: '#e2e8f0' }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  tickLine={false}
                  axisLine={false}
                  width={42}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <Tooltip
                  cursor={{ fill: '#f8fafc' }}
                  contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }}
                  formatter={(value) => (value == null ? '--' : `${Number(value).toFixed(2)}%`)}
                />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
                <Bar dataKey="level" name="level" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
                <Bar dataKey="log_return" name="log_return" fill="#2274a5" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ---- Error by category -------------------------------------------- */}
      {(futureTest.byCategory?.length ?? 0) > 0 && (
        <div className="card overflow-hidden">
          <div className="card-header">
            <div>
              <h3 className="card-title">Where the Error Lives</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Error by category for <span className="capitalize">{best.model}</span> &middot;
                highest first
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-y border-slate-200 bg-slate-50/60 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-2.5 font-semibold">Category</th>
                  <th className="px-3 py-2.5 text-right font-semibold">MAPE</th>
                  <th className="px-3 py-2.5 text-right font-semibold">MAE</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Bias</th>
                  <th className="px-5 py-2.5 text-right font-semibold">n</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(futureTest.byCategory ?? []).map((row) => (
                  <tr key={row.category}>
                    <td className="px-5 py-2.5 capitalize text-slate-900">
                      {row.category.replace(/_/g, ' ')}
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium tabular-nums text-slate-900">
                      {row.mape.toFixed(2)}%
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                      {formatCurrency(row.mae, false)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">
                      {row.mean_signed_pct >= 0 ? '+' : ''}
                      {row.mean_signed_pct.toFixed(2)}%
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-slate-500">{row.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
