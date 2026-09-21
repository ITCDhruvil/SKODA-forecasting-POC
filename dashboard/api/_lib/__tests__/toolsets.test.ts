import { describe, it, expect } from 'vitest';
import { buildToolset, WRITE_TOOL_NAMES } from '../toolsets';

const names = (defs: { function: { name: string } }[]) => defs.map((d) => d.function.name).sort();

describe('buildToolset', () => {
  it('data mode: the 15 read-only tools, no web, no write tools', () => {
    const t = buildToolset('data');
    expect(t.definitions).toHaveLength(15);
    expect(t.webSearch).toBe(false);
    for (const w of WRITE_TOOL_NAMES) {
      expect(names(t.definitions)).not.toContain(w);
      expect(t.handlers[w]).toBeUndefined();
    }
  });

  it('web mode: same read-only tools plus web search, and write handlers are NOT loaded', () => {
    const t = buildToolset('web');
    expect(t.webSearch).toBe(true);
    expect(names(t.definitions)).toEqual(names(buildToolset('data').definitions));
    for (const w of WRITE_TOOL_NAMES) {
      expect(names(t.definitions)).not.toContain(w);
      expect(Object.keys(t.handlers)).not.toContain(w);
      expect(t.handlers[w]).toBeUndefined();
    }
  });

  it('action mode: alert tools only, no web', () => {
    const t = buildToolset('action');
    expect(names(t.definitions)).toEqual(['confirmGeoAlert', 'dismissGeoAlert', 'getGeoHitlAlerts']);
    expect(Object.keys(t.handlers).sort()).toEqual(['confirmGeoAlert', 'dismissGeoAlert', 'getGeoHitlAlerts']);
    expect(t.webSearch).toBe(false);
  });

  it('every definition has a handler and vice versa, in every mode', () => {
    for (const mode of ['data', 'web', 'action'] as const) {
      const t = buildToolset(mode);
      expect(Object.keys(t.handlers).sort()).toEqual(names(t.definitions));
    }
  });
});
