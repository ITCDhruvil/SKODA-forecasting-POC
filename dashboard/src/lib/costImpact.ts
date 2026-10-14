import type { FxScenario, MaterialPartRow } from '../types';

/**
 * Forward-looking cost impact: what happens to forecast material cost if a
 * commodity price or the rupee moves.
 *
 * FX effect comes from the pipeline's own FX scenarios (per-category response).
 * Commodity effect is ILLUSTRATIVE: no commodity sensitivity exists in the data, so
 * each material carries an assumed share of part cost and pass-through. The UI labels it.
 */

export interface MaterialAssumption {
  /** Share of a part's price driven by the raw commodity. */
  share: number;
  /** Share of a commodity move the supplier passes on. */
  passThrough: number;
}

export const MATERIAL_ASSUMPTIONS: Record<string, MaterialAssumption> = {
  Aluminium: { share: 0.5, passThrough: 0.7 },
  Copper: { share: 0.55, passThrough: 0.75 },
  Steel: { share: 0.45, passThrough: 0.65 },
  'Cast iron': { share: 0.4, passThrough: 0.7 },
  Polymer: { share: 0.35, passThrough: 0.7 },
  Polycarbonate: { share: 0.35, passThrough: 0.7 },
  Silicon: { share: 0.3, passThrough: 0.65 },
};

const DEFAULT_ASSUMPTION: MaterialAssumption = { share: 0.35, passThrough: 0.7 };

export type CurrencyChoice = 'both' | 'USDINR' | 'EURINR';

/** The pipeline models both pairs together; a single pair is assumed to carry half the effect. */
export const CURRENCY_WEIGHT: Record<CurrencyChoice, number> = { both: 1, USDINR: 0.5, EURINR: 0.5 };

export const ALL = 'all';

export interface ImpactInput {
  parts: MaterialPartRow[];
  scenarios: FxScenario[];
  /** Car/project name, or ALL. */
  car: string;
  /** Material name, or ALL. The commodity shock applies to this material only. */
  material: string;
  currency: CurrencyChoice;
  /** Commodity price move, in percent. */
  commodityPct: number;
  /** FX move in percent; positive = rupee weaker. */
  fxPct: number;
}

export interface PartImpact {
  partId: string;
  partName: string;
  category: string;
  material: string;
  base: number;
  fx: number;
  commodity: number;
  delta: number;
}

export interface CategoryImpact {
  name: string;
  base: number;
  fx: number;
  commodity: number;
  delta: number;
  deltaPct: number;
  parts: PartImpact[];
}

export interface ImpactResult {
  base: number;
  fx: number;
  commodity: number;
  scenario: number;
  delta: number;
  deltaPct: number;
  categories: CategoryImpact[];
}

/** Piecewise-linear lookup, clamped at the ends. Points need not be sorted. */
export function interpolate(points: Array<[number, number]>, x: number): number {
  if (points.length === 0) return 0;
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  if (x <= sorted[0][0]) return sorted[0][1];
  const last = sorted[sorted.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < sorted.length; i++) {
    const [x1, y1] = sorted[i];
    if (x <= x1) {
      const [x0, y0] = sorted[i - 1];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return last[1];
}

/** Price response (%) of one category to an FX shock; 0 shock is 0 by definition. */
export function categoryFxPct(scenarios: FxScenario[], category: string, shockPct: number): number {
  const points: Array<[number, number]> = [[0, 0]];
  for (const s of scenarios) {
    const row = s.byLevel?.category?.find((r) => r.name === category);
    if (row) points.push([s.shockPct, row.changePct]);
  }
  return interpolate(points, shockPct);
}

export function commodityPassPct(material: string, shockPct: number): number {
  const a = MATERIAL_ASSUMPTIONS[material] ?? DEFAULT_ASSUMPTION;
  return shockPct * a.share * a.passThrough;
}

const spendOf = (p: MaterialPartRow) => Number(p.fcSpend ?? p.fcPrice) || 0;

export function computeImpact(input: ImpactInput): ImpactResult {
  const { parts, scenarios, car, material, currency, commodityPct, fxPct } = input;
  const weight = CURRENCY_WEIGHT[currency];
  const byCategory = new Map<string, CategoryImpact>();

  for (const part of parts) {
    if (car !== ALL && part.project !== car) continue;
    const base = spendOf(part);
    const fx = (base * categoryFxPct(scenarios, part.category, fxPct) * weight) / 100;
    const commodity =
      material === ALL || part.material === material
        ? (base * commodityPassPct(part.material, commodityPct)) / 100
        : 0;

    let cat = byCategory.get(part.category);
    if (!cat) {
      cat = { name: part.category, base: 0, fx: 0, commodity: 0, delta: 0, deltaPct: 0, parts: [] };
      byCategory.set(part.category, cat);
    }
    cat.base += base;
    cat.fx += fx;
    cat.commodity += commodity;
    cat.parts.push({
      partId: part.partId,
      partName: part.partName,
      category: part.category,
      material: part.material,
      base,
      fx,
      commodity,
      delta: fx + commodity,
    });
  }

  const categories = [...byCategory.values()].map((c) => ({
    ...c,
    delta: c.fx + c.commodity,
    deltaPct: c.base ? ((c.fx + c.commodity) / c.base) * 100 : 0,
    parts: c.parts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
  }));
  categories.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const base = categories.reduce((n, c) => n + c.base, 0);
  const fx = categories.reduce((n, c) => n + c.fx, 0);
  const commodity = categories.reduce((n, c) => n + c.commodity, 0);
  const delta = fx + commodity;
  return { base, fx, commodity, scenario: base + delta, delta, deltaPct: base ? (delta / base) * 100 : 0, categories };
}

/**
 * Month-by-month base and scenario series. Base follows the basket's forecast shape;
 * the scenario impact is assumed to phase in linearly across the horizon.
 */
export function buildTrend(
  horizon: Array<{ label: string; value: number }>,
  base: number,
  delta: number,
): Array<{ label: string; base: number; scenario: number }> {
  const last = horizon[horizon.length - 1]?.value;
  if (!last) return [];
  return horizon.map((h, i) => {
    const b = base * (h.value / last);
    return { label: h.label, base: b, scenario: b + (delta * (i + 1)) / horizon.length };
  });
}

/** Vehicle-level effect: selected material spend is assumed to be `materialShare` of vehicle cost. */
export function vehicleImpactPct(base: number, delta: number, materialShare: number): number {
  if (!base || !materialShare) return 0;
  return (delta / (base / materialShare)) * 100;
}
