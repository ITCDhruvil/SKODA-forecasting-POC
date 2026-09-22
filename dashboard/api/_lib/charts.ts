// dashboard/api/_lib/charts.ts
//
// Server-side chart catalog. Every number in a ChartSpec is computed here from
// getDashboardJson()/getPartsIndex()/getPartHistory() — the model never types a
// chart number, it only picks a catalog id and a few parameters.
import { getDashboardJson, getPartHistory, getPartsIndex } from './data';
import { getTopMovers } from './tools';

export type Unit = 'pct' | 'currency' | 'number';

export interface ChartBase {
  title: string;
  unit: Unit;
  currencySymbol: string;
  source: string;
}

export interface LineChartSeries {
  key: string;
  label: string;
  style: 'solid' | 'dashed';
}

export interface LineChartPoint {
  x: string;
  [seriesKey: string]: string | number | null;
}

export interface LineChartBand {
  lowerKey: string;
  upperKey: string;
  label: string;
}

export interface LineChartSpec extends ChartBase {
  kind: 'line';
  points: LineChartPoint[];
  series: LineChartSeries[];
  band?: LineChartBand;
}

export interface BarChartSeries {
  key: string;
  label: string;
}

export interface BarChartRow {
  label: string;
  values: Record<string, number>;
  tone?: 'up' | 'down' | 'neutral';
}

export interface BarChartSpec extends ChartBase {
  kind: 'bar';
  orientation: 'horizontal' | 'vertical';
  series: BarChartSeries[];
  rows: BarChartRow[];
}

export interface DonutSlice {
  label: string;
  value: number;
}

export interface DonutChartSpec extends ChartBase {
  kind: 'donut';
  slices: DonutSlice[];
}

export type ChartSpec = LineChartSpec | BarChartSpec | DonutChartSpec;

export type HierarchyLevel = 'category' | 'vendor' | 'project';
export type ScenarioFamily = 'fx' | 'freight' | 'gpr' | 'duty';

export const CHART_IDS = [
  'mean_price_trend',
  'basket_forecast',
  'part_forecast',
  'top_movers',
  'category_forecast_change',
  'spend_share',
  'spend_change',
  'scenario_impact',
  'model_accuracy',
] as const;

export type ChartId = (typeof CHART_IDS)[number];

