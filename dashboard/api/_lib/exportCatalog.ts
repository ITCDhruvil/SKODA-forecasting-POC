//
// Server-side export catalog. Every value in an ExportData is computed here from
// getDashboardJson()/getPartsIndex() – the model never types an exported number,
// it only picks a catalog id and a few parameters. Sibling of charts.ts, kept
// separate because a chart must stay readable and an export does not.
import type { HierarchyLevel, ScenarioFamily } from './charts';
import { changePct, getDashboardJson, getPartsIndex, type PartRecord } from './data';

export const EXPORT_IDS = [
  'parts_search',
  'top_movers',
  'category_breakdown',
  'hierarchy',
  'alerts',
  'scenarios',
] as const;

export type ExportId = (typeof EXPORT_IDS)[number];

/** A serverless function must not become a memory bomb over a cell count nobody will read. */
export const MAX_EXPORT_ROWS = 5000;

const DEFAULT_TOP_MOVERS = 20;

export interface ExportColumn {
  key: string;
  label: string;
}

export type ExportCell = string | number | null;

export interface ExportData {
  title: string;
  columns: ExportColumn[];
  rows: Record<string, ExportCell>[];
  /** Provenance line written into the file, same idea as ChartBase.source. */
  source: string;
  truncated: boolean;
}

export interface BuildExportArgs {
  export: ExportId;
  direction?: 'up' | 'down';
  n?: number;
  level?: HierarchyLevel;
  family?: ScenarioFamily;
  query?: string;
  category?: string;
  vendor?: string;
  project?: string;
}

function cap(rows: Record<string, ExportCell>[]): { rows: Record<string, ExportCell>[]; truncated: boolean } {
  if (rows.length <= MAX_EXPORT_ROWS) return { rows, truncated: false };
  return { rows: rows.slice(0, MAX_EXPORT_ROWS), truncated: true };
}

const PART_COLUMNS: ExportColumn[] = [
  { key: 'partId', label: 'Part ID' },
  { key: 'partName', label: 'Part name' },
  { key: 'category', label: 'Category' },
  { key: 'vendor', label: 'Vendor' },
  { key: 'project', label: 'Project' },
  { key: 'currentPrice', label: 'Current price' },
  { key: 'forecastPrice', label: 'Forecast price (next month)' },
  { key: 'changePct', label: 'Change %' },
];

function partRow(rec: PartRecord): Record<string, ExportCell> {
  const forecast = rec.forecast.find((f) => f.horizon === 1)?.prediction ?? null;
  return {
    partId: rec.partId,
    partName: rec.partName,
    category: rec.category,
    vendor: rec.vendor,
    project: rec.project,
    currentPrice: rec.currentPrice,
    forecastPrice: forecast,
    changePct: changePct(rec.currentPrice, forecast),
  };
}

function buildPartsSearch(args: BuildExportArgs): ExportData | { error: string } {
  const q = args.query?.toLowerCase().trim();
  const matches = getPartsIndex().filter((rec) => {
    if (q && !(rec.partId.toLowerCase().includes(q) || rec.partName.toLowerCase().includes(q))) return false;
    if (args.category && rec.category.toLowerCase() !== args.category.toLowerCase()) return false;
    if (args.vendor && rec.vendor.toLowerCase() !== args.vendor.toLowerCase()) return false;
    if (args.project && rec.project.toLowerCase() !== args.project.toLowerCase()) return false;
    return true;
  });
  if (matches.length === 0) return { error: 'no parts match those filters' };

  const { rows, truncated } = cap(matches.map(partRow));
  const filters = [args.query, args.category, args.vendor, args.project].filter(Boolean).join(', ');
  return {
    title: filters ? `Parts matching ${filters}` : 'All parts',
    columns: PART_COLUMNS,
    rows,
    source: 'dashboard.json part index (current price and next-month forecast)',
    truncated,
  };
}

function buildTopMovers(args: BuildExportArgs): ExportData | { error: string } {
  if (args.direction !== 'up' && args.direction !== 'down') {
    return { error: "top_movers needs direction 'up' or 'down'" };
  }
  const n = Math.max(1, Math.min(args.n ?? DEFAULT_TOP_MOVERS, MAX_EXPORT_ROWS));
  const scored: { rec: PartRecord; change: number }[] = [];
  for (const rec of getPartsIndex()) {
    const change = changePct(rec.currentPrice, rec.forecast.find((f) => f.horizon === 1)?.prediction ?? null);
    if (change !== null) scored.push({ rec, change });
  }
  if (scored.length === 0) return { error: 'no parts have a next-month forecast' };

  scored.sort((a, b) => (args.direction === 'up' ? b.change - a.change : a.change - b.change));
  const { rows, truncated } = cap(scored.slice(0, n).map((x) => partRow(x.rec)));
  return {
    title: `Top ${rows.length} ${args.direction === 'up' ? 'rising' : 'falling'} parts`,
    columns: PART_COLUMNS,
    rows,
    source: 'dashboard.json part index, ranked by next-month forecast change',
    truncated,
  };
}

