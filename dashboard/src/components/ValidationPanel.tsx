import clsx from 'clsx';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Validation } from '../types';
import { monthLabel } from '../lib/format';
import { IconAlert, IconCheck, IconClock } from './Icons';

/**
 * Real-data validation.
 *
 * Every other number in this app is measured against a synthetic panel. This
 * panel is the only place a real-world accuracy claim is made, because it uses
 * actually-published BLS observations.
 *
 * It leads with the result even when the result is unflattering - if the naive
 * baseline wins, that is the headline, because it is the finding that changes
 * what someone does next.
 */
export function ValidationPanel({ validation }: { validation: Validation }) {
  if (!validation.available) {
    return (
      <div className="card p-6">
        <div className="flex items-start gap-3">
          <IconAlert className="mt-0.5 h-5 w-5 text-amber-600" />
          <div>
            <h3 className="text-[15px] font-semibold text-slate-900">
              Real-data validation unavailable
            </h3>
            <p className="mt-1 text-sm text-slate-600">{validation.reason}</p>
          </div>
        </div>
      </div>
    );
  }

  const backtests = [...validation.backtests].sort((a, b) => a.mape - b.mape);
  const best = backtests[0];
  const naive = backtests.find((b) => b.model === 'naive');
  const naiveWins = best?.model === 'naive';

  const chartModel = backtests.find((b) => b.model === 'sarima') ?? best;
  const chartData =
    chartModel?.points.map((point) => ({
      label: monthLabel(point.month),
      actual: point.actual,
      predicted: point.predicted,
      lower: point.lower,
      upper: point.upper,
    })) ?? [];

  const { ledger } = validation;
  const scoredEntries = ledger.entries.filter((e) => e.actual !== null);
  const pendingEntries = ledger.entries.filter((e) => e.actual === null);

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Headline verdict -------------------------------------------- */}
      <div className="card p-5">
        <div className="flex items-start gap-3">
          {naiveWins ? (
            <IconAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          ) : (
            <IconCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
          )}
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-slate-900">
              {naiveWins
                ? 'On real data, the naive baseline wins'
                : `${best?.model} leads on real data`}
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">
              Trained on <strong>{best?.n_train} months</strong> of published BLS data
              (<span className="font-mono text-xs">{validation.series_id}</span>), then asked to
              forecast <strong>{best?.n_test} months</strong> it had never seen
              ({monthLabel(best?.test_start ?? '')} &ndash; {monthLabel(best?.test_end ?? '')}).
              Scored against the values BLS actually published.
              {naiveWins && (
                <>
                  {' '}
                  Carrying the last value forward scored{' '}
                  <strong>{naive?.mape.toFixed(3)}% MAPE</strong> &mdash; better than every
                  fitted model. The real index behaves close to a random walk at this horizon,
                  so the extra complexity is not paying for itself.
                </>
              )}
            </p>
            {validation.excluded_extrapolated_months ? (
              <p className="mt-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-500">
                {validation.excluded_extrapolated_months} back-extrapolated month(s) were
                excluded from this test. Only genuinely published observations are scored &mdash;
                validating against our own reconstruction would be circular.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* ---- Model table -------------------------------------------------- */}
      <div className="card overflow-hidden">
        <div className="card-header">
          <div>
            <h3 className="card-title">Accuracy on Real Published Data</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {validation.n_real_observations} real monthly observations &middot;{' '}
              {validation.real_range?.[0]} to {validation.real_range?.[1]}
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
                <th className="px-3 py-2.5 text-right font-semibold">Interval coverage</th>
                <th className="px-5 py-2.5 font-semibold">Verdict</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {backtests.map((row, index) => (
                <tr key={row.model} className={index === 0 ? 'bg-emerald-50/40' : undefined}>
                  <td className="px-5 py-2.5 font-medium capitalize text-slate-900">
                    {row.model}
                    {row.model === 'naive' && (
                      <span className="ml-2 text-[11px] font-normal text-slate-500">
                        (last value carried forward)
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                    {row.mae.toFixed(3)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                    {row.rmse.toFixed(3)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900">
                    {row.mape.toFixed(3)}%
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {row.coverage_pct === null ? (
                      <span className="text-slate-400">no interval</span>
                    ) : (
                      <span
                        className={
                          row.coverage_pct >= 70 ? 'text-emerald-600' : 'text-red-600'
                        }
                      >
                        {row.coverage_pct.toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-2.5">
                    {index === 0 ? (
                      <span className="pill bg-emerald-100 text-emerald-700">best</span>
                    ) : (
                      <span className="text-[11px] text-slate-500">
                        {naive ? `${(row.mape / naive.mape).toFixed(1)}x baseline error` : ''}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {backtests.some((b) => b.coverage_pct === 0) && (
          <div className="border-t border-slate-200 bg-amber-50 px-5 py-2.5 text-[11px] leading-relaxed text-amber-800">
            <strong>Interval calibration failure:</strong> a model's 80% prediction interval
            contained none of the six actual values. Its uncertainty estimates should not be
            relied on.
          </div>
        )}
      </div>

      {/* ---- Predicted vs actual chart ------------------------------------ */}
      {chartData.length > 0 && (
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">
                Predicted vs Actual &mdash; <span className="capitalize">{chartModel?.model}</span>
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Real BLS index values the model never saw during training
              </p>
            </div>
          </div>
          <div className="px-2 pb-4">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={chartData} margin={{ top: 6, right: 20, left: 4, bottom: 4 }}>
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
                  width={52}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 10,
                    border: '1px solid #e2e8f0',
                    fontSize: 12,
                  }}
                  formatter={(value) => (value == null ? '--' : Number(value).toFixed(3))}
                />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: 6 }} iconType="line" />
                <Line
                  type="monotone"
                  dataKey="actual"
                  name="Actual (BLS published)"
                  stroke="#1e293b"
                  strokeWidth={2.25}
                  dot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="predicted"
                  name="Predicted"
                  stroke="#ef4444"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                  dot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="lower"
                  name="80% interval"
                  stroke="#fca5a5"
                  strokeWidth={1}
                  dot={false}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="upper"
                  name=""
                  stroke="#fca5a5"
                  strokeWidth={1}
                  dot={false}
                  legendType="none"
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ---- Forward ledger ----------------------------------------------- */}
      <div className="card overflow-hidden">
        <div className="card-header">
          <div>
            <h3 className="card-title">Forward Forecast Ledger</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Predictions recorded <em>before</em> the target month was published, scored
              automatically when BLS releases it
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="pill bg-emerald-100 text-emerald-700">
              {ledger.n_scored} scored
            </span>
            <span className="pill bg-slate-100 text-slate-600">
              {ledger.n_pending} pending
            </span>
          </div>
        </div>

        {scoredEntries.length === 0 && (
          <div className="mx-5 mb-4 flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3.5">
            <IconClock className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
            <p className="text-[13px] leading-relaxed text-slate-600">
              No forward forecasts have been scored yet &mdash; the next target month
              {ledger.next_target_month ? (
                <>
                  {' '}
                  (<strong>{monthLabel(ledger.next_target_month)}</strong>)
                </>
              ) : null}{' '}
              has not been published by BLS. Re-run the <code className="rounded bg-white px-1 py-0.5 font-mono text-[11px]">validate</code>{' '}
              stage after the release and these entries score themselves. This is the honest
              shape of the question: a forward forecast cannot be graded until reality arrives.
            </p>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-y border-slate-200 bg-slate-50/60 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-5 py-2.5 font-semibold">Target month</th>
                <th className="px-3 py-2.5 font-semibold">Model</th>
                <th className="px-3 py-2.5 font-semibold">Recorded on</th>
                <th className="px-3 py-2.5 text-right font-semibold">Predicted</th>
                <th className="px-3 py-2.5 text-right font-semibold">Actual</th>
                <th className="px-5 py-2.5 text-right font-semibold">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[...scoredEntries, ...pendingEntries].slice(0, 14).map((entry) => (
                <tr key={`${entry.target_month}-${entry.model}`}>
                  <td className="px-5 py-2.5 font-medium text-slate-900">
                    {monthLabel(entry.target_month)}
                  </td>
                  <td className="px-3 py-2.5 capitalize text-slate-600">{entry.model}</td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-slate-500">
                    {entry.forecast_made_on}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                    {entry.predicted.toFixed(3)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {entry.actual === null ? (
                      <span className="pill bg-slate-100 text-slate-500">awaiting BLS</span>
                    ) : (
                      <span className="font-medium text-slate-900">
                        {entry.actual.toFixed(3)}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-2.5 text-right tabular-nums">
                    {entry.pct_error === null ? (
                      <span className="text-slate-400">--</span>
                    ) : (
                      <span
                        className={clsx(
                          'font-semibold',
                          Math.abs(entry.pct_error) < 1 ? 'text-emerald-600' : 'text-amber-600',
                        )}
                      >
                        {entry.pct_error >= 0 ? '+' : ''}
                        {entry.pct_error.toFixed(2)}%
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
