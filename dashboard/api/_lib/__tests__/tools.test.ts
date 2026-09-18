// dashboard/api/lib/__tests__/tools.test.ts
import { describe, it, expect } from 'vitest';
import { getPartsIndex } from '../data';
import {
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
} from '../tools';

describe('searchParts', () => {
  it('finds parts by partId substring, case-insensitively', () => {
    const target = getPartsIndex()[0];
    const result = searchParts({ query: target.partId.slice(0, 6).toLowerCase() });
    expect(result.results.some((r) => r.partId === target.partId)).toBe(true);
  });

  it('filters by category', () => {
    const category = getPartsIndex()[0].category;
    const result = searchParts({ category });
    expect(result.results.length).toBeGreaterThan(0);
    for (const r of result.results) expect(r.category).toBe(category);
  });

  it('caps results at 25', () => {
    const result = searchParts({});
    expect(result.results.length).toBeLessThanOrEqual(25);
  });
});

describe('getPartForecast', () => {
  it('returns full detail for a known part', () => {
    const known = getPartsIndex()[0];
    const result = getPartForecast({ partId: known.partId });
    if ('error' in result) {
      throw new Error(`expected a PartRecord, got error: ${result.error}`);
    }
    expect(result.partId).toBe(known.partId);
    expect(result.forecast).toHaveLength(6);
  });

  it('returns a structured error for an unknown part', () => {
    const result = getPartForecast({ partId: 'DOES-NOT-EXIST' });
    if (!('error' in result)) {
      throw new Error('expected an error, got a PartRecord');
    }
    expect(result.error).toBeDefined();
  });
});

describe('getTopMovers', () => {
  it('sorts descending for direction "up"', () => {
    const result = getTopMovers({ direction: 'up', n: 5 });
    expect(result).toHaveLength(5);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].changePct).toBeGreaterThanOrEqual(result[i].changePct as number);
    }
  });

  it('sorts ascending for direction "down"', () => {
    const result = getTopMovers({ direction: 'down', n: 5 });
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].changePct).toBeLessThanOrEqual(result[i].changePct as number);
    }
  });
});

describe('dashboard.json passthrough tools', () => {
  it('getKpis returns the kpis array', () => {
    expect(Array.isArray(getKpis().kpis)).toBe(true);
  });

  it('getCategoryBreakdown returns categories', () => {
    expect(Array.isArray(getCategoryBreakdown().categories)).toBe(true);
  });

  it('getModelComparison returns both comparison and backtest summary', () => {
    const result = getModelComparison();
    expect(Array.isArray(result.modelComparison)).toBe(true);
    expect(Array.isArray(result.backtestSummary)).toBe(true);
  });

  it('getValidationSummary returns validation', () => {
    expect(getValidationSummary().validation).toBeDefined();
  });

  it('getFutureTestResults returns futureTest', () => {
    expect(getFutureTestResults().futureTest).toBeDefined();
  });

  it('getFxScenarios returns a scenarios array', () => {
    expect(Array.isArray(getFxScenarios().scenarios)).toBe(true);
  });

  it('getGeoScenarios returns scenarios, filterable by family', () => {
    const all = getGeoScenarios({});
    expect(Array.isArray(all.scenarios)).toBe(true);
    if (all.scenarios.length > 0) {
      const family = all.scenarios[0].family;
      const filtered = getGeoScenarios({ family });
      for (const s of filtered.scenarios) expect(s.family).toBe(family);
    }
  });

  it('getGeoEventStudies returns eventStudies', () => {
    expect(Array.isArray(getGeoEventStudies().eventStudies)).toBe(true);
  });

  it('getHierarchy returns data for a valid level', () => {
    const result = getHierarchy({ level: 'category' });
    expect(result.data).toBeDefined();
  });

  it('getHierarchy errors for an invalid level', () => {
    const result = getHierarchy({ level: 'bogus' });
    expect(result.error).toBeDefined();
  });

  it('getAlerts returns alerts', () => {
    expect(Array.isArray(getAlerts().alerts)).toBe(true);
  });

  it('getDataProvenance returns dataSources and provenance', () => {
    const result = getDataProvenance();
    expect(Array.isArray(result.dataSources)).toBe(true);
    expect(result.provenance).toBeDefined();
  });
});
