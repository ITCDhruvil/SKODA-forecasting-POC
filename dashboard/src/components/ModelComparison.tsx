import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { BacktestSummaryRow, ModelMetric } from '../types';

const COLORS: Record<string, string> = {
  sarima: '#d1495b',
  xgboost: '#2274a5',
  seasonal_naive: '#8d99ae',
};

interface Props {
  comparison: ModelMetric[];
  backtestSummary: BacktestSummaryRow[];
}

/**
 * Synthetic-panel model comparison, kept visually distinct from the real-data
 * validation panel so the two are not confused.
 */
export function ModelComparison({ comparison, backtestSummary }: Props) {
  const sorted = [...comparison].sort((a, b) => a.mape - b.mape);

  return (
    <div className="flex flex-col gap-4">
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">Model Comparison &mdash; Synthetic Panel</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Common part set, all models scored on identical parts &middot; lower is better
            </p>
          </div>
          <span className="pill bg-amber-100 text-amber-700">synthetic</span>
        </div>

        <div className="px-2 pb-4">
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={sorted} margin={{ top: 16, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
              <XAxis
                dataKey="model"
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
                formatter={(value) => [
                  value == null ? '--' : `${Number(value).toFixed(3)}%`,
                  'MAPE',
                ]}
              />
              <Bar dataKey="mape" radius={[6, 6, 0, 0]} maxBarSize={72}>
                {sorted.map((row) => (
                  <Cell key={row.model} fill={COLORS[row.model] ?? '#94a3b8'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="overflow-x-auto border-t border-slate-200">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-slate-50/60 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-5 py-2.5 font-semibold">Model</th>
                <th className="px-3 py-2.5 text-right font-semibold">MAE</th>
                <th className="px-3 py-2.5 text-right font-semibold">RMSE</th>
                <th className="px-5 py-2.5 text-right font-semibold">MAPE</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.map((row) => (
                <tr key={row.model}>
                  <td className="px-5 py-2.5 font-medium text-slate-900">{row.model}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                    {row.mae.toFixed(3)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                    {row.rmse.toFixed(3)}
                  </td>
                  <td className="px-5 py-2.5 text-right font-semibold tabular-nums text-slate-900">
                    {row.mape.toFixed(3)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {backtestSummary.length > 0 && (
        <div className="card overflow-hidden">
          <div className="card-header">
            <div>
              <h3 className="card-title">Backtest Stability</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Mean &plusmn; std across rolling origins &middot; a low spread means the
                accuracy is not a one-off lucky split
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
                  <th className="px-5 py-2.5 text-right font-semibold">MAPE</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {backtestSummary.map((row) => (
                  <tr key={row.model}>
                    <td className="px-5 py-2.5 font-medium text-slate-900">{row.model}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                      {row.mae_mean?.toFixed(3)}{' '}
                      <span className="text-[11px] text-slate-400">
                        &plusmn;{row.mae_std?.toFixed(3)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                      {row.rmse_mean?.toFixed(3)}{' '}
                      <span className="text-[11px] text-slate-400">
                        &plusmn;{row.rmse_std?.toFixed(3)}
                      </span>
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-slate-900">
                      {row.mape_mean?.toFixed(3)}%{' '}
                      <span className="text-[11px] text-slate-400">
                        &plusmn;{row.mape_std?.toFixed(3)}
                      </span>
                    </td>
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
