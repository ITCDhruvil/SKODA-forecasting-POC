import type {
  MaterialBridgeId,
  MaterialCost,
  MaterialPartRow,
  MaterialPricePoint,
  MaterialWalkId,
  MaterialWaterfallStep,
} from '../types';
import { MATERIAL_WALK_BRIDGES } from '../types';

export type HierarchyFilterState = {
  project: string;
  vendor: string;
  category: string;
  material: string;
  partQuery: string;
};

export const EMPTY_HIERARCHY_FILTERS: HierarchyFilterState = {
  project: 'all',
  vendor: 'all',
  category: 'all',
  material: 'all',
  partQuery: '',
};

export type MaterialCostView = {
  parts: MaterialPartRow[];
  summary: NonNullable<MaterialCost['summary']>;
  waterfall: MaterialWaterfallStep[];
  priceSeries: MaterialPricePoint[];
  /** True when any hierarchy dimension (not part search) is narrowed. */
  isScoped: boolean;
  nPartsTotal: number;
};

const RESIDUAL_BRIDGES: MaterialBridgeId[] = [
  'vendorReprice',
  'mix',
  'seasonality',
  'unexplained',
];

const BRIDGE_NOTES: Record<string, string> = {
  budget: 'Sum of Budget (BG) unit prices in the filtered slice',
  fx: 'Currency attribution for the filtered slice',
  commodity: 'Materials attribution for the filtered slice',
  freight: 'Shipping attribution for the filtered slice',
  vendorReprice:
    'Nomination→SOP piece-price move not explained by FX / materials / shipping',
  mix: 'Cross-sectional deviation vs portfolio median BG→FC move',
  seasonality: 'History oscillation around the Nomination→SOP trend',
  unexplained: 'Model / residual remainder — closes Budget → Forecast exactly',
  forecast: 'Primary model forecast for the filtered slice',
};

function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function isHierarchyScoped(filters: HierarchyFilterState): boolean {
  return (
    filters.project !== 'all' ||
    filters.vendor !== 'all' ||
    filters.category !== 'all' ||
    filters.material !== 'all'
  );
}

