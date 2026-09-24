import { describe, expect, it } from 'vitest';
import {
  availableMonthExtent,
  dateRangeToMonthKeys,
  filterByMonth,
  filterDashboardData,
  monthInRange,
} from '../filterDashboardData';
import type { DashboardData, PricePoint } from '../../types';

const series: PricePoint[] = [
  {
    month: '2024-01',
    label: 'Jan 2024',
    actual: 100,
    fitted: null,
    forecast: null,
    lower: null,
    upper: null,
  },
  {
    month: '2024-06',
    label: 'Jun 2024',
    actual: 110,
    fitted: null,
    forecast: null,
    lower: null,
    upper: null,
  },
  {
    month: '2024-12',
    label: 'Dec 2024',
    actual: null,
    fitted: null,
    forecast: 120,
    lower: 115,
    upper: 125,
  },
];

function stubData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    kpis: [
      {
        id: 'basket',
        label: 'Basket',
        value: 100,
        format: 'currency',
        change: 0,
        changeLabel: '',
        direction: 'flat',
        icon: 'basket',
      },
      {
        id: 'forecast',
        label: 'Forecast',
        value: 120,
        format: 'currency',
        change: 0,
        changeLabel: '',
        direction: 'flat',
        icon: 'forecast',
      },
    ],
    priceSeries: series,
    horizon: [
      {
        month: '2024-12',
        label: 'Dec 2024',
        value: 120,
        lower: 115,
        upper: 125,
      },
    ],
    categories: [],
    topParts: [],
    alerts: [],
    meta: {
      historyRange: ['2024-01', '2024-06'],
      forecastHorizon: 6,
      historyMonths: 6,
      nParts: 10,
      currencySymbol: '₹',
      versions: {},
    },
    provenance: { macroSeriesId: 'x', macroSource: 'x', skuLayer: 'synthetic', skuIsReal: false, extrapolatedMonths: 0 },
    ...overrides,
  } as DashboardData;
}

describe('filterDashboardData', () => {
  it('maps calendar dates to inclusive month keys', () => {
    expect(
      dateRangeToMonthKeys({
        start: new Date(2024, 5, 15),
        end: new Date(2024, 11, 2),
      }),
    ).toEqual({ start: '2024-06', end: '2024-12' });
  });

  it('filters rows by month', () => {
    expect(monthInRange('2024-06', { start: '2024-01', end: '2024-06' })).toBe(true);
    expect(filterByMonth(series, { start: '2024-06', end: '2024-12' })).toHaveLength(2);
  });

  it('slices series and recomputes basket / forecast KPIs', () => {
    const filtered = filterDashboardData(stubData(), { start: '2024-06', end: '2024-12' });
    expect(filtered.priceSeries.map((p) => p.month)).toEqual(['2024-06', '2024-12']);
    expect(filtered.horizon).toHaveLength(1);
    const basket = filtered.kpis.find((k) => k.id === 'basket');
    const forecast = filtered.kpis.find((k) => k.id === 'forecast');
    expect(basket?.value).toBe(110);
    expect(forecast?.value).toBe(120);
  });

  it('availableMonthExtent includes forecast months', () => {
    expect(availableMonthExtent(stubData())).toEqual(['2024-01', '2024-12']);
  });
});
