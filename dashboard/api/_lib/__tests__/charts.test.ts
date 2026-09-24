import { describe, it, expect } from 'vitest';
import { buildChart, CHART_IDS, type BarChartSpec, type DonutChartSpec, type LineChartSpec } from '../charts';
import { getDashboardJson, getPartsIndex } from '../data';

function assertFiniteOrNull(v: unknown) {
  if (v === null) return;
  expect(typeof v).toBe('number');
  expect(Number.isNaN(v)).toBe(false);
  expect(Number.isFinite(v)).toBe(true);
}

function assertCommon(spec: { title: string; unit: string; currencySymbol: string; source: string }) {
  expect(typeof spec.title).toBe('string');
  expect(spec.title.length).toBeGreaterThan(0);
  expect(['pct', 'currency', 'number']).toContain(spec.unit);
  expect(spec.currencySymbol).toBe('₹');
  expect(spec.source).toMatch(/^Dashboard data, forecast run \d{1,2} \w{3} \d{4}$/);
}

describe('buildChart: mean_price_trend', () => {
  it('returns a line spec built from priceSeries with finite numbers and gaps only where documented', () => {
    const spec = buildChart({ chart: 'mean_price_trend' }) as LineChartSpec;
    expect(spec.kind).toBe('line');
    assertCommon(spec);
    expect(spec.unit).toBe('currency');
    expect(spec.points.length).toBe(42);
    expect(spec.series.map((s) => s.key).sort()).toEqual(['actual', 'forecast']);
    expect(spec.band).toEqual({ lowerKey: 'lower', upperKey: 'upper', label: 'Forecast range' });
    for (const p of spec.points) {
      expect(typeof p.x).toBe('string');
      assertFiniteOrNull(p.actual);
      assertFiniteOrNull(p.forecast);
      assertFiniteOrNull(p.lower);
      assertFiniteOrNull(p.upper);
    }
  });
});

describe('buildChart: basket_forecast', () => {
  it('returns a 6-point line spec from horizon with a band', () => {
    const spec = buildChart({ chart: 'basket_forecast' }) as LineChartSpec;
    expect(spec.kind).toBe('line');
    assertCommon(spec);
    expect(spec.title).toBe('Total basket spend: next 6 months');
    expect(spec.points).toHaveLength(6);
    expect(spec.band).toBeDefined();
    for (const p of spec.points) assertFiniteOrNull(p.value);
  });
});

describe('buildChart: part_forecast', () => {
  it('joins history and forecast for a known part, with the last actual month also set on forecast', () => {
    const rec = getPartsIndex()[0];
    const spec = buildChart({ chart: 'part_forecast', partId: rec.partId }) as LineChartSpec;
    expect(spec.kind).toBe('line');
    assertCommon(spec);
    expect(spec.title).toBe(`${rec.partName}: price history and forecast`);
    expect(spec.points.length).toBeGreaterThan(6);

    const historyPoints = spec.points.filter((p) => p.actual !== null);
    const forecastPoints = spec.points.filter((p) => p.forecast !== null && p.actual === null);
    expect(forecastPoints.length).toBe(6);
    const lastHistory = historyPoints[historyPoints.length - 1];
    expect(lastHistory.forecast).toBe(lastHistory.actual);
    for (const p of spec.points) {
      assertFiniteOrNull(p.actual);
      assertFiniteOrNull(p.forecast);
      assertFiniteOrNull(p.lower);
      assertFiniteOrNull(p.upper);
    }
  });

  it('errors for an unknown part id', () => {
    const result = buildChart({ chart: 'part_forecast', partId: 'DOES-NOT-EXIST' });
    expect(result).toEqual({ error: 'no part found with id DOES-NOT-EXIST' });
  });

  it('errors when no partId is given', () => {
    const result = buildChart({ chart: 'part_forecast' });
    expect('error' in result).toBe(true);
  });
});

describe('buildChart: top_movers', () => {
  it('sorts up movers descending and clamps n to [3, 10]', () => {
    const spec = buildChart({ chart: 'top_movers', direction: 'up', n: 100 }) as BarChartSpec;
    expect(spec.kind).toBe('bar');
    assertCommon(spec);
    expect(spec.unit).toBe('pct');
    expect(spec.rows).toHaveLength(10);
    for (let i = 1; i < spec.rows.length; i++) {
      expect(spec.rows[i - 1].values.change).toBeGreaterThanOrEqual(spec.rows[i].values.change);
    }
    for (const row of spec.rows) {
      expect(row.label.length).toBeLessThanOrEqual(40);
      expect(row.tone).toBe(row.values.change >= 0 ? 'up' : 'down');
    }
  });

  it('sorts down movers ascending and clamps a too-small n up to 3', () => {
    const spec = buildChart({ chart: 'top_movers', direction: 'down', n: 1 }) as BarChartSpec;
    expect(spec.rows).toHaveLength(3);
    for (let i = 1; i < spec.rows.length; i++) {
      expect(spec.rows[i - 1].values.change).toBeLessThanOrEqual(spec.rows[i].values.change);
    }
  });

  it('defaults n to 8', () => {
    const spec = buildChart({ chart: 'top_movers', direction: 'up' }) as BarChartSpec;
    expect(spec.rows).toHaveLength(8);
  });
});

