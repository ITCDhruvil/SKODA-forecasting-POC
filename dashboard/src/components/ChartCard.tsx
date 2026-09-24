import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { BarChartSpec, ChartSpec, ChartUnit, DonutChartSpec, LineChartSpec } from '../lib/chatHistory';
import { formatNumber, formatPercent } from '../lib/format';

/**
 * Self-contained currency formatter for chart output.
 *
 * The module-level `formatCurrency` in `lib/format.ts` reads a symbol set
 * elsewhere (via `setCurrencySymbol`), which can race with a chart's own
 * `currencySymbol` field on first render. Charts carry their own symbol, so
 * this formats straight from it instead.
 */
function formatChartCurrency(value: number, currencySymbol: string): string {
  return `${currencySymbol}${Math.round(value).toLocaleString('en-IN')}`;
}

function formatByUnit(value: number, unit: ChartUnit, currencySymbol: string): string {
  switch (unit) {
    case 'currency':
      return formatChartCurrency(value, currencySymbol);
    case 'pct':
      return formatPercent(value);
    default:
      return formatNumber(value);
  }
}

/** Compact axis-tick currency, mirroring `formatAxisCurrency` in lib/format.ts (K/M suffix) but self-contained on the chart's own currencySymbol. */
function formatChartAxisCurrency(value: number, currencySymbol: string): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${currencySymbol}${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${currencySymbol}${Math.round(value / 1_000)}K`;
  return `${currencySymbol}${Math.round(value)}`;
}

function formatAxisByUnit(value: number, unit: ChartUnit, currencySymbol: string): string {
  switch (unit) {
    case 'currency':
      return formatChartAxisCurrency(value, currencySymbol);
    case 'pct':
      return formatByUnit(value, unit, currencySymbol);
    default:
      return formatByUnit(value, unit, currencySymbol);
  }
}

const AXIS_TICK = { fontSize: 11, fill: '#64748b' };

/** Up to two series' worth of line colors — the catalog never sends more. */
const LINE_COLORS = ['#2563eb', '#94a3b8'];

function toneColor(tone: 'up' | 'down' | 'neutral' | undefined): string {
  if (tone === 'up') return '#059669';
  if (tone === 'down') return '#dc2626';
  return '#64748b';
}

function LineChartBody({ chart }: { chart: LineChartSpec }) {
  const { points, series, band, unit, currencySymbol } = chart;

  const data = band
    ? points.map((p) => {
        const lower = p[band.lowerKey];
        const upper = p[band.upperKey];
        const bandBase = typeof lower === 'number' ? lower : null;
        const bandSpan = typeof lower === 'number' && typeof upper === 'number' ? upper - lower : null;
        return { ...p, bandBase, bandSpan };
      })
    : points;

  const showLegend = Boolean(band) || series.length >= 2;

  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#eef2f7" vertical={false} />
        <XAxis dataKey="x" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(v: number) => formatAxisByUnit(v, unit, currencySymbol)}
        />
        <Tooltip
          contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 11 }}
          formatter={(value, name) =>
            value == null ? ['--', String(name)] : [formatByUnit(Number(value), unit, currencySymbol), String(name)]
          }
        />
        {showLegend && <Legend wrapperStyle={{ fontSize: 10 }} />}

        {band && (
          <>
            {/* Transparent base lifts the visible span up to `lower`; Recharts has no native interval mark. */}
            <Area
              dataKey="bandBase"
              stackId="band"
              stroke="none"
              fill="transparent"
              isAnimationActive={false}
              legendType="none"
              tooltipType="none"
            />
            <Area
              dataKey="bandSpan"
              name={band.label}
              stackId="band"
              stroke="none"
              fill="#f59e0b"
              fillOpacity={0.16}
              isAnimationActive={false}
              tooltipType="none"
            />
          </>
        )}

        {series.map((s, i) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={LINE_COLORS[i % LINE_COLORS.length]}
            strokeWidth={2}
            strokeDasharray={s.style === 'dashed' ? '5 3' : undefined}
            dot={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function BarChartBody({ chart }: { chart: BarChartSpec }) {
  const { orientation, series, rows, unit, currencySymbol } = chart;
  const horizontal = orientation === 'horizontal';
  const singleSeries = series.length === 1;

  const data = rows.map((r) => ({ label: r.label, tone: r.tone, ...r.values }));
  const valueAxis = (
    <YAxis
      tick={AXIS_TICK}
      tickLine={false}
      axisLine={false}
      width={48}
      tickFormatter={(v: number) => formatAxisByUnit(v, unit, currencySymbol)}
    />
  );

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart
        data={data}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
      >
        <CartesianGrid stroke="#eef2f7" vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis
              type="number"
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: '#e2e8f0' }}
              tickFormatter={(v: number) => formatAxisByUnit(v, unit, currencySymbol)}
            />
            <YAxis
              type="category"
              dataKey="label"
              width={110}
              tick={{ fontSize: 10, fill: '#64748b' }}
              tickLine={false}
              axisLine={false}
              interval={0}
            />
          </>
        ) : (
          <>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: '#64748b' }}
              tickLine={false}
              axisLine={{ stroke: '#e2e8f0' }}
              interval={0}
            />
            {valueAxis}
          </>
        )}
        <Tooltip
          contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 11 }}
          formatter={(value, name) => [formatByUnit(Number(value), unit, currencySymbol), String(name)]}
        />
        {series.length >= 2 && <Legend wrapperStyle={{ fontSize: 10 }} />}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
            fill={LINE_COLORS[i % LINE_COLORS.length]}
          >
            {singleSeries && rows.map((r, idx) => <Cell key={idx} fill={toneColor(r.tone)} />)}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Palette for donut slices: the same 8 hex colors `CategoryDonut.tsx` cycles
 * through, so a chat-rendered category breakdown matches the dashboard's own.
 */
const DONUT_COLORS = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#06b6d4', '#ef4444', '#ec4899', '#94a3b8'];

function DonutChartBody({ chart }: { chart: DonutChartSpec }) {
  const { slices, unit, currencySymbol } = chart;

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie
          data={slices}
          dataKey="value"
          nameKey="label"
          innerRadius="55%"
          outerRadius="80%"
          paddingAngle={2}
          stroke="none"
        >
          {slices.map((s, i) => (
            <Cell key={`${s.label}-${i}`} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
          ))}
        </Pie>
        <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
        <Tooltip
          contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 11 }}
          formatter={(value, name) => [formatByUnit(Number(value), unit, currencySymbol), String(name)]}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

/** A compact, presentational chart card for one server-authored `ChartSpec`, sized for a chat bubble. */
export function ChartCard({ chart }: { chart: ChartSpec }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-xs font-semibold text-slate-700">{chart.title}</div>
      <div className="text-[10px] text-slate-400">{chart.source}</div>
      <div className="mt-2">
        {chart.kind === 'line' && <LineChartBody chart={chart} />}
        {chart.kind === 'bar' && <BarChartBody chart={chart} />}
        {chart.kind === 'donut' && <DonutChartBody chart={chart} />}
      </div>
    </div>
  );
}
