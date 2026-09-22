import type { DashboardData, Direction, Kpi } from '../types';
import { formatByType, formatSigned } from './format';

export interface SnapshotTile {
  id: string;
  label: string;
  value: string;
  note?: string;
  tone?: 'up' | 'down' | 'neutral';
}

function toneFor(direction: Direction): 'up' | 'down' | 'neutral' {
  if (direction === 'up') return 'up';
  if (direction === 'down') return 'down';
  return 'neutral';
}

function findKpi(kpis: Kpi[] | undefined, id: string): Kpi | undefined {
  return Array.isArray(kpis) ? kpis.find((k) => k?.id === id) : undefined;
}

/**
 * Four "Today" tiles for the open screen: basket price and model accuracy from the dashboard KPIs, plus pending
 * alerts and flagged parts. A KPI that is not present in `data.kpis` (older payload, still loading) is skipped
 * rather than shown broken; this never throws regardless of how malformed `data` is.
 */
export function buildSnapshot(data: DashboardData, pendingAlerts: number | null): SnapshotTile[] {
  const tiles: SnapshotTile[] = [];

  try {
    const basket = findKpi(data?.kpis, 'basket');
    if (basket) {
      tiles.push({
        id: 'basket',
        label: 'Basket price',
        value: formatByType(basket.value, basket.format),
        note: basket.change !== null ? `${formatSigned(basket.change, 1)} ${basket.changeLabel}`.trim() : basket.changeLabel,
        tone: toneFor(basket.direction),
      });
    }
  } catch {
    /* malformed KPI entry: skip this tile */
  }

  try {
    const accuracy = findKpi(data?.kpis, 'accuracy');
    if (accuracy) {
      tiles.push({
        id: 'accuracy',
        label: 'Model accuracy',
        value: formatByType(accuracy.value, accuracy.format),
        note: accuracy.changeLabel,
      });
    }
  } catch {
    /* malformed KPI entry: skip this tile */
  }

  tiles.push({
    id: 'pending-alerts',
    label: 'Pending alerts',
    value: pendingAlerts === null ? '–' : String(pendingAlerts),
    note: 'need a decision',
  });

  try {
    const flaggedCount = Array.isArray(data?.alerts) ? data.alerts.length : 0;
    tiles.push({
      id: 'parts-flagged',
      label: 'Parts flagged',
      value: String(flaggedCount),
      note: 'to review',
    });
  } catch {
    tiles.push({ id: 'parts-flagged', label: 'Parts flagged', value: '0', note: 'to review' });
  }

  return tiles;
}
