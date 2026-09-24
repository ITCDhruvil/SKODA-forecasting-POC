import type {
  DashboardData,
  HorizonBar,
  Kpi,
  MaterialCost,
  MaterialPricePoint,
  PricePoint,
} from '../types';
import type { DateRange } from '../components/ui/schedule-date';
import { monthLabel } from './format';

export interface MonthRange {
  /** Inclusive YYYY-MM */
  start: string;
  /** Inclusive YYYY-MM */
  end: string;
}

export function dateToMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function dateRangeToMonthKeys(range: DateRange): MonthRange | null {
  if (!range.start || !range.end) return null;
  let start = dateToMonthKey(range.start);
  let end = dateToMonthKey(range.end);
  if (start > end) [start, end] = [end, start];
  return { start, end };
}

export function monthInRange(month: string, range: MonthRange): boolean {
  return month >= range.start && month <= range.end;
}

export function filterByMonth<T extends { month: string }>(rows: T[], range: MonthRange): T[] {
  return rows.filter((row) => monthInRange(row.month, range));
}

/** Full chart extent: history start through last priceSeries month (includes forecast). */
export function availableMonthExtent(data: DashboardData): [string, string] {
  const start = data.meta.historyRange[0];
  const end =
    data.priceSeries.at(-1)?.month ??
    data.materialCost?.priceSeries?.at(-1)?.month ??
    data.meta.historyRange[1];
  return [start, end];
}

function pctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

function directionOf(change: number | null): Kpi['direction'] {
  if (change == null || change === 0) return 'flat';
  return change > 0 ? 'up' : 'down';
}

/**
 * Recompute basket / forecast KPIs from the filtered mean-price series.
 * Accuracy and at-risk stay as pipeline snapshots (need the full parts panel).
 */
function recomputeKpis(kpis: Kpi[], series: PricePoint[]): Kpi[] {
  if (series.length === 0) return kpis;

  const actuals = series.filter((p) => p.actual != null);
  const forecasts = series.filter((p) => p.forecast != null);

  const lastActual = actuals.at(-1);
  const prevActual = actuals.length >= 2 ? actuals.at(-2) : null;
  const lastForecast = forecasts.at(-1);

  return kpis.map((kpi) => {
    if (kpi.id === 'basket' && lastActual?.actual != null) {
      const change =
        prevActual?.actual != null ? pctChange(prevActual.actual, lastActual.actual) : null;
      return {
        ...kpi,
        value: lastActual.actual,
        change,
        changeLabel:
          change == null
            ? `as of ${lastActual.label}`
            : `${change >= 0 ? '+' : ''}${change.toFixed(1)}% vs previous month in range`,
        direction: directionOf(change),
        note: `Window ${series[0].label} – ${series.at(-1)!.label}`,
      };
    }

    if (kpi.id === 'forecast' && lastForecast?.forecast != null) {
      const base = lastActual?.actual ?? null;
      const change = base != null ? pctChange(base, lastForecast.forecast) : null;
      return {
        ...kpi,
        value: lastForecast.forecast,
        change,
        changeLabel:
          change == null
            ? `as of ${lastForecast.label}`
            : `${change >= 0 ? '+' : ''}${change.toFixed(1)}% vs last actual in range`,
        direction: directionOf(change),
        note: `End of selected window (${lastForecast.label})`,
      };
    }

    return kpi;
  });
}

function filterMaterialCost(mc: MaterialCost | undefined, range: MonthRange): MaterialCost | undefined {
  if (!mc?.available || !mc.priceSeries) return mc;

  const priceSeries = filterByMonth(mc.priceSeries, range);
  if (priceSeries.length === 0) {
    return { ...mc, priceSeries };
  }

  const nomMonth = mc.milestones?.nomination.month;
  const sopMonth = mc.milestones?.sop.month;

  // Only slice the tracker chart. Keep spend KPIs from the pipeline part
  // sums so Material Cost stays aligned with basket / hierarchy / tree.
  const annotated: MaterialPricePoint[] = priceSeries.map((p) => ({
    ...p,
    isNomination: nomMonth ? p.month === nomMonth : Boolean(p.isNomination),
    isSop: sopMonth ? p.month === sopMonth : Boolean(p.isSop),
  }));

  return {
    ...mc,
    priceSeries: annotated,
    summary: mc.summary,
  };
}

/**
 * Slice time-series fields to an inclusive month window and refresh
 * KPIs / material summary that can be derived from those series.
 */
export function filterDashboardData(data: DashboardData, range: MonthRange): DashboardData {
  const priceSeries = filterByMonth(data.priceSeries, range);
  const horizon = filterByMonth(data.horizon, range) as HorizonBar[];
  const macroSeries = data.macroSeries ? filterByMonth(data.macroSeries, range) : data.macroSeries;

  return {
    ...data,
    priceSeries,
    horizon,
    macroSeries,
    kpis: recomputeKpis(data.kpis, priceSeries),
    materialCost: filterMaterialCost(data.materialCost, range),
    meta: {
      ...data.meta,
      historyRange: [range.start, range.end <= data.meta.historyRange[1] ? range.end : data.meta.historyRange[1]],
    },
  };
}