export interface BuildChartArgs {
  chart: ChartId;
  partId?: string;
  direction?: 'up' | 'down';
  n?: number;
  level?: HierarchyLevel;
  family?: ScenarioFamily;
  scenario?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatRunDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function roundCurrency(n: number): number {
  return Math.round(n);
}

function roundPct(n: number): number {
  return Math.round(n * 100) / 100;
}

function clampInt(n: number | undefined, min: number, max: number, dflt: number): number {
  if (n === undefined || Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function shorten(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function chartBase(title: string, unit: Unit): ChartBase {
  const d = getDashboardJson();
  return {
    title,
    unit,
    currencySymbol: d.meta.currencySymbol ?? '₹',
    source: `Dashboard data, forecast run ${formatRunDate(d.meta.generatedAt)}`,
  };
}

function buildMeanPriceTrend(): LineChartSpec {
  const d = getDashboardJson();
  const points: LineChartPoint[] = d.priceSeries.map((p) => ({
    x: p.month,
    actual: p.actual === null ? null : roundCurrency(p.actual),
    forecast: p.forecast === null ? null : roundCurrency(p.forecast),
    lower: p.lower === null ? null : roundCurrency(p.lower),
    upper: p.upper === null ? null : roundCurrency(p.upper),
  }));
  return {
    kind: 'line',
    ...chartBase('Average part price: actual and forecast', 'currency'),
    points,
    series: [
      { key: 'actual', label: 'Actual', style: 'solid' },
      { key: 'forecast', label: 'Forecast', style: 'dashed' },
    ],
    band: { lowerKey: 'lower', upperKey: 'upper', label: 'Forecast range' },
  };
}

function buildBasketForecast(): LineChartSpec {
  const d = getDashboardJson();
  const points: LineChartPoint[] = d.horizon.map((h) => ({
    x: h.month,
    value: roundCurrency(h.value),
    lower: h.lower === null ? null : roundCurrency(h.lower),
    upper: h.upper === null ? null : roundCurrency(h.upper),
  }));
  return {
    kind: 'line',
    ...chartBase('Total basket spend: next 6 months', 'currency'),
    points,
    series: [{ key: 'value', label: 'Forecast basket spend', style: 'dashed' }],
    band: { lowerKey: 'lower', upperKey: 'upper', label: 'Forecast range' },
  };
}

function buildPartForecast(partId: string | undefined): LineChartSpec | { error: string } {
  if (!partId) return { error: 'partId is required for part_forecast' };
  const rec = getPartsIndex().find((r) => r.partId.toLowerCase() === partId.toLowerCase());
  if (!rec) return { error: `no part found with id ${partId}` };

  const history = getPartHistory(rec.partId);
  const points: LineChartPoint[] = history.map((h) => ({
    x: h.month,
    actual: roundCurrency(h.price),
    forecast: null,
    lower: null,
    upper: null,
  }));
  // Join the last actual point to the first forecast point visually.
  if (points.length > 0) {
    points[points.length - 1].forecast = points[points.length - 1].actual;
  }
  for (const f of rec.forecast) {
    points.push({
      x: f.targetMonth.slice(0, 7),
      actual: null,
      forecast: roundCurrency(f.prediction),
      lower: roundCurrency(f.lower),
      upper: roundCurrency(f.upper),
    });
  }

  return {
    kind: 'line',
    ...chartBase(`${rec.partName}: price history and forecast`, 'currency'),
    points,
    series: [
      { key: 'actual', label: 'Actual', style: 'solid' },
      { key: 'forecast', label: 'Forecast', style: 'dashed' },
    ],
    band: { lowerKey: 'lower', upperKey: 'upper', label: 'Forecast range' },
  };
}

function buildTopMovers(direction: 'up' | 'down' | undefined, n: number | undefined): BarChartSpec | { error: string } {
  if (direction !== 'up' && direction !== 'down') return { error: "direction must be 'up' or 'down'" };
  const clamped = clampInt(n, 3, 10, 8);
  const movers = getTopMovers({ direction, n: clamped });
  if (!Array.isArray(movers)) return movers;

  const rows: BarChartRow[] = movers.map((m) => {
    const change = m.changePct ?? 0;
    return {
      label: shorten(m.partName, 40),
      values: { change: roundPct(change) },
      tone: change >= 0 ? 'up' : 'down',
    };
  });

  return {
    kind: 'bar',
    orientation: 'horizontal',
    ...chartBase(`Biggest forecast price ${direction === 'up' ? 'increases' : 'decreases'} (next month)`, 'pct'),
    series: [{ key: 'change', label: 'Forecast change (next month)' }],
    rows,
  };
}

function buildCategoryForecastChange(): BarChartSpec {
  const d = getDashboardJson();
  const rows: BarChartRow[] = [...d.categories]
    .sort((a, b) => b.forecastChange - a.forecastChange)
    .map((c) => ({
      label: c.category,
      values: { change: roundPct(c.forecastChange) },
      tone: c.forecastChange >= 0 ? 'up' : 'down',
    }));

  return {
    kind: 'bar',
    orientation: 'horizontal',
    ...chartBase(`Forecast price change by category (+${d.meta.forecastHorizon} months)`, 'pct'),
    series: [{ key: 'change', label: 'Forecast change' }],
    rows,
  };
}

function buildSpendShare(level: HierarchyLevel = 'category'): DonutChartSpec | { error: string } {
  const d = getDashboardJson();
  let entries: { label: string; value: number }[];
  if (level === 'category') {
    entries = d.categories.map((c) => ({ label: c.category, value: c.value }));
  } else {
    const rows = d.hierarchy?.[level];
    if (!rows) return { error: `no hierarchy data for level "${level}"` };
    entries = rows.map((r) => ({ label: r.name, value: r.currentSpend }));
  }
  entries = [...entries].sort((a, b) => b.value - a.value);
  const top = entries.slice(0, 8);
  const restSum = entries.slice(8).reduce((sum, e) => sum + e.value, 0);
  const slices: DonutSlice[] = top.map((e) => ({ label: e.label, value: roundCurrency(e.value) }));
  if (restSum > 0) slices.push({ label: 'Other', value: roundCurrency(restSum) });

  return {
    kind: 'donut',
    ...chartBase(`Spend share by ${level}`, 'currency'),
    slices,
  };
}

function buildSpendChange(level: HierarchyLevel = 'category'): BarChartSpec | { error: string } {
  const rows = getDashboardJson().hierarchy?.[level];
  if (!rows) return { error: `no hierarchy data for level "${level}"` };
  const top = [...rows].sort((a, b) => b.currentSpend - a.currentSpend).slice(0, 8);
  const barRows: BarChartRow[] = top.map((r) => ({
    label: r.name,
    values: { current: roundCurrency(r.currentSpend), forecast: roundCurrency(r.forecastSpend) },
  }));

  return {
    kind: 'bar',
    orientation: 'vertical',
    ...chartBase(`Spend today vs forecast, by ${level}`, 'currency'),
    series: [
      { key: 'current', label: 'Current spend' },
      { key: 'forecast', label: 'Forecast spend' },
    ],
    rows: barRows,
  };
}

const SCENARIO_FAMILIES: readonly ScenarioFamily[] = ['fx', 'freight', 'gpr', 'duty'];

function buildScenarioImpact(
  family: ScenarioFamily | undefined,
  scenarioName: string | undefined,
  level: HierarchyLevel = 'category',
): BarChartSpec | { error: string } {
  if (!family || !SCENARIO_FAMILIES.includes(family)) {
    return { error: `unknown family "${family}"; valid: ${SCENARIO_FAMILIES.join(', ')}` };
  }
  const d = getDashboardJson();
  let rows: { name: string; value: number }[];

  if (family === 'fx') {
    const scenarios = d.fxAnalysis?.scenarios ?? [];
    const validNames = scenarios.map((s) => s.name);
    const scenario = scenarios.find((s) => s.name === scenarioName);
    if (!scenario) {
      return { error: `unknown scenario "${scenarioName}" for family "fx"; valid: ${validNames.join(', ')}` };
    }
    rows = (scenario.byLevel[level] ?? []).map((r) => ({ name: r.name, value: r.changePct }));
  } else {
    const scenarios = (d.geoAnalysis?.scenarios ?? []).filter((s) => s.family === family);
    const validNames = scenarios.map((s) => s.name);
    const scenario = scenarios.find((s) => s.name === scenarioName);
    if (!scenario) {
      return { error: `unknown scenario "${scenarioName}" for family "${family}"; valid: ${validNames.join(', ')}` };
    }
    rows = (scenario.byLevel[level] ?? []).map((r) => ({ name: r.name, value: r.priceChangePct }));
  }

  rows = [...rows].sort((a, b) => b.value - a.value);
  const barRows: BarChartRow[] = rows.map((r) => ({
    label: r.name,
    values: { change: roundPct(r.value) },
    tone: r.value >= 0 ? 'up' : 'down',
  }));

  return {
    kind: 'bar',
    orientation: 'horizontal',
    ...chartBase(`${scenarioName}: modeled price impact by ${level}`, 'pct'),
    series: [{ key: 'change', label: 'Modeled price impact' }],
    rows: barRows,
  };
}

function buildModelAccuracy(): BarChartSpec {
  const d = getDashboardJson();
  const rows: BarChartRow[] = [...d.modelComparison]
    .sort((a, b) => a.mape - b.mape)
    .map((m) => ({ label: m.model, values: { mape: roundPct(m.mape) } }));

  return {
    kind: 'bar',
    orientation: 'horizontal',
    ...chartBase('Forecast error (MAPE) by model', 'pct'),
    series: [{ key: 'mape', label: 'MAPE' }],
    rows,
  };
}

/** Builds one chart spec from the fixed catalog. Every number comes from the dashboard data. */
export function buildChart(args: BuildChartArgs): ChartSpec | { error: string } {
  switch (args.chart) {
    case 'mean_price_trend':
      return buildMeanPriceTrend();
    case 'basket_forecast':
      return buildBasketForecast();
    case 'part_forecast':
      return buildPartForecast(args.partId);
    case 'top_movers':
      return buildTopMovers(args.direction, args.n);
    case 'category_forecast_change':
      return buildCategoryForecastChange();
    case 'spend_share':
      return buildSpendShare(args.level);
    case 'spend_change':
      return buildSpendChange(args.level);
    case 'scenario_impact':
      return buildScenarioImpact(args.family, args.scenario, args.level ?? 'category');
    case 'model_accuracy':
      return buildModelAccuracy();
    default:
      return { error: `unknown chart "${String(args.chart)}"; valid: ${CHART_IDS.join(', ')}` };
  }
}
