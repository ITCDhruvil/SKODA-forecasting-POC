import { useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LabelList,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MaterialCost, PricePoint } from '../types';
import { formatAxisCurrency, formatCurrency, formatSpend } from '../lib/format';

interface Props {
  series: PricePoint[];
  horizonMonths: number;
  materialCost?: MaterialCost;
  /** Pipeline forecast basket (sum of unit prices). Stays the basket even when the chart is a mean. */
  unitBasket?: number | null;
}

type View = 'focus' | 'full';

/** Months of history shown before the forecast in the focused view. */
const FOCUS_HISTORY_MONTHS = 12;

interface Row extends PricePoint {
  /** Forecast line including a join to the last actual, so it starts where history ends. */
  forecastLine: number | null;
  /** Prediction range, also anchored at the last actual so the range fans out from it. */
  band: [number, number] | null;
}

/**
 * Mean basket price: observed history, the model's fit over the held-out window, and the
 * forward forecast with its prediction range. The forecast is the point of the chart, so it
 * gets a shaded zone, a joined line, value labels, and a focused view by default.
 */
export function PriceForecastChart({ series, horizonMonths, materialCost, unitBasket }: Props) {
  const [view, setView] = useState<View>('focus');
  const milestones = materialCost?.milestones;
  const summary = materialCost?.summary;

  const rows = useMemo<Row[]>(() => {
    let lastActualIdx = -1;
    series.forEach((p, i) => {
      if (p.actual !== null) lastActualIdx = i;
    });
    return series.map((p, i) => {
      const isJoin = i === lastActualIdx && series.some((q) => q.forecast !== null);
      return {
        ...p,
        forecastLine: isJoin ? p.actual : p.forecast,
        band:
          isJoin && p.actual !== null
            ? [p.actual, p.actual]
            : p.lower !== null && p.upper !== null
              ? [p.lower, p.upper]
              : null,
      };
    });
  }, [series]);

  const visible = useMemo(() => {
    if (view === 'full') return rows;
    const firstForecast = rows.findIndex((r) => r.forecast !== null);
    if (firstForecast < 0) return rows;
    return rows.slice(Math.max(0, firstForecast - FOCUS_HISTORY_MONTHS));
  }, [rows, view]);

  const labelFor = (month?: string) =>
    month ? visible.find((p) => p.month === month)?.label : undefined;

  const nominationLabel = labelFor(milestones?.nomination.month);
  const sopLabel = labelFor(milestones?.sop.month);

  const lastActualRow = useMemo(() => [...series].reverse().find((p) => p.actual !== null), [series]);
  const lastForecastRow = useMemo(() => [...series].reverse().find((p) => p.forecast !== null), [series]);
  const lastActual = lastActualRow?.label;
  const lastLabel = visible[visible.length - 1]?.label;
  const hasForecast = lastForecastRow !== undefined;

  const [yMin, yMax] = useMemo(() => {
    const values = visible.flatMap((p) =>
      [p.actual, p.fitted, p.forecast, p.lower, p.upper].filter((v): v is number => v != null),
    );
    if (values.length === 0) return [0, 1];
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pad = (hi - lo || hi * 0.02) * 0.1;
    return [lo - pad, hi + pad];
  }, [visible]);

  /** Indices (in `visible`) that get a value label: the first, peak and last forecast points. */
  const labelled = useMemo(() => {
    const idx = visible.map((p, i) => (p.forecast !== null ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) return new Set<number>();
    const peak = idx.reduce((a, b) => ((visible[b].forecast ?? 0) > (visible[a].forecast ?? 0) ? b : a));
    return new Set([idx[0], peak, idx[idx.length - 1]]);
  }, [visible]);

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

  const change =
    lastActualRow?.actual && lastForecastRow?.forecast
      ? ((lastForecastRow.forecast - lastActualRow.actual) / lastActualRow.actual) * 100
      : null;

  const toggle = (id: View, label: string) => (
    <button
      type="button"
      onClick={() => setView(id)}
      aria-pressed={view === id}
      className={
        view === id
          ? 'rounded-md bg-white px-2.5 py-1 font-medium text-slate-900 shadow-sm'
          : 'px-2.5 py-1 font-medium text-slate-500 hover:text-slate-700'
      }
    >
      {label}
    </button>
  );

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">Price forecast</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Mean unit price · Nomination and SOP are history · the forecast is the next{' '}
            {horizonMonths} months
          </p>
        </div>
        {hasForecast && (
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-[11px]">
            {toggle('focus', 'Focus on forecast')}
            {toggle('full', 'Full history')}
          </div>
        )}
      </div>

      {hasForecast && lastActualRow && lastForecastRow && (
        <div className="flex flex-wrap items-stretch gap-3 px-5 pb-3">
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <p className="text-[11px] text-slate-500">Latest actual · {lastActualRow.label}</p>
            <p className="text-sm font-semibold tabular-nums text-slate-900">
              {formatCurrency(lastActualRow.actual, false)}
            </p>
          </div>
          <div className="rounded-lg bg-amber-50 px-3 py-2">
            <p className="text-[11px] text-amber-700">Forecast · {lastForecastRow.label}</p>
            <p className="text-sm font-semibold tabular-nums text-slate-900">
              {formatCurrency(lastForecastRow.forecast, false)}
              {change !== null && (
                <span className={`ml-2 text-xs font-medium ${change > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                  {change > 0 ? '+' : change < 0 ? '−' : ''}
                  {Math.abs(change).toFixed(1)}%
                </span>
              )}
            </p>
          </div>
          {lastForecastRow.lower !== null && lastForecastRow.upper !== null && (
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-[11px] text-slate-500">Likely range · {lastForecastRow.label}</p>
              <p className="text-sm font-semibold tabular-nums text-slate-900">
                {formatCurrency(lastForecastRow.lower, false)} to {formatCurrency(lastForecastRow.upper, false)}
              </p>
            </div>
          )}
          {(unitBasket != null || summary?.forecastSpend != null) && (
            <div className="rounded-lg bg-slate-50 px-3 py-2">
              <p className="text-[11px] text-slate-500">Forecast basket · {lastForecastRow.label}</p>
              <p className="text-sm font-semibold tabular-nums text-slate-900">
                {unitBasket != null ? formatSpend(unitBasket) : '--'}
                <span className="ml-1.5 text-xs font-normal text-slate-400">unit basket</span>
                <span className="mx-1.5 text-slate-300">|</span>
                {summary?.forecastSpend != null ? formatSpend(summary.forecastSpend) : '--'}
                <span className="ml-1.5 text-xs font-normal text-slate-400">spend</span>
              </p>
            </div>
          )}
        </div>
      )}

      <div className="px-2 pb-4">
        <ResponsiveContainer width="100%" height={view === 'focus' ? 320 : 290}>
          <ComposedChart data={visible} margin={{ top: 22, right: 22, left: 4, bottom: 4 }}>
            <defs>
              <linearGradient id="pfBand" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.28} />
                <stop offset="100%" stopColor="#f59e0b" stopOpacity={0.12} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: '#64748b' }}
              tickLine={false}
              axisLine={{ stroke: '#e2e8f0' }}
              interval="preserveStartEnd"
              minTickGap={view === 'focus' ? 8 : 24}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#64748b' }}
              tickLine={false}
              axisLine={false}
              width={54}
              tickFormatter={(v: number) =>
                yMax >= 1_000 && yMax < 100_000 ? `₹${(v / 1_000).toFixed(2)}K` : formatAxisCurrency(v, yMax)
              }
              domain={[yMin, yMax]}
              allowDataOverflow
            />
            <Tooltip
              cursor={{ stroke: '#cbd5e1', strokeDasharray: '4 4' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as Row;
                const line = (label: string, value: number | null, cls: string) =>
                  value == null ? null : (
                    <div className={`mt-0.5 ${cls}`}>
                      {label} <span className="font-medium tabular-nums">{formatCurrency(value, false)}</span>
                    </div>
                  );
                return (
                  <div className="rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-xs shadow-[0_4px_12px_rgb(0_0_0_/_0.06)]">
                    <div className="font-semibold text-slate-900">{p.label}</div>
                    {line('Actual', p.actual, 'text-slate-700')}
                    {line('Model fit (holdout)', p.fitted, 'text-blue-600')}
                    {line('Forecast', p.forecast, 'text-amber-700')}
                    {p.forecast !== null && p.lower !== null && p.upper !== null && (
                      <div className="mt-0.5 text-slate-500">
                        Likely range {formatCurrency(p.lower, false)} to {formatCurrency(p.upper, false)}
                      </div>
                    )}
                  </div>
                );
              }}
            />
            <Legend iconType="line" wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />

            {hasForecast && lastActual && lastLabel && lastActual !== lastLabel && (
              <ReferenceArea
                x1={lastActual}
                x2={lastLabel}
                fill="#fef3c7"
                fillOpacity={0.45}
                strokeOpacity={0}
                ifOverflow="extendDomain"
                label={{
                  value: `Next ${horizonMonths} months`,
                  position: 'insideTopRight',
                  fontSize: 11,
                  fontWeight: 600,
                  fill: '#b45309',
                }}
              />
            )}
            {nominationLabel && (
              <ReferenceLine
                x={nominationLabel}
                stroke="#94a3b8"
                strokeDasharray="3 3"
                label={{ value: 'Nomination', position: 'insideTopLeft', fontSize: 10, fill: '#64748b' }}
              />
            )}
            {sopLabel && sopLabel !== lastActual && (
              <ReferenceLine
                x={sopLabel}
                stroke="#64748b"
                strokeDasharray="3 3"
                label={{ value: 'SOP', position: 'insideTop', fontSize: 10, fill: '#64748b' }}
              />
            )}
            {lastActual && (
              <ReferenceLine
                x={lastActual}
                stroke="#64748b"
                strokeDasharray="4 3"
                label={{
                  value: hasForecast ? 'Today' : sopLabel === lastActual ? 'SOP' : 'Today',
                  position: 'insideTopLeft',
                  fontSize: 10,
                  fill: '#475569',
                }}
              />
            )}

            <Area
              type="monotone"
              dataKey="band"
              name="Likely range"
              stroke="none"
              fill="url(#pfBand)"
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="actual"
              name="Actual"
              stroke="#1e293b"
              strokeWidth={2.25}
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
              dataKey="forecastLine"
              name="Forecast"
              stroke="#d97706"
              strokeWidth={3}
              dot={(props: { cx?: number; cy?: number; payload?: Row; index?: number }) => {
                const { cx, cy, payload, index } = props;
                if (cx == null || cy == null || payload?.forecast == null) return <g key={`d-${index}`} />;
                return <circle key={`d-${index}`} cx={cx} cy={cy} r={4.5} fill="#fff" stroke="#d97706" strokeWidth={2.5} />;
              }}
              activeDot={{ r: 6, fill: '#d97706', stroke: '#fff', strokeWidth: 2 }}
              connectNulls={false}
            >
              <LabelList
                dataKey="forecast"
                content={(props: { x?: number | string; y?: number | string; value?: unknown; index?: number }) => {
                  const { x, y, value, index } = props;
                  if (typeof value !== 'number' || index == null || !labelled.has(index)) return null;
                  return (
                    <text
                      x={Number(x)}
                      y={Number(y) - 12}
                      textAnchor="middle"
                      fontSize={11}
                      fontWeight={600}
                      fill="#92400e"
                    >
                      {formatSpend(value)}
                    </text>
                  );
                }}
              />
            </Line>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
