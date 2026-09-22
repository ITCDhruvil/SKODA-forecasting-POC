// dashboard/api/_lib/exposure.ts
//
// getExposure links a commodity or scenario "driver" (as mentioned in the news) to the
// dashboard's own data: for a commodity, an editable assumed category mapping; for a
// scenario family (freight/duty/geopolitics/fx), the already-modeled shock scenarios.
import fs from 'node:fs';
import path from 'node:path';
import { changePct, getDashboardJson, getPartsIndex, type PartRecord } from './data';

const EXPOSURE_MAP_PATH = path.join(process.cwd(), 'api', '_data', 'exposure.json');

export interface ExposureMapEntry {
  categories: string[];
  note: string;
}

export type ExposureMap = Record<string, ExposureMapEntry>;

const COMMODITY_DRIVERS = ['steel', 'aluminium', 'copper', 'plastics', 'electronics'] as const;
type CommodityDriver = (typeof COMMODITY_DRIVERS)[number];

const SCENARIO_DRIVER_FAMILY: Record<string, 'freight' | 'duty' | 'gpr' | 'fx'> = {
  freight: 'freight',
  duty: 'duty',
  geopolitics: 'gpr',
  fx: 'fx',
};

const ALL_DRIVERS: readonly string[] = [...COMMODITY_DRIVERS, ...Object.keys(SCENARIO_DRIVER_FAMILY)];

function roundCurrency(n: number): number {
  return Math.round(n);
}

function roundPct(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Reads and validates the exposure mapping file: unknown categories (ones that don't
 * exist in the current dashboard data) are dropped. Returns null if the file is missing
 * or unreadable. `filePath` is a seam for tests; production code always uses the default.
 */
export function loadExposureMap(filePath: string = EXPOSURE_MAP_PATH): ExposureMap | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const validCategories = new Set(getDashboardJson().categories.map((c) => c.category));
  const map: ExposureMap = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === '_comment' || !value || typeof value !== 'object') continue;
    const entry = value as { categories?: unknown; note?: unknown };
    const categories = Array.isArray(entry.categories)
      ? entry.categories.filter((c): c is string => typeof c === 'string' && validCategories.has(c))
      : [];
    map[key] = { categories, note: typeof entry.note === 'string' ? entry.note : '' };
  }
  return map;
}

interface TopPart {
  partId: string;
  partName: string;
  vendor: string;
  changePct: number;
}

function topPartsInCategory(category: string, parts: PartRecord[]): TopPart[] {
  return parts
    .filter((p) => p.category === category)
    .map((p) => ({ rec: p, change: changePct(p.currentPrice, p.forecast.find((f) => f.horizon === 1)?.prediction ?? null) }))
    .filter((x): x is { rec: PartRecord; change: number } => x.change !== null)
    .sort((a, b) => b.change - a.change)
    .slice(0, 3)
    .map((x) => ({ partId: x.rec.partId, partName: x.rec.partName, vendor: x.rec.vendor, changePct: roundPct(x.change) }));
}

function getCommodityExposure(driver: CommodityDriver) {
  const map = loadExposureMap();
  if (!map) return { error: 'exposure mapping unavailable' };

  const dashCategories = getDashboardJson().categories;
  const parts = getPartsIndex();
  const categoryNames = map[driver]?.categories ?? [];

  const categories = categoryNames
    .map((name) => dashCategories.find((c) => c.category === name))
    .filter((c): c is (typeof dashCategories)[number] => !!c)
    .map((c) => ({
      category: c.category,
      spend: roundCurrency(c.value),
      sharePct: roundPct(c.share),
      forecastChangePct: roundPct(c.forecastChange),
      topParts: topPartsInCategory(c.category, parts),
    }));

  const totalSpend = categories.reduce((sum, c) => sum + c.spend, 0);
  const weightedSum = categories.reduce((sum, c) => sum + c.spend * c.forecastChangePct, 0);
  const spendWeightedForecastChangePct = totalSpend > 0 ? roundPct(weightedSum / totalSpend) : 0;

  return {
    driver,
    basis: 'assumed category mapping, not from a bill of materials (edit api/_data/exposure.json)',
    categories,
    totalSpend,
    spendWeightedForecastChangePct,
  };
}