function buildCategoryBreakdown(): ExportData | { error: string } {
  const categories = getDashboardJson().categories ?? [];
  if (categories.length === 0) return { error: 'no category breakdown available' };
  const { rows, truncated } = cap(
    categories.map((c) => ({
      category: c.category,
      value: c.value,
      share: c.share,
      forecastChange: c.forecastChange,
      parts: c.parts,
    })),
  );
  return {
    title: 'Spend by category',
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'value', label: 'Current spend' },
      { key: 'share', label: 'Share of total' },
      { key: 'forecastChange', label: 'Forecast change %' },
      { key: 'parts', label: 'Parts' },
    ],
    rows,
    source: 'dashboard.json category breakdown',
    truncated,
  };
}

const HIERARCHY_LEVELS: readonly string[] = ['project', 'vendor', 'category'];

function buildHierarchy(args: BuildExportArgs): ExportData | { error: string } {
  const level = args.level ?? 'category';
  const rollup = getDashboardJson().hierarchy;
  if (!HIERARCHY_LEVELS.includes(level) || !rollup || !(level in rollup)) {
    return { error: `no hierarchy data for level "${level}" (valid: ${HIERARCHY_LEVELS.join(', ')})` };
  }
  const { rows, truncated } = cap(
    rollup[level].map((r) => ({
      name: r.name,
      parts: r.parts,
      currentSpend: r.currentSpend,
      forecastSpend: r.forecastSpend,
      changePct: r.changePct,
      changeAbs: r.changeAbs,
    })),
  );
  return {
    title: `Spend rollup by ${level}`,
    columns: [
      { key: 'name', label: level === 'project' ? 'Project' : level === 'vendor' ? 'Vendor' : 'Category' },
      { key: 'parts', label: 'Parts' },
      { key: 'currentSpend', label: 'Current spend' },
      { key: 'forecastSpend', label: 'Forecast spend' },
      { key: 'changePct', label: 'Change %' },
      { key: 'changeAbs', label: 'Change (absolute)' },
    ],
    rows,
    source: `dashboard.json hierarchy rollup (${level})`,
    truncated,
  };
}

function buildAlerts(): ExportData | { error: string } {
  const alerts = getDashboardJson().alerts ?? [];
  if (alerts.length === 0) return { error: 'no alerts are currently raised' };
  const { rows, truncated } = cap(
    alerts.map((a) => ({
      partId: a.partId,
      title: a.title,
      severity: a.severity,
      change: a.change,
      message: a.message,
    })),
  );
  return {
    title: 'Parts flagged for procurement review',
    columns: [
      { key: 'partId', label: 'Part ID' },
      { key: 'title', label: 'Alert' },
      { key: 'severity', label: 'Severity' },
      { key: 'change', label: 'Forecast change %' },
      { key: 'message', label: 'Detail' },
    ],
    rows,
    source: 'dashboard.json alerts',
    truncated,
  };
}

function buildScenarios(args: BuildExportArgs): ExportData | { error: string } {
  const d = getDashboardJson();
  const fx = (d.fxAnalysis?.scenarios ?? []).map((s) => ({
    family: 'fx' as string,
    name: s.name,
    shockPct: s.shockPct,
    overallPriceChangePct: s.overallPriceChangePct,
    impliedElasticity: s.impliedElasticity,
    pairs: s.pairs.join(', '),
  }));
  const geo = (d.geoAnalysis?.scenarios ?? []).map((s) => ({
    family: s.family,
    name: s.name,
    shockPct: s.shockPct,
    overallPriceChangePct: s.overallPriceChangePct,
    impliedElasticity: s.impliedElasticity,
    pairs: s.pairs.join(', '),
  }));

  const all = [...fx, ...geo];
  const filtered = args.family ? all.filter((s) => s.family === args.family) : all;
  if (filtered.length === 0) {
    return { error: args.family ? `no scenarios in family "${args.family}"` : 'no scenarios available' };
  }

  const { rows, truncated } = cap(filtered);
  return {
    title: args.family ? `${args.family.toUpperCase()} shock scenarios` : 'Shock scenarios',
    columns: [
      { key: 'family', label: 'Family' },
      { key: 'name', label: 'Scenario' },
      { key: 'shockPct', label: 'Shock %' },
      { key: 'overallPriceChangePct', label: 'Overall price change %' },
      { key: 'impliedElasticity', label: 'Implied elasticity' },
      { key: 'pairs', label: 'Drivers' },
    ],
    rows,
    source: 'dashboard.json FX and geopolitical scenario analysis',
    truncated,
  };
}

export function buildExportData(args: BuildExportArgs): ExportData | { error: string } {
  switch (args.export) {
    case 'parts_search':
      return buildPartsSearch(args);
    case 'top_movers':
      return buildTopMovers(args);
    case 'category_breakdown':
      return buildCategoryBreakdown();
    case 'hierarchy':
      return buildHierarchy(args);
    case 'alerts':
      return buildAlerts();
    case 'scenarios':
      return buildScenarios(args);
    default:
      return { error: `unknown export "${String(args.export)}"; valid: ${EXPORT_IDS.join(', ')}` };
  }
}
