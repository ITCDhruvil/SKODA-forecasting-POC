import { describe, it, expect } from 'vitest';
import { buildToolset, WRITE_TOOL_NAMES } from '../toolsets';
import type { ChartSpec } from '../charts';

const names = (defs: { function: { name: string } }[]) => defs.map((d) => d.function.name).sort();

describe('buildToolset', () => {
  it('data mode: the 16 read-only tools plus the per-request showChart and offerExport tools, no web, no write tools', () => {
    const t = buildToolset('data');
    expect(t.definitions).toHaveLength(18);
    expect(names(t.definitions)).toContain('getExposure');
    expect(names(t.definitions)).toContain('showChart');
    expect(names(t.definitions)).toContain('offerExport');
    expect(t.webSearch).toBe(false);
    for (const w of WRITE_TOOL_NAMES) {
      expect(names(t.definitions)).not.toContain(w);
      expect(t.handlers[w]).toBeUndefined();
    }
  });

  it('web mode: same read-only tools plus web search and showChart, and write handlers are NOT loaded', () => {
    const t = buildToolset('web');
    expect(t.webSearch).toBe(true);
    expect(names(t.definitions)).toEqual(names(buildToolset('data').definitions));
    for (const w of WRITE_TOOL_NAMES) {
      expect(names(t.definitions)).not.toContain(w);
      expect(Object.keys(t.handlers)).not.toContain(w);
      expect(t.handlers[w]).toBeUndefined();
    }
  });

  it('action mode: alert tools only, no web, no getExposure, no showChart', () => {
    const t = buildToolset('action');
    expect(names(t.definitions)).toEqual(['confirmGeoAlert', 'dismissGeoAlert', 'getGeoHitlAlerts']);
    expect(Object.keys(t.handlers).sort()).toEqual(['confirmGeoAlert', 'dismissGeoAlert', 'getGeoHitlAlerts']);
    expect(t.webSearch).toBe(false);
    expect(t.handlers.showChart).toBeUndefined();
    expect(t.handlers.getExposure).toBeUndefined();
  });

  it('every definition has a handler and vice versa, in every mode', () => {
    for (const mode of ['data', 'web', 'action'] as const) {
      const t = buildToolset(mode);
      expect(Object.keys(t.handlers).sort()).toEqual(names(t.definitions));
    }
  });

  describe('showChart collector', () => {
    it('unknown chart id returns an error', () => {
      const t = buildToolset('data');
      const result = t.handlers.showChart({ chart: 'bogus' });
      expect(result).toMatchObject({ error: expect.any(String) });
    });

    it('a chart-builder error (e.g. unknown part) is returned as an error, not added to the collector', () => {
      const collected: ChartSpec[] = [];
      const t = buildToolset('data', { onChart: (c) => collected.push(c) });
      const result = t.handlers.showChart({ chart: 'part_forecast', partId: 'DOES-NOT-EXIST' });
      expect(result).toMatchObject({ error: expect.stringContaining('no part found') });
      expect(collected).toHaveLength(0);
    });

    it('draws a valid chart, calls onChart, and returns a title/kind/summary', () => {
      const collected: ChartSpec[] = [];
      const t = buildToolset('data', { onChart: (c) => collected.push(c) });
      const result = t.handlers.showChart({ chart: 'category_forecast_change' }) as {
        ok: boolean;
        drawn: string;
        kind: string;
        summary: string[];
      };
      expect(result.ok).toBe(true);
      expect(typeof result.drawn).toBe('string');
      expect(result.kind).toBe('bar');
      expect(Array.isArray(result.summary)).toBe(true);
      expect(result.summary.length).toBeLessThanOrEqual(5);
      expect(collected).toHaveLength(1);
      expect(collected[0].title).toBe(result.drawn);
    });

    it('dedupes an identical repeated call without drawing it twice', () => {
      const collected: ChartSpec[] = [];
      const t = buildToolset('data', { onChart: (c) => collected.push(c) });
      t.handlers.showChart({ chart: 'model_accuracy' });
      const second = t.handlers.showChart({ chart: 'model_accuracy' });
      expect(second).toEqual({ ok: true, note: 'already drawn' });
      expect(collected).toHaveLength(1);
    });

    it('a different call for the same chart id (different params) is not deduped', () => {
      const t = buildToolset('data');
      const first = t.handlers.showChart({ chart: 'top_movers', direction: 'up' }) as { ok: boolean };
      const second = t.handlers.showChart({ chart: 'top_movers', direction: 'down' }) as { ok: boolean };
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
    });

    it('refuses a third distinct chart with a limit error', () => {
      const t = buildToolset('data');
      t.handlers.showChart({ chart: 'model_accuracy' });
      t.handlers.showChart({ chart: 'category_forecast_change' });
      const third = t.handlers.showChart({ chart: 'basket_forecast' });
      expect(third).toEqual({ error: 'chart limit reached (2 per answer)' });
    });

    it('each buildToolset call gets a fresh collector', () => {
      const t1 = buildToolset('data');
      t1.handlers.showChart({ chart: 'model_accuracy' });
      t1.handlers.showChart({ chart: 'category_forecast_change' });

      const t2 = buildToolset('data');
      const result = t2.handlers.showChart({ chart: 'basket_forecast' }) as { ok: boolean };
      expect(result.ok).toBe(true);
    });

    it('is available in web mode too', () => {
      const t = buildToolset('web');
      const result = t.handlers.showChart({ chart: 'model_accuracy' }) as { ok: boolean };
      expect(result.ok).toBe(true);
    });
  });

  describe('buildToolset export wiring', () => {
    it('offers offerExport in data and web mode', () => {
      for (const mode of ['data', 'web'] as const) {
        const names = buildToolset(mode).definitions.map((d) => d.function.name);
        expect(names, mode).toContain('offerExport');
      }
    });

    it('withholds offerExport in action mode', () => {
      const toolset = buildToolset('action');
      expect(toolset.definitions.map((d) => d.function.name)).not.toContain('offerExport');
      expect(toolset.handlers.offerExport).toBeUndefined();
    });

    it('routes a successful offerExport call to onExport', () => {
      const offers: unknown[] = [];
      const toolset = buildToolset('data', { onExport: (o) => offers.push(o) });
      toolset.handlers.offerExport({ format: 'xlsx', label: 'Alerts', export: 'alerts' });
      expect(offers).toHaveLength(1);
    });

    it('builds a fresh offer collector per call, so two toolsets do not share state', () => {
      const a: unknown[] = [];
      const b: unknown[] = [];
      buildToolset('data', { onExport: (o) => a.push(o) }).handlers.offerExport({ format: 'xlsx', label: 'A', export: 'alerts' });
      buildToolset('data', { onExport: (o) => b.push(o) }).handlers.offerExport({ format: 'xlsx', label: 'B', export: 'alerts' });
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });
  });
});
