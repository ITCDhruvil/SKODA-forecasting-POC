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
  getGeoHitlAlerts,
  confirmGeoAlert,
  dismissGeoAlert,
  TOOL_DEFINITIONS,
  TOOL_HANDLERS,
} from '../tools';
import type { KvHashClient } from '../hitlStatus';

function fakeKvClient(initial: Record<string, string> = {}): KvHashClient {
  const store: Record<string, string> = { ...initial };
  return {
    hgetall: async (key: string) => (key === 'hitl-status' ? { ...store } : null),
    hset: async (key: string, fields: Record<string, string>) => {
      if (key !== 'hitl-status') throw new Error(`unexpected key: ${key}`);
      Object.assign(store, fields);
      return Object.keys(fields).length;
    },
  };
}

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
    if ('error' in result) {
      throw new Error(`expected a list of movers, got error: ${result.error}`);
    }
    expect(result).toHaveLength(5);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].changePct).toBeGreaterThanOrEqual(result[i].changePct as number);
    }
  });

  it('sorts ascending for direction "down"', () => {
    const result = getTopMovers({ direction: 'down', n: 5 });
    if ('error' in result) {
      throw new Error(`expected a list of movers, got error: ${result.error}`);
    }
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].changePct).toBeLessThanOrEqual(result[i].changePct as number);
    }
  });

  it('returns a structured error for an invalid or missing direction', () => {
    const missing = getTopMovers({} as { direction: 'up' | 'down' });
    expect('error' in missing).toBe(true);

    const bogus = getTopMovers({ direction: 'sideways' as 'up' | 'down' });
    expect('error' in bogus).toBe(true);
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

describe('getGeoHitlAlerts / confirmGeoAlert / dismissGeoAlert', () => {
  it('lists all alerts as pending when the store is empty', async () => {
    const client = fakeKvClient();
    const result = await getGeoHitlAlerts(client);
    if ('error' in result) throw new Error('expected success');
    expect(result.alerts.length).toBeGreaterThan(0);
    for (const a of result.alerts) expect(a.status).toBe('pending');
  });

  it('returns totalCount/pendingCount matching the actual alerts array', async () => {
    const client = fakeKvClient();
    const listAllPending = await getGeoHitlAlerts(client);
    if ('error' in listAllPending) throw new Error('expected success');
    expect(listAllPending.totalCount).toBe(listAllPending.alerts.length);
    expect(listAllPending.pendingCount).toBe(listAllPending.alerts.length);

    const alertId = listAllPending.alerts[0].alertId;
    await confirmGeoAlert(client, { alertId });

    const listAfterOneConfirmed = await getGeoHitlAlerts(client);
    if ('error' in listAfterOneConfirmed) throw new Error('expected success');
    expect(listAfterOneConfirmed.totalCount).toBe(listAllPending.totalCount);
    expect(listAfterOneConfirmed.pendingCount).toBe(listAllPending.totalCount - 1);
  });

  it('confirmGeoAlert persists the status and returns the impact block', async () => {
    const client = fakeKvClient();
    const listBefore = await getGeoHitlAlerts(client);
    if ('error' in listBefore) throw new Error('expected success');
    const alertId = listBefore.alerts[0].alertId;

    const result = await confirmGeoAlert(client, { alertId });
    if ('error' in result) throw new Error('expected success');
    expect(result.ok).toBe(true);
    expect(result.impact).toBeDefined();

    const listAfter = await getGeoHitlAlerts(client);
    if ('error' in listAfter) throw new Error('expected success');
    const updated = listAfter.alerts.find((a) => a.alertId === alertId);
    expect(updated?.status).toBe('confirmed');
  });

  it('dismissGeoAlert persists the status with no impact returned', async () => {
    const client = fakeKvClient();
    const listBefore = await getGeoHitlAlerts(client);
    if ('error' in listBefore) throw new Error('expected success');
    const alertId = listBefore.alerts[0].alertId;

    const result = await dismissGeoAlert(client, { alertId });
    expect(result).toEqual({ ok: true });

    const listAfter = await getGeoHitlAlerts(client);
    if ('error' in listAfter) throw new Error('expected success');
    const updated = listAfter.alerts.find((a) => a.alertId === alertId);
    expect(updated?.status).toBe('dismissed');
  });

  it('confirmGeoAlert returns a structured error for an unknown alertId', async () => {
    const client = fakeKvClient();
    const result = await confirmGeoAlert(client, { alertId: 'DOES-NOT-EXIST' });
    expect(result).toEqual({ error: 'unknown alertId' });
  });
});

describe('getExposure tool registration', () => {
  it('is registered in TOOL_DEFINITIONS and TOOL_HANDLERS and works end to end', () => {
    const def = TOOL_DEFINITIONS.find((d) => d.function.name === 'getExposure');
    expect(def).toBeDefined();
    expect(TOOL_HANDLERS.getExposure).toBeDefined();

    const result = TOOL_HANDLERS.getExposure({ driver: 'steel' }) as { driver?: string; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.driver).toBe('steel');
  });
});
