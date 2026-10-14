import { describe, expect, it } from 'vitest';
import type { FxScenario, MaterialPartRow } from '../../types';
import {
  ALL,
  buildTrend,
  commodityPassPct,
  computeImpact,
  interpolate,
  vehicleImpactPct,
} from '../costImpact';

const scenario = (shockPct: number, changePct: number): FxScenario => ({
  name: `${shockPct}`,
  shockPct,
  pairs: ['USDINR'],
  overallPriceChangePct: changePct,
  impliedElasticity: 0,
  byLevel: { category: [{ name: 'Electrical', parts: 1, baselineValue: 0, shockedValue: 0, changePct, changeAbs: 0 }] },
});

const part = (over: Partial<MaterialPartRow>): MaterialPartRow =>
  ({
    partId: 'p1',
    partName: 'Part 1',
    project: 'VW Virtus',
    vendor: 'V',
    category: 'Electrical',
    material: 'Copper',
    bgPrice: 100,
    sopPrice: 100,
    fcPrice: 100,
    fcSpend: 100,
    changeAbs: 0,
    changePct: 0,
    bridges: {},
    ...over,
  }) as MaterialPartRow;

const scenarios = [scenario(-10, -2), scenario(10, 4)];

describe('interpolate', () => {
  it('is linear between points and clamped outside them', () => {
    const pts: Array<[number, number]> = [[0, 0], [10, 4]];
    expect(interpolate(pts, 5)).toBe(2);
    expect(interpolate(pts, 50)).toBe(4);
    expect(interpolate(pts, -5)).toBe(0);
  });
});

describe('commodityPassPct', () => {
  it('scales the shock by share x pass-through', () => {
    expect(commodityPassPct('Copper', 10)).toBeCloseTo(10 * 0.55 * 0.75);
  });
  it('falls back to a default for unknown materials', () => {
    expect(commodityPassPct('Unobtainium', 10)).toBeGreaterThan(0);
  });
});

describe('computeImpact', () => {
  const base = { scenarios, car: ALL, material: ALL, currency: 'both' as const };

  it('is zero with no shock', () => {
    const r = computeImpact({ ...base, parts: [part({})], commodityPct: 0, fxPct: 0 });
    expect(r.delta).toBe(0);
    expect(r.scenario).toBe(100);
  });

  it('applies the FX scenario response to category spend', () => {
    const r = computeImpact({ ...base, parts: [part({})], commodityPct: 0, fxPct: 10 });
    expect(r.fx).toBeCloseTo(4);
    expect(r.commodity).toBe(0);
  });

  it('halves the FX effect for a single currency pair', () => {
    const r = computeImpact({ ...base, currency: 'USDINR', parts: [part({})], commodityPct: 0, fxPct: 10 });
    expect(r.fx).toBeCloseTo(2);
  });

  it('applies the commodity shock only to the selected material', () => {
    const parts = [part({ partId: 'a', material: 'Copper' }), part({ partId: 'b', material: 'Steel' })];
    const r = computeImpact({ ...base, material: 'Copper', parts, commodityPct: 10, fxPct: 0 });
    expect(r.commodity).toBeCloseTo(100 * 0.1 * 0.55 * 0.75);
    expect(r.categories[0].parts.find((p) => p.partId === 'b')?.commodity).toBe(0);
  });

  it('filters by car', () => {
    const parts = [part({ partId: 'a' }), part({ partId: 'b', project: 'VW Taigun' })];
    const r = computeImpact({ ...base, car: 'VW Taigun', parts, commodityPct: 0, fxPct: 0 });
    expect(r.base).toBe(100);
  });

  it('ranks categories by absolute exposure', () => {
    const parts = [
      part({ partId: 'a', category: 'Electrical', fcSpend: 100 }),
      part({ partId: 'b', category: 'Other', fcSpend: 500 }),
    ];
    const r = computeImpact({ ...base, parts, commodityPct: 10, fxPct: 0 });
    expect(r.categories[0].name).toBe('Other');
  });
});

describe('buildTrend', () => {
  it('ends at base plus the full delta and phases it in', () => {
    const h = [
      { label: 'a', value: 90 },
      { label: 'b', value: 100 },
    ];
    const t = buildTrend(h, 200, 20);
    expect(t[1].base).toBe(200);
    expect(t[1].scenario).toBe(220);
    expect(t[0].scenario - t[0].base).toBe(10);
  });
  it('returns nothing without a horizon', () => {
    expect(buildTrend([], 1, 1)).toEqual([]);
  });
});

describe('vehicleImpactPct', () => {
  it('shrinks the material effect by the material share of vehicle cost', () => {
    expect(vehicleImpactPct(100, 10, 0.5)).toBeCloseTo(5);
  });
});