interface ScenarioLevelEntry {
  name: string;
  priceChangePct: number;
}

function normalizeFxLevel(rows: { name: string; changePct: number }[] | undefined): ScenarioLevelEntry[] {
  return (rows ?? []).map((r) => ({ name: r.name, priceChangePct: r.changePct }));
}

function normalizeGeoLevel(rows: { name: string; priceChangePct: number }[] | undefined): ScenarioLevelEntry[] {
  return (rows ?? []).map((r) => ({ name: r.name, priceChangePct: r.priceChangePct }));
}

function topAbs(rows: ScenarioLevelEntry[], n: number): { name: string; priceChangePct: number }[] {
  return [...rows]
    .sort((a, b) => Math.abs(b.priceChangePct) - Math.abs(a.priceChangePct))
    .slice(0, n)
    .map((r) => ({ name: r.name, priceChangePct: roundPct(r.priceChangePct) }));
}

function getScenarioExposure(driver: string) {
  const family = SCENARIO_DRIVER_FAMILY[driver];
  const basis = 'modeled scenarios (elasticity model on your data), not a forecast of the news itself';
  const d = getDashboardJson();

  interface Normalized {
    name: string;
    shockPct: number;
    overallPriceChangePct: number;
    byLevel: { category: ScenarioLevelEntry[]; vendor: ScenarioLevelEntry[]; project: ScenarioLevelEntry[] };
  }

  let scenarios: Normalized[];
  if (family === 'fx') {
    scenarios = (d.fxAnalysis?.scenarios ?? []).map((s) => ({
      name: s.name,
      shockPct: s.shockPct,
      overallPriceChangePct: s.overallPriceChangePct,
      byLevel: {
        category: normalizeFxLevel(s.byLevel.category),
        vendor: normalizeFxLevel(s.byLevel.vendor),
        project: normalizeFxLevel(s.byLevel.project),
      },
    }));
  } else {
    scenarios = (d.geoAnalysis?.scenarios ?? [])
      .filter((s) => s.family === family)
      .map((s) => ({
        name: s.name,
        shockPct: s.shockPct,
        overallPriceChangePct: s.overallPriceChangePct,
        byLevel: {
          category: normalizeGeoLevel(s.byLevel.category),
          vendor: normalizeGeoLevel(s.byLevel.vendor),
          project: normalizeGeoLevel(s.byLevel.project),
        },
      }));
  }

  const top = [...scenarios].sort((a, b) => Math.abs(b.overallPriceChangePct) - Math.abs(a.overallPriceChangePct)).slice(0, 4);

  return {
    driver,
    basis,
    scenarios: top.map((s) => ({
      name: s.name,
      shockPct: roundPct(s.shockPct),
      overallPriceChangePct: roundPct(s.overallPriceChangePct),
      topCategories: topAbs(s.byLevel.category, 3),
      topVendors: topAbs(s.byLevel.vendor, 3),
      topProjects: topAbs(s.byLevel.project, 3),
    })),
  };
}

/** Links a commodity or scenario driver mentioned in news to dashboard data: spend/forecast exposure for a
 * commodity (an editable assumption, not a bill of materials), or the modeled scenario impact for
 * freight/duty/geopolitics/fx. */
export function getExposure(args: { driver: string }) {
  const driver = args.driver;
  if (!ALL_DRIVERS.includes(driver)) {
    return { error: `unknown driver ${driver}; valid: ${ALL_DRIVERS.join(', ')}` };
  }
  if ((COMMODITY_DRIVERS as readonly string[]).includes(driver)) {
    return getCommodityExposure(driver as CommodityDriver);
  }
  return getScenarioExposure(driver);
}
