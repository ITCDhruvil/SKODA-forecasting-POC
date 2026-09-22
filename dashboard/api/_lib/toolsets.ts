import { buildChart, CHART_IDS, type BarChartSpec, type ChartSpec, type DonutChartSpec, type LineChartSpec, type Unit } from './charts';
import type { Mode } from './router';
import { TOOL_DEFINITIONS, TOOL_HANDLERS, type ToolDefinition } from './tools';

export const WRITE_TOOL_NAMES = ['confirmGeoAlert', 'dismissGeoAlert'] as const;
const ACTION_TOOL_NAMES: readonly string[] = ['getGeoHitlAlerts', ...WRITE_TOOL_NAMES];

const MAX_CHARTS_PER_ANSWER = 2;

export interface Toolset {
  definitions: ToolDefinition[];
  handlers: Record<string, (args: any) => unknown>;
  webSearch: boolean;
}

export interface BuildToolsetOptions {
  /** Called once for every distinct chart the model successfully draws this request. */
  onChart?: (chart: ChartSpec) => void;
}

function pick(names: (name: string) => boolean): Pick<Toolset, 'definitions' | 'handlers'> {
  const definitions = TOOL_DEFINITIONS.filter((d) => names(d.function.name));
  const handlers: Record<string, (args: any) => unknown> = {};
  for (const d of definitions) handlers[d.function.name] = TOOL_HANDLERS[d.function.name];
  return { definitions, handlers };
}

function formatValue(unit: Unit, value: number, currencySymbol: string): string {
  if (unit === 'pct') return `${value >= 0 ? '+' : ''}${value}%`;
  if (unit === 'currency') return `${currencySymbol}${Math.round(value)}`;
  return `${value}`;
}

/** Up to 5 "label: value" strings the model can use to talk about a chart it just drew. */
function summarizeChart(spec: ChartSpec): string[] {
  if (spec.kind === 'donut') {
    const donut = spec as DonutChartSpec;
    return donut.slices.slice(0, 5).map((s) => `${s.label}: ${formatValue(spec.unit, s.value, spec.currencySymbol)}`);
  }
  if (spec.kind === 'bar') {
    const bar = spec as BarChartSpec;
    const key = bar.series[0]?.key;
    return bar.rows.slice(0, 5).map((r) => `${r.label}: ${formatValue(spec.unit, r.values[key] ?? 0, spec.currencySymbol)}`);
  }
  const line = spec as LineChartSpec;
  const primaryKey = line.series[line.series.length - 1]?.key ?? 'value';
  const withValue = line.points.filter((p) => typeof p[primaryKey] === 'number');
  return withValue
    .slice(-5)
    .map((p) => `${p.x}: ${formatValue(spec.unit, p[primaryKey] as number, spec.currencySymbol)}`);
}

/** A stable key for deduping identical calls: same chart id, same params, in any key order. */
function callKey(args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      if (args[k] !== undefined) acc[k] = args[k];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

function showChartDefinition(): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'showChart',
      description:
        'Draw a chart from dashboard data for the user to see, alongside your text answer. Call it only when the answer compares or ranks 3+ comparable values, shows each item\'s share of a total, or shows a trend over time; at most twice per answer. Match the chart to the question: trend or "how will it move" => mean_price_trend (average price, actual+forecast), basket_forecast (total basket, next 6mo) or part_forecast (one part; needs partId); ranking => top_movers (needs direction), category_forecast_change or model_accuracy; "where is our spend" => spend_share (share of a total) or spend_change (current vs forecast); scenario impact => scenario_impact (needs family and the exact scenario name).',
      parameters: {
        type: 'object',
        properties: {
          chart: { type: 'string', enum: [...CHART_IDS] },
          partId: { type: 'string', description: 'Required for part_forecast.' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'Required for top_movers.' },
          n: { type: 'number', description: 'top_movers only: how many parts to show, 3-10, default 8.' },
          level: {
            type: 'string',
            enum: ['category', 'vendor', 'project'],
            description: 'spend_share/spend_change/scenario_impact, default category.',
          },
          family: {
            type: 'string',
            enum: ['fx', 'freight', 'gpr', 'duty'],
            description: 'Required for scenario_impact.',
          },
          scenario: { type: 'string', description: 'Required for scenario_impact: the exact scenario name.' },
        },
        required: ['chart'],
      },
    },
  };
}

function buildShowChartHandler(onChart?: (chart: ChartSpec) => void): (args: any) => unknown {
  const drawnKeys = new Set<string>();
  let drawnCount = 0;

  return (args: any) => {
    const chartId = args?.chart;
    if (typeof chartId !== 'string' || !(CHART_IDS as readonly string[]).includes(chartId)) {
      return { error: `unknown chart "${chartId}"; valid: ${CHART_IDS.join(', ')}` };
    }

    const key = callKey(args ?? {});
    if (drawnKeys.has(key)) return { ok: true, note: 'already drawn' };
    if (drawnCount >= MAX_CHARTS_PER_ANSWER) {
      return { error: `chart limit reached (${MAX_CHARTS_PER_ANSWER} per answer)` };
    }

    const spec = buildChart(args);
    if ('error' in spec) return { error: spec.error };

    drawnKeys.add(key);
    drawnCount += 1;
    onChart?.(spec);

    return { ok: true, drawn: spec.title, kind: spec.kind, summary: summarizeChart(spec) };
  };
}

/**
 * Tools available for one request. Write tools are included only in `action` mode, and
 * because handlers are copied per mode, a `web` request cannot resolve them even if the
 * model hallucinates a call to one. `showChart` is built fresh per call (a per-request
 * collector) and offered only in `data`/`web` modes; `opts.onChart` receives every
 * distinct chart the model successfully draws.
 */
export function buildToolset(mode: Mode, opts: BuildToolsetOptions = {}): Toolset {
  if (mode === 'action') return { ...pick((n) => ACTION_TOOL_NAMES.includes(n)), webSearch: false };

  const read = pick((n) => !(WRITE_TOOL_NAMES as readonly string[]).includes(n));
  return {
    definitions: [...read.definitions, showChartDefinition()],
    handlers: { ...read.handlers, showChart: buildShowChartHandler(opts.onChart) },
    webSearch: mode === 'web',
  };
}
