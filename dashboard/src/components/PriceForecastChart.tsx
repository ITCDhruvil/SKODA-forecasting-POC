import { useMemo } from 'react';
import {
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
import type { PricePoint } from '../types';
import { formatAxisCurrency, formatCurrency } from '../lib/format';

interface Props {
  series: PricePoint[];
  horizonMonths: number;
}

/**
 * Mean basket price: observed history, the model's fit over the held-out
 * window, and the forward forecast (no prediction band).
 */
export function PriceForecastChart({ series, horizonMonths }: Props) {
  const lastActual = useMemo(
    () => [...series].reverse().find((p) => p.actual !== null)?.label,
    [series],
  );

  const yMax = useMemo(
    () =>
      Math.max(
        ...series.flatMap((p) => [p.actual, p.fitted, p.forecast].filter((v): v is number => v != null)),
        1,
      ),
    [series],
  );

  if (series.length === 0) {
    return (
      <div className="card p-6">
        <h3 className="card-title">Mean Price: Actual vs Forecast</h3>
        <p className="mt-2 text-sm text-slate-500">
          No price points fall inside the selected date range.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">Mean Price: Actual vs Forecast</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Across all parts &middot; {horizonMonths}-month forward forecast
          </p>
        </div>
      </div>

      <div className="px-2 pb-4">
        <ResponsiveContainer width="100%" height={278}>
          <ComposedChart data={series} margin={{ top: 6, right: 16, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: '#64748b' }}
              tickLine={false}
              axisLine={{ stroke: '#e2e8f0' }}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#64748b' }}
              tickLine={false}
              axisLine={false}
              width={54}
              tickFormatter={(v: number) => formatAxisCurrency(v, yMax)}
              domain={['auto', 'auto']}
            />
            <Tooltip
              contentStyle={{
                borderRadius: 10,
                border: '1px solid #e2e8f0',
                fontSize: 12,
                boxShadow: '0 4px 12px rgb(0 0 0 / 0.06)',
              }}
              formatter={(value, name) =>
                value == null
                  ? ['--', String(name)]
                  : [formatCurrency(Number(value), false), String(name)]
              }
            />
            <Legend iconType="line" wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />

            {lastActual && (
              <ReferenceLine
                x={lastActual}
                stroke="#94a3b8"
                strokeDasharray="3 3"
                label={{
                  value: 'today',
                  position: 'insideTopRight',
                  fontSize: 10,
                  fill: '#94a3b8',
                }}
              />
            )}

            <Line
              type="monotone"
              dataKey="actual"
              name="Actual"
              stroke="#1e293b"
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="fitted"
              name="Model fit (holdout)"
              stroke="#3b82f6"
              strokeWidth={1.75}
              strokeDasharray="5 3"
              dot={{ r: 2 }}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="forecast"
              name="Forecast"
              stroke="#f59e0b"
              strokeWidth={2.25}
              dot={{ r: 2.5 }}
              connectNulls={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
