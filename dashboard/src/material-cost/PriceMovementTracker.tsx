import { useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MaterialCost, MaterialPricePoint } from '../types';
import { formatAxisCurrency, formatCurrency } from '../lib/format';

interface Props {
  series: MaterialPricePoint[];
  milestones?: MaterialCost['milestones'];
  /** When true, series is reshaped to the filtered basket levels. */
  scoped?: boolean;
}

type HorizonMode = 'history' | 'full';

/**
 * Basket mean unit price: history (Nomination → SOP), then forward forecast.
 */
export function PriceMovementTracker({ series, milestones, scoped }: Props) {
  const [mode, setMode] = useState<HorizonMode>('full');

  const visibleSeries = useMemo(() => {
    if (mode === 'full') return series;
    // History only: Nomination → SOP (drop pure forecast months).
    return series.filter((p) => p.actual != null);
  }, [series, mode]);

  const max = useMemo(
    () =>
      Math.max(
        ...visibleSeries.map((p) => Math.max(p.actual ?? 0, p.forecast ?? 0)),
        1,
      ),
    [visibleSeries],
  );

  const nomLabel = visibleSeries.find(
    (p) => p.month === milestones?.nomination.month,
  )?.label;
  const sopLabel = visibleSeries.find((p) => p.month === milestones?.sop.month)?.label;

  const lastActual = useMemo(
    () => [...visibleSeries].reverse().find((p) => p.actual != null),
    [visibleSeries],
  );
  const lastForecast = useMemo(
    () => [...visibleSeries].reverse().find((p) => p.forecast != null),
    [visibleSeries],
  );

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">Price movement tracker</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {scoped
              ? 'Basket-average unit price for the filtered parts (approximate reshape)'
              : 'Basket-average unit price across parts — Nomination → SOP, then forecast'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setMode('history')}
              className={
                mode === 'history'
                  ? 'rounded-md bg-white px-2.5 py-1 font-medium text-slate-900 shadow-sm'
                  : 'px-2.5 py-1 font-medium text-slate-500 hover:text-slate-700'
              }
            >
              History only
            </button>
            <button
              type="button"
              onClick={() => setMode('full')}
              className={
                mode === 'full'
                  ? 'rounded-md bg-white px-2.5 py-1 font-medium text-slate-900 shadow-sm'
                  : 'px-2.5 py-1 font-medium text-slate-500 hover:text-slate-700'
              }
            >
              Full horizon
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1.5 text-slate-600">
              <span className="h-0.5 w-3 rounded bg-slate-900" />
              Actual
            </span>
            {mode === 'full' ? (
              <span className="inline-flex items-center gap-1.5 text-slate-600">
                <span className="h-0.5 w-3 rounded border border-dashed border-brand-600 bg-transparent" />
                Forecast
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {(milestones || lastActual || lastForecast) && (
        <div className="flex flex-wrap gap-2 px-5 pb-1">
          {milestones ? (
            <>
              <span className="pill bg-blue-50 text-blue-700">
                Nomination {milestones.nomination.label}
              </span>
              <span className="pill bg-violet-50 text-violet-700">
                SOP {milestones.sop.label}
              </span>
              {mode === 'full' ? (
                <span className="pill bg-slate-100 text-slate-700">
                  Forecast {milestones.forecast.label}
                </span>
              ) : null}
            </>
          ) : null}
          {mode === 'full' && lastForecast?.forecast != null ? (
            <span className="pill bg-brand-50 text-brand-700">
              Latest FC {formatCurrency(lastForecast.forecast, false)}
            </span>
          ) : null}
          {lastActual?.actual != null ? (
            <span className="pill bg-slate-100 text-slate-600">
              Latest actual {formatCurrency(lastActual.actual, false)}
            </span>
          ) : null}
        </div>
      )}

      <div className="h-[280px] px-2 pb-2">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={visibleSeries}
            margin={{ top: 10, right: 14, left: 4, bottom: 4 }}
          >
            <defs>
              <linearGradient id="mcActualFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#0f172a" stopOpacity={0.08} />
                <stop offset="100%" stopColor="#0f172a" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="mcNomSopBand" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity={0.12} />
                <stop offset="100%" stopColor="#6366f1" stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef2f7" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: '#64748b' }}
              axisLine={{ stroke: '#e2e8f0' }}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={28}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#64748b' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => formatAxisCurrency(v, max)}
              width={52}
              domain={['auto', 'auto']}
            />
            <Tooltip
              cursor={{ stroke: '#cbd5e1', strokeDasharray: '4 4' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const point = payload[0].payload as MaterialPricePoint;
                return (
                  <div className="rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-xs shadow-[0_4px_12px_rgb(0_0_0_/_0.06)]">
                    <div className="font-semibold text-slate-900">{point.label}</div>
                    {point.actual != null ? (
                      <div className="mt-1 text-slate-700">
                        Actual{' '}
                        <span className="font-medium tabular-nums">
                          {formatCurrency(point.actual, false)}
                        </span>
                      </div>
                    ) : null}
                    {point.forecast != null ? (
                      <div className="mt-0.5 text-brand-700">
                        Forecast{' '}
                        <span className="font-medium tabular-nums">
                          {formatCurrency(point.forecast, false)}
                        </span>
                      </div>
                    ) : null}
                    {point.isNomination ? (
                      <div className="mt-1 text-[10px] text-blue-600">
                        Nomination (budget start)
                      </div>
                    ) : null}
                    {point.isSop ? (
                      <div className="mt-1 text-[10px] text-violet-600">
                        SOP / current production
                      </div>
                    ) : null}
                  </div>
                );
              }}
            />
            {nomLabel && sopLabel ? (
              <ReferenceArea
                x1={nomLabel}
                x2={sopLabel}
                fill="url(#mcNomSopBand)"
                strokeOpacity={0}
                label={{
                  value: 'Nomination → SOP',
                  position: 'insideTopLeft',
                  fill: '#4f46e5',
                  fontSize: 10,
                }}
              />
            ) : null}
            {nomLabel ? (
              <ReferenceLine
                x={nomLabel}
                stroke="#2563eb"
                strokeDasharray="4 4"
                strokeOpacity={0.7}
              />
            ) : null}
            {sopLabel ? (
              <ReferenceLine
                x={sopLabel}
                stroke="#7c3aed"
                strokeDasharray="4 4"
                strokeOpacity={0.7}
              />
            ) : null}
            <Area
              type="monotone"
              dataKey="actual"
              stroke="none"
              fill="url(#mcActualFill)"
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="actual"
              name="Actual"
              stroke="#0f172a"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3.5, strokeWidth: 0 }}
              connectNulls={false}
              isAnimationActive={false}
            />
            {mode === 'full' ? (
              <Line
                type="monotone"
                dataKey="forecast"
                name="Forecast"
                stroke="#2563eb"
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
                activeDot={{ r: 3.5, strokeWidth: 0, fill: '#2563eb' }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="border-t border-slate-100 px-5 py-2.5 text-[11px] leading-relaxed text-slate-500">
        Line is the <span className="font-medium text-slate-700">basket average</span> unit
        price
        {scoped ? ' for the current hierarchy slice' : ' across parts'}
        {scoped
          ? ' (portfolio monthly shape, rescaled to this slice’s BG / SOP / FC).'
          : '. Shaded band marks Nomination → SOP history.'}
      </p>
    </div>
  );
}
