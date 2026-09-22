// dashboard/api/_lib/tools.ts
import { changePct, getDashboardJson, getPartsIndex, type PartRecord } from './data';
import { getExposure } from './exposure';
import { getAllStatuses, setStatus, type KvHashClient } from './hitlStatus';
import { kv } from './kvClient';

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

function summarizePart(rec: PartRecord) {
  const horizon1 = rec.forecast.find((f) => f.horizon === 1) ?? null;
  return {
    partId: rec.partId,
    partName: rec.partName,
    category: rec.category,
    vendor: rec.vendor,
    project: rec.project,
    currentPrice: rec.currentPrice,
    forecastPrice: horizon1?.prediction ?? null,
    changePct: changePct(rec.currentPrice, horizon1?.prediction ?? null),
    isAnomalyPart: rec.isAnomalyPart,
  };
}

const SEARCH_RESULT_LIMIT = 25;

export function searchParts(args: {
  query?: string;
  category?: string;
  vendor?: string;
  project?: string;
}) {
  const q = args.query?.toLowerCase().trim();
  const matches = getPartsIndex().filter((rec) => {
    if (q && !(rec.partId.toLowerCase().includes(q) || rec.partName.toLowerCase().includes(q))) {
      return false;
    }
    if (args.category && rec.category.toLowerCase() !== args.category.toLowerCase()) return false;
    if (args.vendor && rec.vendor.toLowerCase() !== args.vendor.toLowerCase()) return false;
    if (args.project && rec.project.toLowerCase() !== args.project.toLowerCase()) return false;
    return true;
  });
  return {
    totalMatches: matches.length,
    results: matches.slice(0, SEARCH_RESULT_LIMIT).map(summarizePart),
  };
}

export function getPartForecast(args: { partId: string }) {
  const rec = getPartsIndex().find((r) => r.partId.toLowerCase() === args.partId?.toLowerCase());
  if (!rec) return { error: `no part found with id ${args.partId}` };
  return rec;
}

export function getTopMovers(args: { direction: 'up' | 'down'; n?: number }) {
  if (args.direction !== 'up' && args.direction !== 'down') {
    return { error: "direction must be 'up' or 'down'" };
  }
  const n = args.n ?? 10;
  const withChange = getPartsIndex()
    .map((rec) => ({
      rec,
      change: changePct(rec.currentPrice, rec.forecast.find((f) => f.horizon === 1)?.prediction ?? null),
    }))
    .filter((x): x is { rec: PartRecord; change: number } => x.change !== null);
  withChange.sort((a, b) => (args.direction === 'up' ? b.change - a.change : a.change - b.change));
  return withChange.slice(0, n).map((x) => summarizePart(x.rec));
}

export function getKpis() {
  const d = getDashboardJson();
  return { kpis: d.kpis, meta: d.meta };
}

export function getCategoryBreakdown() {
  return { categories: getDashboardJson().categories };
}

export function getModelComparison() {
  const d = getDashboardJson();
  return { modelComparison: d.modelComparison, backtestSummary: d.backtestSummary };
}

export function getValidationSummary() {
  return { validation: getDashboardJson().validation };
}

export function getFutureTestResults() {
  return { futureTest: getDashboardJson().futureTest };
}

export function getFxScenarios() {
  return { scenarios: getDashboardJson().fxAnalysis?.scenarios ?? [] };
}

export function getGeoScenarios(args: { family?: string }) {
  const scenarios = getDashboardJson().geoAnalysis?.scenarios ?? [];
  const filtered = args.family ? scenarios.filter((s) => s.family === args.family) : scenarios;
  return { scenarios: filtered };
}

export function getGeoEventStudies() {
  return { eventStudies: getDashboardJson().geoAnalysis?.eventStudies ?? [] };
}

const HIERARCHY_LEVELS = ['project', 'vendor', 'category'];

export function getHierarchy(args: { level: string }) {
  const h = getDashboardJson().hierarchy;
  if (!h || !HIERARCHY_LEVELS.includes(args.level) || !(args.level in h)) {
    return { error: `no hierarchy data for level "${args.level}" (valid: ${HIERARCHY_LEVELS.join(', ')})` };
  }
  return { level: args.level, data: h[args.level] };
}

export function getAlerts() {
  return { alerts: getDashboardJson().alerts };
}

export function getDataProvenance() {
  const d = getDashboardJson();
  return { dataSources: d.dataSources, provenance: d.provenance };
}

export async function getGeoHitlAlerts(client: KvHashClient): Promise<
  | {
      totalCount: number;
      pendingCount: number;
      alerts: {
        alertId: string;
        headline: string;
        category: string;
        severity: number;
        regionScope: string;
        status: string;
      }[];
    }
  | { error: string }
> {
  const alerts = getDashboardJson().geoAnalysis?.hitl?.alerts ?? [];
  const statuses = await getAllStatuses(client);
  // Note: `HitlStatusMap`'s string index signature means TypeScript can't narrow
  // `statuses` down to `{ error: string }` inside `if ('error' in statuses)` — it
  // keeps the full union there. Checking the negation narrows the success case
  // (`HitlStatusMap`) correctly, so we branch on that instead and cast the
  // (structurally guaranteed) error case on the way out.
  if (!('error' in statuses)) {
    const mapped = alerts.map((a) => ({
      alertId: a.alertId,
      headline: a.headline,
      category: a.category,
      severity: a.severity,
      regionScope: a.regionScope,
      status: statuses[a.alertId] ?? 'pending',
    }));
    const pendingCount = alerts.filter((a) => !(a.alertId in statuses)).length;
    return {
      totalCount: mapped.length,
      pendingCount,
      alerts: mapped,
    };
  }
  return statuses as { error: string };
}

