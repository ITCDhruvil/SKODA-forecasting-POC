// dashboard/api/_lib/__tests__/exportCatalog.test.ts
import { describe, it, expect } from 'vitest';
import { getPartsIndex } from '../data';
import { buildExportData, EXPORT_IDS, MAX_EXPORT_ROWS, type ExportData } from '../exportCatalog';

function ok(result: ExportData | { error: string }): ExportData {
  if ('error' in result) throw new Error(`expected data, got error: ${result.error}`);
  return result;
}

describe('buildExportData', () => {
  it('rejects an unknown export id', () => {
    const result = buildExportData({ export: 'nope' as never });
    expect(result).toHaveProperty('error');
  });

  it('every catalog id produces titled, columned, non-empty data', () => {
    for (const id of EXPORT_IDS) {
      const args =
        id === 'top_movers' ? { export: id, direction: 'up' as const } :
        id === 'hierarchy' ? { export: id, level: 'category' as const } :
        { export: id };
      const data = ok(buildExportData(args));
      expect(data.title, id).toBeTruthy();
      expect(data.columns.length, id).toBeGreaterThan(0);
      expect(data.rows.length, id).toBeGreaterThan(0);
      expect(data.source, id).toBeTruthy();
      expect(data.truncated, id).toBe(false);
    }
  });

  it('every row only uses keys declared in columns', () => {
    const data = ok(buildExportData({ export: 'top_movers', direction: 'down', n: 5 }));
    const keys = new Set(data.columns.map((c) => c.key));
    for (const row of data.rows) {
      for (const k of Object.keys(row)) expect(keys.has(k)).toBe(true);
    }
  });

  it('top_movers honours n and direction', () => {
    const up = ok(buildExportData({ export: 'top_movers', direction: 'up', n: 5 }));
    expect(up.rows).toHaveLength(5);
    const changes = up.rows.map((r) => Number(r.changePct));
    expect(changes[0]).toBeGreaterThanOrEqual(changes[4]);

    const down = ok(buildExportData({ export: 'top_movers', direction: 'down', n: 5 }));
    expect(Number(down.rows[0].changePct)).toBeLessThanOrEqual(Number(up.rows[0].changePct));
  });

  it('top_movers defaults to 20 rows', () => {
    const data = ok(buildExportData({ export: 'top_movers', direction: 'up' }));
    expect(data.rows).toHaveLength(20);
  });

  it('parts_search with no filters returns the whole index, capped', () => {
    const data = ok(buildExportData({ export: 'parts_search' }));
    expect(data.rows).toHaveLength(Math.min(getPartsIndex().length, MAX_EXPORT_ROWS));
  });

  it('parts_search filters by category', () => {
    const category = getPartsIndex()[0].category;
    const data = ok(buildExportData({ export: 'parts_search', category }));
    expect(data.rows.length).toBeGreaterThan(0);
    for (const row of data.rows) expect(row.category).toBe(category);
  });

  it('parts_search with an impossible filter errors rather than returning an empty sheet', () => {
    const result = buildExportData({ export: 'parts_search', query: 'zzz-no-such-part-zzz' });
    expect(result).toHaveProperty('error');
  });

  it('hierarchy rejects an unknown level', () => {
    const result = buildExportData({ export: 'hierarchy', level: 'galaxy' as never });
    expect(result).toHaveProperty('error');
  });

  it('scenarios includes a family column and filters on it', () => {
    const all = ok(buildExportData({ export: 'scenarios' }));
    expect(all.columns.some((c) => c.key === 'family')).toBe(true);
    const families = new Set(all.rows.map((r) => String(r.family)));
    expect(families.size).toBeGreaterThan(0);

    const one = [...families][0] as 'fx' | 'freight' | 'gpr' | 'duty';
    const filtered = ok(buildExportData({ export: 'scenarios', family: one }));
    for (const row of filtered.rows) expect(row.family).toBe(one);
  });

  it('top_movers guards against NaN in n, falling back to DEFAULT_TOP_MOVERS', () => {
    const data = ok(buildExportData({ export: 'top_movers', direction: 'up', n: NaN }));
    expect(data.rows).toHaveLength(20);
  });

  it('top_movers guards against non-numeric n, falling back to DEFAULT_TOP_MOVERS', () => {
    const data = ok(buildExportData({ export: 'top_movers', direction: 'up', n: 'abc' as never }));
    expect(data.rows).toHaveLength(20);
  });
});
