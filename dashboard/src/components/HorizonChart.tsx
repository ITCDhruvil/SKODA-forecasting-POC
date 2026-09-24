import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ErrorBar,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { HorizonBar } from '../types';
import { formatAxisCurrency, formatCurrency } from '../lib/format';

/**
 * Forecast basket value per month ahead.
 *
 * Error bars carry the prediction interval, so the widening uncertainty is
 * visible rather than implied. A bar chart of point forecasts alone would
 * suggest more precision than the model has.
 */
export function HorizonChart({
  horizon,
  fill = false,
}: {
  horizon: HorizonBar[];
  /** Stretch the chart so the card can match a taller neighbour. */
  fill?: boolean;
}) {
  if (horizon.length === 0) {
    return (
      <div className="card p-6">
        <h3 className="card-title">Forecast by Time Horizon</h3>
        <p className="mt-2 text-sm text-slate-500">
          No forecast months fall inside the selected date range.
        </p>
      </div>
    );
  }

  const axisMax = Math.max(...horizon.map((bar) => bar.upper ?? bar.value), 0);
  const data = horizon.map((bar) => ({
    ...bar,
    errorRange:
      bar.lower !== null && bar.upper !== null
        ? [bar.value - bar.lower, bar.upper - bar.value]
        : [0, 0],
  }));

  return (
    <div className={fill ? 'card flex h-full min-h-0 flex-col' : 'card'}>
      <div className="card-header">
        <div>
          <h3 className="card-title">Forecast by Time Horizon</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Total basket value &middot; whiskers show the prediction interval
          </p>
        </div>
      </div>

      <div className={fill ? 'min-h-[264px] flex-1 px-2 pb-4' : 'px-2 pb-4'}>
        <ResponsiveContainer width="100%" height={fill ? '100%' : 264}>
          <BarChart data={data} margin={{ top: 18, right: 16, left: 4, bottom: 4 }}>
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
              width={56}
              tickFormatter={(v: number) => formatAxisCurrency(v, axisMax)}
            />
            <Tooltip
              cursor={{ fill: '#f8fafc' }}
              contentStyle={{
                borderRadius: 10,
                border: '1px solid #e2e8f0',
                fontSize: 12,
              }}
              formatter={(value) => [
                formatCurrency(value == null ? null : Number(value), false),
                'Basket value',
              ]}
            />
            <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={54}>
              {data.map((entry, index) => (
                <Cell
                  key={entry.month}
                  fill={index === 0 ? '#3b82f6' : '#bfdbfe'}
                />
              ))}
              <ErrorBar
                dataKey="errorRange"
                width={5}
                strokeWidth={1.25}
                stroke="#64748b"
                direction="y"
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