export async function confirmGeoAlert(client: KvHashClient, args: { alertId: string }) {
  const result = await setStatus(client, args.alertId, 'confirmed');
  if ('error' in result) return result;
  const alerts = getDashboardJson().geoAnalysis?.hitl?.alerts ?? [];
  const alert = alerts.find((a) => a.alertId === args.alertId);
  return { ok: true as const, impact: alert?.impact ?? null };
}

export async function dismissGeoAlert(client: KvHashClient, args: { alertId: string }) {
  return setStatus(client, args.alertId, 'dismissed');
}

// Handlers may be synchronous or async (returning a plain value or a Promise<value>);
// runChatLoop always `await`s the result, so either style works. Because the return
// type here is `unknown` rather than `unknown | Promise<unknown>`, TypeScript won't
// flag a caller that forgets to await — that's exactly how an un-awaited async handler
// (serializing to "{}") shipped once before, so don't rely on the type system to catch it again.
export const TOOL_HANDLERS: Record<string, (args: any) => unknown> = {
  searchParts,
  getPartForecast,
  getTopMovers,
  getKpis,
  getCategoryBreakdown,
  getModelComparison,
  getValidationSummary,
  getFutureTestResults,
  getFxScenarios,
  getGeoScenarios,
  getGeoEventStudies,
  getHierarchy,
  getAlerts,
  getDataProvenance,
  getExposure,
  getGeoHitlAlerts: () => getGeoHitlAlerts(kv),
  confirmGeoAlert: (args) => confirmGeoAlert(kv, args),
  dismissGeoAlert: (args) => dismissGeoAlert(kv, args),
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'searchParts',
      description: 'Search across all 480 parts by name/id substring and optional category/vendor/project filters. Returns up to 25 matches.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to match against part id or part name' },
          category: { type: 'string' },
          vendor: { type: 'string' },
          project: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getPartForecast',
      description: 'Get full detail for one part: current price and its 6-month forecast curve.',
      parameters: {
        type: 'object',
        properties: { partId: { type: 'string' } },
        required: ['partId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getTopMovers',
      description: 'Get the parts with the biggest forecast price change (next-month horizon) across all 480 parts.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'] },
          n: { type: 'number', description: 'How many to return, default 10' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getKpis',
      description: 'Get the headline KPIs shown on the main dashboard (basket price, change, etc.) plus run metadata.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getCategoryBreakdown',
      description: 'Get spend and forecast-change breakdown by part category.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getModelComparison',
      description: 'Get model comparison (xgboost/sarima/seasonal_naive) and backtest stability summary.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getValidationSummary',
      description: 'Get how well the forecasts validate against real published BLS data.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getFutureTestResults',
      description: 'Get the simulated-future test results (forecast blind, then scored against held-out data).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getFxScenarios',
      description: 'Get FX shock scenarios and their modeled price impact.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getGeoScenarios',
      description: 'Get geopolitical shock scenarios and their modeled price impact, optionally filtered by family (freight/gpr/duty).',
      parameters: {
        type: 'object',
        properties: { family: { type: 'string', enum: ['freight', 'gpr', 'duty'] } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getGeoEventStudies',
      description: 'Get curated geopolitical event studies (event, channel, price response over time).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getHierarchy',
      description: 'Get spend/forecast rollups at a given hierarchy level.',
      parameters: {
        type: 'object',
        properties: { level: { type: 'string', enum: ['project', 'vendor', 'category'] } },
        required: ['level'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getAlerts',
      description: 'Get parts whose forecast movement warrants a procurement review.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getDataProvenance',
      description: 'Get the provenance of every data source feeding the dashboard (macro anchor, FX, freight, etc.).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getExposure',
      description:
        'Use whenever the user asks how news or an external factor affects our parts or our forecast: a commodity (steel, aluminium, copper, plastics, electronics), or a scenario driver (freight, duty, geopolitics, fx). Commodity drivers return an assumed category mapping (spend, share, forecast change, top parts per category), clearly labelled as an assumption, not a bill of materials. Scenario drivers return the matching modeled shock scenarios (freight/duty/geopolitical/FX) and their price impact by category/vendor/project.',
      parameters: {
        type: 'object',
        properties: {
          driver: {
            type: 'string',
            enum: ['steel', 'aluminium', 'copper', 'plastics', 'electronics', 'freight', 'duty', 'geopolitics', 'fx'],
          },
        },
        required: ['driver'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getGeoHitlAlerts',
      description: 'List geopolitical HITL alerts awaiting analyst review, with their current status (pending/confirmed/dismissed). The response includes totalCount and pendingCount fields — when answering, the number of alerts you list must exactly match the relevant count field, never fewer.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirmGeoAlert',
      description: 'Confirm a geopolitical alert, revealing its precomputed price impact. Use getGeoHitlAlerts first to find the right alertId.',
      parameters: {
        type: 'object',
        properties: { alertId: { type: 'string' } },
        required: ['alertId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dismissGeoAlert',
      description: 'Dismiss a geopolitical alert (no impact shown). Use getGeoHitlAlerts first to find the right alertId.',
      parameters: {
        type: 'object',
        properties: { alertId: { type: 'string' } },
        required: ['alertId'],
      },
    },
  },
];
