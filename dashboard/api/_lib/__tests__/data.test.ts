import { describe, it, expect } from 'vitest';
import Papa from 'papaparse';
import fs from 'node:fs';
import path from 'node:path';
import { getDashboardJson, getPartsIndex, getPartHistory } from '../data';

const FORECASTS_CSV_PATH = path.join(process.cwd(), 'api', '_data', 'forecasts.csv');

describe('getDashboardJson', () => {
  it('loads the dashboard payload with expected top-level shape', () => {
    const data = getDashboardJson();
    expect(data.meta.nParts).toBeGreaterThan(0);
    expect(Array.isArray(data.kpis)).toBe(true);
  });
});

describe('getPartsIndex', () => {
  it('returns one record per unique part_id in the raw CSV', () => {
    const raw = fs.readFileSync(FORECASTS_CSV_PATH, 'utf-8');
    const parsed = Papa.parse<{ part_id: string }>(raw, { header: true, skipEmptyLines: true });
    const uniqueIds = new Set(parsed.data.map((row) => row.part_id));

    const index = getPartsIndex();
    expect(index.length).toBe(uniqueIds.size);
  });

  it('gives every part a full, sorted 6-month xgboost forecast curve', () => {
    const index = getPartsIndex();
    expect(index.length).toBeGreaterThan(0);
    for (const rec of index) {
      expect(rec.forecast.map((f) => f.horizon)).toEqual([1, 2, 3, 4, 5, 6]);
    }
  });

  it('resolves a numeric current price for parts present in parts_prices.csv', () => {
    const index = getPartsIndex();
    const withPrice = index.filter((rec) => rec.currentPrice !== null);
    expect(withPrice.length).toBeGreaterThan(0);
    for (const rec of withPrice.slice(0, 20)) {
      expect(typeof rec.currentPrice).toBe('number');
      expect(Number.isNaN(rec.currentPrice)).toBe(false);
    }
  });

  it('cross-checks one known part against an independent parse of the raw CSV', () => {
    const raw = fs.readFileSync(FORECASTS_CSV_PATH, 'utf-8');
    const parsed = Papa.parse<Record<string, string>>(raw, { header: true, skipEmptyLines: true });
    const partId = parsed.data[0].part_id;
    const rawHorizon1 = parsed.data.find(
      (row) => row.part_id === partId && row.model === 'xgboost' && row.horizon === '1',
    );
    expect(rawHorizon1).toBeDefined();

    const rec = getPartsIndex().find((r) => r.partId === partId);
    expect(rec).toBeDefined();
    const horizon1 = rec!.forecast.find((f) => f.horizon === 1);
    expect(horizon1?.prediction).toBeCloseTo(Number(rawHorizon1!.prediction), 4);
    expect(horizon1?.targetMonth).toBe(rawHorizon1!.target_month);
  });
});

describe('getPartHistory', () => {
  it('returns up to the last 12 months of price history, sorted ascending, as YYYY-MM points', () => {
    const partId = getPartsIndex()[0].partId;
    const history = getPartHistory(partId);
    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThanOrEqual(12);
    for (const point of history) {
      expect(point.month).toMatch(/^\d{4}-\d{2}$/);
      expect(typeof point.price).toBe('number');
      expect(Number.isNaN(point.price)).toBe(false);
    }
    for (let i = 1; i < history.length; i++) {
      expect(history[i].month >= history[i - 1].month).toBe(true);
    }
  });

  it('cross-checks the last point against an independent parse of the raw CSV', () => {
    const partId = getPartsIndex()[0].partId;
    const raw = fs.readFileSync(path.join(process.cwd(), 'api', '_data', 'parts_prices.csv'), 'utf-8');
    const parsed = Papa.parse<{ part_id: string; month: string; price: string }>(raw, { header: true, skipEmptyLines: true });
    const rows = parsed.data.filter((r) => r.part_id === partId).sort((a, b) => a.month.localeCompare(b.month));
    const last = rows[rows.length - 1];

    const history = getPartHistory(partId);
    const lastPoint = history[history.length - 1];
    expect(lastPoint.month).toBe(last.month.slice(0, 7));
    expect(lastPoint.price).toBeCloseTo(Number(last.price), 4);
  });

  it('returns an empty array for an unknown part id', () => {
    expect(getPartHistory('DOES-NOT-EXIST')).toEqual([]);
  });
});