describe('buildChart: category_forecast_change', () => {
  it('returns one bar row per category, sorted descending', () => {
    const spec = buildChart({ chart: 'category_forecast_change' }) as BarChartSpec;
    expect(spec.kind).toBe('bar');
    assertCommon(spec);
    expect(spec.rows.length).toBe(getDashboardJson().categories.length);
    for (let i = 1; i < spec.rows.length; i++) {
      expect(spec.rows[i - 1].values.change).toBeGreaterThanOrEqual(spec.rows[i].values.change);
    }
  });
});

describe('buildChart: spend_share', () => {
  it('sums to the category total within rounding, using Other beyond 8 slices', () => {
    const spec = buildChart({ chart: 'spend_share' }) as DonutChartSpec;
    expect(spec.kind).toBe('donut');
    assertCommon(spec);
    expect(spec.unit).toBe('currency');
    const total = getDashboardJson().categories.reduce((sum, c) => sum + c.value, 0);
    const sliceSum = spec.slices.reduce((sum, s) => sum + s.value, 0);
    // Each slice is independently rounded to whole currency units, so the sum can be off
    // by a few units versus the unrounded total — well within rounding tolerance.
    expect(Math.abs(sliceSum - total)).toBeLessThan(spec.slices.length);
  });

  it('caps at 8 named slices plus Other for a level with more entries', () => {
    const spec = buildChart({ chart: 'spend_share', level: 'vendor' }) as DonutChartSpec;
    const nVendors = getDashboardJson().hierarchy?.vendor?.length ?? 0;
    if (nVendors > 8) {
      expect(spec.slices).toHaveLength(9);
      expect(spec.slices[spec.slices.length - 1].label).toBe('Other');
    } else {
      expect(spec.slices.length).toBe(nVendors);
    }
  });
});

describe('buildChart: spend_change', () => {
  it('returns current/forecast bar rows for the top 8 by current spend', () => {
    const spec = buildChart({ chart: 'spend_change', level: 'category' }) as BarChartSpec;
    expect(spec.kind).toBe('bar');
    expect(spec.orientation).toBe('vertical');
    assertCommon(spec);
    expect(spec.series.map((s) => s.key).sort()).toEqual(['current', 'forecast']);
    expect(spec.rows.length).toBeLessThanOrEqual(8);
    for (const row of spec.rows) {
      assertFiniteOrNull(row.values.current);
      assertFiniteOrNull(row.values.forecast);
    }
  });
});

describe('buildChart: scenario_impact', () => {
  it('builds a bar for a valid fx scenario', () => {
    const fxName = getDashboardJson().fxAnalysis!.scenarios![0].name;
    const spec = buildChart({ chart: 'scenario_impact', family: 'fx', scenario: fxName, level: 'category' }) as BarChartSpec;
    expect(spec.kind).toBe('bar');
    expect(spec.title).toBe(`${fxName}: modeled price impact by category`);
    expect(spec.rows.length).toBeGreaterThan(0);
  });

  it('builds a bar for a valid geo scenario (freight)', () => {
    const geoName = getDashboardJson().geoAnalysis!.scenarios!.find((s) => s.family === 'freight')!.name;
    const spec = buildChart({ chart: 'scenario_impact', family: 'freight', scenario: geoName }) as BarChartSpec;
    expect(spec.kind).toBe('bar');
    expect(spec.rows.length).toBeGreaterThan(0);
  });

  it('errors and lists valid scenario names for an unknown scenario', () => {
    const result = buildChart({ chart: 'scenario_impact', family: 'duty', scenario: 'no such scenario' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      for (const name of getDashboardJson().geoAnalysis!.scenarios!.filter((s) => s.family === 'duty').map((s) => s.name)) {
        expect(result.error).toContain(name);
      }
    }
  });

  it('errors for an unknown family', () => {
    const result = buildChart({ chart: 'scenario_impact', family: 'bogus' as never, scenario: 'x' });
    expect('error' in result).toBe(true);
  });
});

describe('buildChart: model_accuracy', () => {
  it('returns one bar row per model with pct unit', () => {
    const spec = buildChart({ chart: 'model_accuracy' }) as BarChartSpec;
    expect(spec.kind).toBe('bar');
    assertCommon(spec);
    expect(spec.unit).toBe('pct');
    expect(spec.rows.length).toBe(getDashboardJson().modelComparison.length);
  });
});

describe('CHART_IDS', () => {
  it('lists exactly the 9 catalog ids', () => {
    expect([...CHART_IDS].sort()).toEqual(
      [
        'basket_forecast',
        'category_forecast_change',
        'mean_price_trend',
        'model_accuracy',
        'part_forecast',
        'scenario_impact',
        'spend_change',
        'spend_share',
        'top_movers',
      ].sort(),
    );
  });
});
