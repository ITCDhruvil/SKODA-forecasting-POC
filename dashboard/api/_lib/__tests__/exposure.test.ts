import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getExposure, loadExposureMap } from '../exposure';
import { changePct, getDashboardJson, getPartsIndex } from '../data';

const COMMODITY_DRIVERS = ['steel', 'aluminium', 'copper', 'plastics', 'electronics'] as const;
const SCENARIO_DRIVERS = ['freight', 'duty', 'geopolitics', 'fx'] as const;

function writeFixture(obj: unknown): string {
  const file = path.join(os.tmpdir(), `exposure-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

describe('loadExposureMap', () => {
  it('loads the real mapping and keeps only categories that exist in the dashboard data', () => {
    const map = loadExposureMap();
    expect(map).not.toBeNull();
    const validCategories = new Set(getDashboardJson().categories.map((c) => c.category));
    for (const entry of Object.values(map!)) {
      for (const category of entry.categories) {
        expect(validCategories.has(category)).toBe(true);
      }
    }
    expect(map!.steel.categories.length).toBeGreaterThan(0);
  });

  it('drops an unknown category from a mapping file', () => {
    const realCategory = getDashboardJson().categories[0].category;
    const file = writeFixture({
      steel: { categories: [realCategory, 'Not A Real Category'], note: 'x' },
    });
    const map = loadExposureMap(file);
    expect(map!.steel.categories).toEqual([realCategory]);
  });

  it('returns null for a missing file', () => {
    expect(loadExposureMap(path.join(os.tmpdir(), 'does-not-exist-exposure.json'))).toBeNull();
  });
});

describe('getExposure: commodity drivers', () => {
  it('returns only categories that exist, with spend/share/forecastChange from dashboard data', () => {
    for (const driver of COMMODITY_DRIVERS) {
      const result = getExposure({ driver });
      if ('error' in result) throw new Error(`expected success for ${driver}, got ${result.error}`);
      if (!('categories' in result)) throw new Error('expected a commodity result');
      expect(result.driver).toBe(driver);
      expect(result.basis).toContain('assumed category mapping');
      expect(Array.isArray(result.categories)).toBe(true);
      const validCategories = new Set(getDashboardJson().categories.map((c) => c.category));
      for (const c of result.categories) {
        expect(validCategories.has(c.category)).toBe(true);
        expect(c.topParts.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it('spend-weighted forecast change equals a hand-computed value for steel', () => {
    const result = getExposure({ driver: 'steel' });
    if ('error' in result) throw new Error('expected success');
    if (!('categories' in result)) throw new Error('expected a commodity result');
    const expectedTotal = result.categories.reduce((sum, c) => sum + c.spend, 0);
    const expectedWeighted =
      expectedTotal > 0
        ? Math.round((result.categories.reduce((sum, c) => sum + c.spend * c.forecastChangePct, 0) / expectedTotal) * 100) / 100
        : 0;
    expect(result.totalSpend).toBe(Math.round(expectedTotal));
    expect(result.spendWeightedForecastChangePct).toBeCloseTo(expectedWeighted, 2);
  });

  it('topParts are the highest forecast changes within that category', () => {
    const result = getExposure({ driver: 'copper' });
    if ('error' in result) throw new Error('expected success');
    if (!('categories' in result)) throw new Error('expected a commodity result');
    const parts = getPartsIndex();
    for (const c of result.categories) {
      const inCategory = parts
        .filter((p) => p.category === c.category)
        .map((p) => ({ p, change: changePct(p.currentPrice, p.forecast.find((f) => f.horizon === 1)?.prediction ?? null) }))
        .filter((x): x is { p: (typeof parts)[number]; change: number } => x.change !== null)
        .sort((a, b) => b.change - a.change)
        .slice(0, 3);
      expect(c.topParts.map((tp) => tp.partId)).toEqual(inCategory.map((x) => x.p.partId));
    }
  });
});

describe('getExposure: scenario drivers', () => {
  it('maps freight/duty/geopolitics/fx to the right scenario family, with a modeled-scenario basis', () => {
    for (const driver of SCENARIO_DRIVERS) {
      const result = getExposure({ driver });
      if ('error' in result) throw new Error(`expected success for ${driver}, got ${result.error}`);
      if (!('scenarios' in result)) throw new Error('expected a scenario result');
      expect(result.driver).toBe(driver);
      expect(result.basis).toContain('modeled scenarios');
      expect(Array.isArray(result.scenarios)).toBe(true);
      expect(result.scenarios.length).toBeLessThanOrEqual(4);
      for (const s of result.scenarios) {
        expect(typeof s.name).toBe('string');
        expect(s.topCategories.length).toBeLessThanOrEqual(3);
        expect(s.topVendors.length).toBeLessThanOrEqual(3);
        expect(s.topProjects.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it('picks the top 4 scenarios by largest absolute overall price change, descending', () => {
    // fx has 6 scenarios in the bundled data, so this exercises real truncation, not just sorting.
    const raw = getDashboardJson().fxAnalysis!.scenarios!;
    expect(raw.length).toBeGreaterThan(4);
    const expectedOrder = [...raw]
      .sort((a, b) => Math.abs(b.overallPriceChangePct) - Math.abs(a.overallPriceChangePct))
      .slice(0, 4)
      .map((s) => s.name);

    const result = getExposure({ driver: 'fx' });
    if ('error' in result) throw new Error('expected success');
    if (!('scenarios' in result)) throw new Error('expected a scenario result');
    expect(result.scenarios.map((s) => s.name)).toEqual(expectedOrder);
    for (let i = 1; i < result.scenarios.length; i++) {
      expect(Math.abs(result.scenarios[i - 1].overallPriceChangePct)).toBeGreaterThanOrEqual(
        Math.abs(result.scenarios[i].overallPriceChangePct),
      );
    }
  });

  it('sorts topCategories/topVendors/topProjects by largest absolute change, descending (fx)', () => {
    const raw = getDashboardJson().fxAnalysis!.scenarios!;
    const result = getExposure({ driver: 'fx' });
    if ('error' in result) throw new Error('expected success');
    if (!('scenarios' in result)) throw new Error('expected a scenario result');

    for (const s of result.scenarios) {
      const rawScenario = raw.find((r) => r.name === s.name)!;
      for (const level of ['category', 'vendor', 'project'] as const) {
        const key = level === 'category' ? 'topCategories' : level === 'vendor' ? 'topVendors' : 'topProjects';
        const expectedNames = [...(rawScenario.byLevel[level] ?? [])]
          .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
          .slice(0, 3)
          .map((r) => r.name);
        expect((s as any)[key].map((r: { name: string }) => r.name)).toEqual(expectedNames);
        const values = (s as any)[key] as { priceChangePct: number }[];
        for (let i = 1; i < values.length; i++) {
          expect(Math.abs(values[i - 1].priceChangePct)).toBeGreaterThanOrEqual(Math.abs(values[i].priceChangePct));
        }
      }
    }
  });

  it('sorts topCategories/topVendors/topProjects by largest absolute change, descending (geo: freight)', () => {
    const raw = (getDashboardJson().geoAnalysis!.scenarios ?? []).filter((s) => s.family === 'freight');
    const result = getExposure({ driver: 'freight' });
    if ('error' in result) throw new Error('expected success');
    if (!('scenarios' in result)) throw new Error('expected a scenario result');
    expect(result.scenarios.length).toBeGreaterThan(0);

    for (const s of result.scenarios) {
      const rawScenario = raw.find((r) => r.name === s.name)!;
      for (const level of ['category', 'vendor', 'project'] as const) {
        const key = level === 'category' ? 'topCategories' : level === 'vendor' ? 'topVendors' : 'topProjects';
        const expectedNames = [...(rawScenario.byLevel[level] ?? [])]
          .sort((a, b) => Math.abs(b.priceChangePct) - Math.abs(a.priceChangePct))
          .slice(0, 3)
          .map((r) => r.name);
        expect((s as any)[key].map((r: { name: string }) => r.name)).toEqual(expectedNames);
      }
    }
  });
});

describe('getExposure: errors', () => {
  it('returns a structured error for an unknown driver, listing valid ones', () => {
    const result = getExposure({ driver: 'bogus' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      for (const d of [...COMMODITY_DRIVERS, ...SCENARIO_DRIVERS]) expect(result.error).toContain(d);
    }
  });
});
