import { describe, it, expect } from 'vitest';
import { buildSnapshot } from '../snapshot';
import type { DashboardData, Kpi } from '../../types';

function kpi(overrides: Partial<Kpi> & { id: string }): Kpi {
  return {
    label: 'x',
    value: 0,
    format: 'currency',
    change: null,
    changeLabel: '',
    direction: 'flat',
    icon: 'trending',
    ...overrides,
  };
}

function data(overrides: { kpis?: Kpi[]; alerts?: unknown[] } = {}): DashboardData {
  return {
    kpis: overrides.kpis ?? [],
    alerts: (overrides.alerts ?? []) as DashboardData['alerts'],
  } as unknown as DashboardData;
}

describe('buildSnapshot', () => {
  it('builds all four tiles from a full fixture', () => {
    const d = data({
      kpis: [
        kpi({ id: 'basket', value: 128400, format: 'currency', change: 0.8, changeLabel: 'vs previous month', direction: 'up' }),
        kpi({ id: 'accuracy', value: 96.7, format: 'percent', change: null, changeLabel: 'xgboost - 3.30% MAPE', direction: 'flat' }),
      ],
      alerts: [{ id: '1' }, { id: '2' }, { id: '3' }],
    });
    const tiles = buildSnapshot(d, 2);
    expect(tiles).toHaveLength(4);

    const basket = tiles.find((t) => t.id === 'basket');
    expect(basket?.tone).toBe('up');
    expect(basket?.note).toContain('vs previous month');
    expect(basket?.note).toMatch(/^\+0\.8%/);

    const accuracy = tiles.find((t) => t.id === 'accuracy');
    expect(accuracy?.value).toBe('96.7%');
    expect(accuracy?.note).toBe('xgboost - 3.30% MAPE');

    const pending = tiles.find((t) => t.id === 'pending-alerts');
    expect(pending?.value).toBe('2');
    expect(pending?.note).toBe('need a decision');

    const flagged = tiles.find((t) => t.id === 'parts-flagged');
    expect(flagged?.value).toBe('3');
    expect(flagged?.note).toBe('to review');
  });

  it('shows a dash for pending alerts while unknown', () => {
    const d = data({ kpis: [], alerts: [] });
    const tiles = buildSnapshot(d, null);
    const pending = tiles.find((t) => t.id === 'pending-alerts');
    expect(pending?.value).toBe('–');
  });

  it('gives a down tone for a falling basket', () => {
    const d = data({
      kpis: [kpi({ id: 'basket', value: 100, format: 'currency', change: -1.2, changeLabel: 'vs previous month', direction: 'down' })],
    });
    const basket = buildSnapshot(d, null).find((t) => t.id === 'basket');
    expect(basket?.tone).toBe('down');
    expect(basket?.note).toMatch(/^-1\.2%/);
  });

  it('omits a tile when its KPI is missing, without throwing', () => {
    const d = data({ kpis: [], alerts: [] });
    const tiles = buildSnapshot(d, 0);
    expect(tiles.find((t) => t.id === 'basket')).toBeUndefined();
    expect(tiles.find((t) => t.id === 'accuracy')).toBeUndefined();
    expect(tiles).toHaveLength(2); // pending-alerts + parts-flagged still present
  });

  it('never throws for a minimal or malformed fixture', () => {
    expect(() => buildSnapshot({} as unknown as DashboardData, null)).not.toThrow();
  });
});