export function filterMaterialParts(
  parts: MaterialPartRow[],
  filters: HierarchyFilterState,
): MaterialPartRow[] {
  const q = filters.partQuery.trim().toLowerCase();
  return parts.filter((p) => {
    if (filters.project !== 'all' && p.project !== filters.project) return false;
    if (filters.vendor !== 'all' && p.vendor !== filters.vendor) return false;
    if (filters.category !== 'all' && p.category !== filters.category) return false;
    if (filters.material !== 'all' && p.material !== filters.material) return false;
    if (q) {
      const hay = `${p.partId} ${p.partName} ${p.vendor} ${p.category} ${p.material}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * True drill-down: keep parts where the selected driver is material —
 * meaningful share of that part's BG→FC move, dominant bridge, or top
 * contributors covering most of the driver pool.
 */
export function filterPartsByBridge(
  parts: MaterialPartRow[],
  bridgeId: MaterialBridgeId,
): MaterialPartRow[] {
  const scored = parts
    .map((p) => ({ part: p, value: Math.abs(Number(p.bridges?.[bridgeId]) || 0) }))
    .filter((x) => x.value > 1e-9);

  if (scored.length === 0) return [];

  const poolAbs = scored.reduce((s, x) => s + x.value, 0);
  const SHARE_OF_PART = 0.1;
  const MIN_ABS = 1;
  const CUM_COVER = 0.85;

  const byMateriality = scored.filter(({ part, value }) => {
    const move = Math.max(Math.abs(Number(part.changeAbs) || 0), 1);
    if (value / move >= SHARE_OF_PART) return true;
    if (value < MIN_ABS) return false;
    const bridges = part.bridges ?? {};
    const maxOther = Math.max(
      0,
      ...Object.entries(bridges)
        .filter(([k]) => k !== bridgeId && k !== 'other')
        .map(([, v]) => Math.abs(Number(v) || 0)),
    );
    return value >= maxOther;
  });

  // Also keep top contributors until ~85% of |driver| is covered.
  const ranked = [...scored].sort((a, b) => b.value - a.value);
  const coverIds = new Set<string>();
  let cum = 0;
  for (const row of ranked) {
    coverIds.add(row.part.partId);
    cum += row.value;
    if (poolAbs > 0 && cum / poolAbs >= CUM_COVER) break;
  }

  const keep = new Set([
    ...byMateriality.map((x) => x.part.partId),
    ...coverIds,
  ]);

  return scored
    .filter((x) => keep.has(x.part.partId))
    .sort((a, b) => b.value - a.value)
    .map((x) => x.part);
}

/** Cascading option lists from the current filter state (downstream respects upstream). */
export function hierarchyOptions(
  parts: MaterialPartRow[],
  filters: HierarchyFilterState,
): {
  projects: string[];
  vendors: string[];
  categories: string[];
  materials: string[];
} {
  const projects = sortedUnique(parts.map((p) => p.project));

  const afterProject =
    filters.project === 'all'
      ? parts
      : parts.filter((p) => p.project === filters.project);
  const vendors = sortedUnique(afterProject.map((p) => p.vendor));

  const afterVendor =
    filters.vendor === 'all'
      ? afterProject
      : afterProject.filter((p) => p.vendor === filters.vendor);
  const categories = sortedUnique(afterVendor.map((p) => p.category));

  const afterCategory =
    filters.category === 'all'
      ? afterVendor
      : afterVendor.filter((p) => p.category === filters.category);
  const materials = sortedUnique(afterCategory.map((p) => p.material));

  return { projects, vendors, categories, materials };
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function spendOf(
  part: MaterialPartRow,
  kind: 'bg' | 'sop' | 'fc',
): number {
  if (kind === 'bg') return Number(part.bgSpend ?? part.bgPrice) || 0;
  if (kind === 'sop') return Number(part.sopSpend ?? part.sopPrice) || 0;
  return Number(part.fcSpend ?? part.fcPrice) || 0;
}

function sumSpend(parts: MaterialPartRow[], kind: 'bg' | 'sop' | 'fc'): number {
  return parts.reduce((s, p) => s + spendOf(p, kind), 0);
}

function bridgePoolSum(
  parts: MaterialPartRow[],
  pool: 'bridges' | 'bridgesNomToSop' | 'bridgesSopToFc',
  id: MaterialBridgeId,
): number {
  return parts.reduce((s, p) => s + (Number(p[pool]?.[id]) || 0), 0);
}

function bridgeSum(parts: MaterialPartRow[], id: MaterialBridgeId): number {
  return bridgePoolSum(parts, 'bridges', id);
}

function mean(parts: MaterialPartRow[], key: 'bgPrice' | 'sopPrice' | 'fcPrice'): number {
  if (parts.length === 0) return 0;
  return parts.reduce((s, p) => s + (Number(p[key]) || 0), 0) / parts.length;
}

function sameSignOverlap(residual: number, candidate: number): number {
  if (residual === 0 || candidate === 0) return 0;
  if (residual * candidate <= 0) return 0;
  const mag = Math.min(Math.abs(residual), Math.abs(candidate));
  return residual > 0 ? mag : -mag;
}

/**
 * Ensure residual bridges exist. Legacy payloads only have ``other`` —
 * split it client-side so the waterfall stays finance-readable.
 */
export function normalizePartBridges(part: MaterialPartRow): MaterialPartRow {
  const volume = Number(part.volume) > 0 ? Number(part.volume) : 1;
  const withSpend: MaterialPartRow = {
    ...part,
    volume,
    bgSpend: part.bgSpend ?? round((Number(part.bgPrice) || 0) * volume),
    sopSpend: part.sopSpend ?? round((Number(part.sopPrice) || 0) * volume),
    fcSpend: part.fcSpend ?? round((Number(part.fcPrice) || 0) * volume),
  };

  const b = { ...(withSpend.bridges ?? {}) };
  const hasSplit = RESIDUAL_BRIDGES.some((id) => Number(b[id]) !== 0 || id in b);

  if (!hasSplit) {
    const fx = Number(b.fx) || 0;
    const commodity = Number(b.commodity) || 0;
    const freight = Number(b.freight) || 0;
    const bg = spendOf(withSpend, 'bg');
    const sop = spendOf(withSpend, 'sop');
    const fc = spendOf(withSpend, 'fc');
    const residual =
      Number(b.other) || fc - bg - fx - commodity - freight;

    const histUnexplained = sop - bg - fx - commodity - freight;
    const vendorReprice = sameSignOverlap(residual, histUnexplained);
    const rem = residual - vendorReprice;
    const mix = rem * 0.3;
    const seasonality = rem * 0.2;
    const unexplained = rem - mix - seasonality;

    b.vendorReprice = round(vendorReprice);
    b.mix = round(mix);
    b.seasonality = round(seasonality);
    b.unexplained = round(unexplained);
    b.other = round(residual);
  } else if (b.other == null) {
    b.other = round(
      RESIDUAL_BRIDGES.reduce((s, id) => s + (Number(b[id]) || 0), 0),
    );
  }

  return { ...withSpend, bridges: b };
}

function buildWaterfall(
  parts: MaterialPartRow[],
  template: MaterialWaterfallStep[] | undefined,
  horizon: number,
  walk: MaterialWalkId = 'bg_to_fc',
): MaterialWaterfallStep[] {
  const bg = sumSpend(parts, 'bg');
  const sop = sumSpend(parts, 'sop');
  const fc = sumSpend(parts, 'fc');

  const pool =
    walk === 'nom_to_sop'
      ? 'bridgesNomToSop'
      : walk === 'sop_to_fc'
        ? 'bridgesSopToFc'
        : 'bridges';

  const start = walk === 'sop_to_fc' ? sop : bg;
  const end = walk === 'nom_to_sop' ? sop : fc;
  const startId = walk === 'sop_to_fc' ? 'sop' : 'budget';
  const endId = walk === 'nom_to_sop' ? 'sop' : 'forecast';

  const hasDual = parts.some((p) => p.bridgesNomToSop || p.bridgesSopToFc);
  const pick = (id: MaterialBridgeId) =>
    hasDual && pool !== 'bridges'
      ? bridgePoolSum(parts, pool, id)
      : bridgeSum(parts, id);

  const fx = pick('fx');
  const commodity = pick('commodity');
  const freight = pick('freight');
  const vendorReprice = pick('vendorReprice');
  const mix = pick('mix');
  const seasonality = pick('seasonality');
  const unexplained =
    end - start - fx - commodity - freight - vendorReprice - mix - seasonality;

  const note = (id: string, fallback: string) =>
    template?.find((s) => s.id === id)?.note ?? fallback;

  const labels: Record<string, string> = {
    budget: 'Budget (BG)',
    sop: 'SOP / current',
    fx: 'Currency',
    commodity: 'Materials',
    freight: 'Shipping',
    vendorReprice: 'Vendor reprice',
    mix: 'Mix',
    seasonality: 'Seasonality',
    unexplained: 'Unexplained',
    forecast: 'Forecast (FC)',
  };

  const values: Record<string, number> = {
    [startId]: start,
    fx,
    commodity,
    freight,
    vendorReprice,
    mix,
    seasonality,
    unexplained,
    [endId]: end,
  };

  return [startId, ...MATERIAL_WALK_BRIDGES, endId].map((id) => ({
    id,
    label: labels[id] ?? id,
    kind: id === startId || id === endId ? 'total' : 'bridge',
    value: round(values[id] ?? 0),
    note:
      id === endId
        ? note(id, `Endpoint for filtered slice (h=${horizon})`)
        : note(id, BRIDGE_NOTES[id] ?? labels[id] ?? id),
  }));
}

/**
 * Rebuild a filtered price tracker that still looks like the portfolio chart.
 *
 * We do not store monthly history per hierarchy slice, so we keep the portfolio
 * monthly *shape* and rescale levels to this slice's mean BG (Nomination),
 * SOP, and FC. That preserves Actual + Forecast continuity (unlike a 3-point
 * stub that left Forecast with a single point and nothing to draw).
 */
function buildScopedPriceSeries(
  parts: MaterialPartRow[],
  milestones: MaterialCost['milestones'],
  portfolioSeries: MaterialPricePoint[],
): MaterialPricePoint[] {
  if (!portfolioSeries.length) return [];

  const nomMonth = milestones?.nomination.month;
  const sopMonth = milestones?.sop.month;
  const fcMonth = milestones?.forecast.month;

  const targetNom = mean(parts, 'bgPrice');
  const targetSop = mean(parts, 'sopPrice');
  const targetFc = mean(parts, 'fcPrice');

  const nomPoint = portfolioSeries.find((p) => p.month === nomMonth && p.actual != null);
  const sopPoint = portfolioSeries.find((p) => p.month === sopMonth && p.actual != null);
  const fcPoint =
    portfolioSeries.find((p) => p.month === fcMonth && p.forecast != null) ??
    [...portfolioSeries].reverse().find((p) => p.forecast != null);

  const baseNom = nomPoint?.actual ?? targetNom;
  const baseSop = sopPoint?.actual ?? targetSop;
  const baseFc = fcPoint?.forecast ?? targetFc;

  const scaleNom = baseNom ? targetNom / baseNom : 1;
  const scaleSop = baseSop ? targetSop / baseSop : 1;
  const scaleFc = baseFc ? targetFc / baseFc : 1;

  const nomTs = nomMonth ? Date.parse(`${nomMonth}-01`) : NaN;
  const sopTs = sopMonth ? Date.parse(`${sopMonth}-01`) : NaN;
  const span =
    Number.isFinite(nomTs) && Number.isFinite(sopTs) && sopTs !== nomTs
      ? sopTs - nomTs
      : 0;

  return portfolioSeries.map((p) => {
    let actual = p.actual;
    let forecast = p.forecast;

    if (actual != null) {
      let t = 0.5;
      if (span) {
        const ts = Date.parse(`${p.month}-01`);
        t = Math.min(1, Math.max(0, (ts - nomTs) / span));
      } else if (p.isSop) {
        t = 1;
      } else if (p.isNomination) {
        t = 0;
      }
      const scale = scaleNom * (1 - t) + scaleSop * t;
      actual = round(actual * scale, 3);
    }

    if (forecast != null) {
      forecast = round(forecast * scaleFc, 3);
    }

    return {
      ...p,
      actual,
      forecast,
    };
  });
}

/**
 * Derive live Material Cost figures for the current hierarchy filter slice.
 * Unscoped (all dimensions = all, empty search) keeps the exported portfolio series.
 */
export function deriveMaterialCostView(
  materialCost: MaterialCost,
  filters: HierarchyFilterState,
  walk: MaterialWalkId = 'bg_to_fc',
): MaterialCostView {
  const allParts = (materialCost.parts ?? []).map(normalizePartBridges);
  const filtered = filterMaterialParts(allParts, filters);
  const scoped = isHierarchyScoped(filters);
  const hasPartQuery = filters.partQuery.trim().length > 0;
  const needsRecompute = scoped || hasPartQuery;

  const bg = sumSpend(filtered, 'bg');
  const sop = sumSpend(filtered, 'sop');
  const fc = sumSpend(filtered, 'fc');
  const baseSummary = materialCost.summary;

  const summary = needsRecompute
    ? {
        budgetSpend: round(bg),
        sopSpend: round(sop),
        forecastSpend: round(fc),
        varianceAbs: round(fc - bg),
        variancePct: round(bg ? ((fc - bg) / bg) * 100 : 0, 3),
        varianceNomToSopAbs: round(sop - bg),
        varianceSopToFcAbs: round(fc - sop),
        nParts: filtered.length,
        horizon: baseSummary?.horizon ?? 0,
        totalVolume: round(
          filtered.reduce((s, p) => s + (Number(p.volume) || 0), 0),
          3,
        ),
      }
    : {
        budgetSpend: baseSummary?.budgetSpend ?? round(bg),
        sopSpend: baseSummary?.sopSpend ?? round(sop),
        forecastSpend: baseSummary?.forecastSpend ?? round(fc),
        varianceAbs: baseSummary?.varianceAbs ?? round(fc - bg),
        variancePct:
          baseSummary?.variancePct ?? round(bg ? ((fc - bg) / bg) * 100 : 0, 3),
        varianceNomToSopAbs: baseSummary?.varianceNomToSopAbs ?? round(sop - bg),
        varianceSopToFcAbs: baseSummary?.varianceSopToFcAbs ?? round(fc - sop),
        nParts: baseSummary?.nParts ?? filtered.length,
        horizon: baseSummary?.horizon ?? 0,
        totalVolume: baseSummary?.totalVolume,
      };

  const template =
    walk === 'nom_to_sop'
      ? materialCost.waterfallNomToSop
      : walk === 'sop_to_fc'
        ? materialCost.waterfallSopToFc
        : materialCost.waterfall;

  const waterfall = buildWaterfall(filtered, template, summary.horizon, walk);

  const priceSeries =
    scoped || hasPartQuery
      ? buildScopedPriceSeries(
          filtered,
          materialCost.milestones,
          materialCost.priceSeries ?? [],
        )
      : (materialCost.priceSeries ?? []);

  return {
    parts: [...filtered].sort(
      (a, b) => Math.abs(b.changeAbs) - Math.abs(a.changeAbs),
    ),
    summary,
    waterfall,
    priceSeries,
    isScoped: scoped || hasPartQuery,
    nPartsTotal: allParts.length,
  };
}
