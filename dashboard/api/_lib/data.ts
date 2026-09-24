import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import type { DashboardData } from '../../src/types';

const DASHBOARD_JSON_PATH = path.join(process.cwd(), 'api', '_data', 'dashboard.json');
const FORECASTS_CSV_PATH = path.join(process.cwd(), 'api', '_data', 'forecasts.csv');
const PARTS_PRICES_CSV_PATH = path.join(process.cwd(), 'api', '_data', 'parts_prices.csv');

let dashboardCache: DashboardData | null = null;

export function getDashboardJson(): DashboardData {
  if (!dashboardCache) {
    const raw = fs.readFileSync(DASHBOARD_JSON_PATH, 'utf-8');
    dashboardCache = JSON.parse(raw) as DashboardData;
  }
  return dashboardCache;
}

export interface ForecastPoint {
  horizon: number;
  targetMonth: string;
  prediction: number;
  lower: number;
  upper: number;
}

export interface PartRecord {
  partId: string;
  partName: string;
  category: string;
  vendor: string;
  vendorOrigin: string;
  project: string;
  oem: string;
  isAnomalyPart: boolean;
  currentPrice: number | null;
  currentMonth: string | null;
  forecast: ForecastPoint[];
}

interface RawForecastRow {
  model: string;
  part_id: string;
  horizon: string;
  target_month: string;
  prediction: string;
  lower: string;
  upper: string;
  part_name: string;
  project: string;
  vendor: string;
  vendor_origin: string;
  category: string;
  oem: string;
  is_anomaly_part: string;
}

interface RawPriceRow {
  month: string;
  price: string;
  part_id: string;
}

function parseCsv<T>(filePath: string): T[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = Papa.parse<T>(raw, { header: true, skipEmptyLines: true });
  return parsed.data;
}

let partsIndexCache: PartRecord[] | null = null;

export function getPartsIndex(): PartRecord[] {
  if (partsIndexCache) return partsIndexCache;

  const priceRows = parseCsv<RawPriceRow>(PARTS_PRICES_CSV_PATH);
  const latestPriceByPart = new Map<string, { price: number; month: string }>();
  for (const row of priceRows) {
    const existing = latestPriceByPart.get(row.part_id);
    if (!existing || row.month > existing.month) {
      latestPriceByPart.set(row.part_id, { price: Number(row.price), month: row.month });
    }
  }

  const forecastRows = parseCsv<RawForecastRow>(FORECASTS_CSV_PATH);
  const byPart = new Map<string, PartRecord>();
  for (const row of forecastRows) {
    if (row.model !== 'xgboost') continue;
    let rec = byPart.get(row.part_id);
    if (!rec) {
      const priceInfo = latestPriceByPart.get(row.part_id) ?? null;
      rec = {
        partId: row.part_id,
        partName: row.part_name,
        category: row.category,
        vendor: row.vendor,
        vendorOrigin: row.vendor_origin,
        project: row.project,
        oem: row.oem,
        isAnomalyPart: row.is_anomaly_part === 'True',
        currentPrice: priceInfo?.price ?? null,
        currentMonth: priceInfo?.month ?? null,
        forecast: [],
      };
      byPart.set(row.part_id, rec);
    }
    rec.forecast.push({
      horizon: Number(row.horizon),
      targetMonth: row.target_month,
      prediction: Number(row.prediction),
      lower: Number(row.lower),
      upper: Number(row.upper),
    });
  }

  for (const rec of byPart.values()) {
    rec.forecast.sort((a, b) => a.horizon - b.horizon);
  }

  partsIndexCache = Array.from(byPart.values()).sort((a, b) => a.partId.localeCompare(b.partId));
  return partsIndexCache;
}

export interface PartHistoryPoint {
  month: string;
  price: number;
}

let partHistoryCache: Map<string, PartHistoryPoint[]> | null = null;

function buildPartHistoryCache(): Map<string, PartHistoryPoint[]> {
  const priceRows = parseCsv<RawPriceRow>(PARTS_PRICES_CSV_PATH);
  const byPart = new Map<string, PartHistoryPoint[]>();
  for (const row of priceRows) {
    const arr = byPart.get(row.part_id) ?? [];
    arr.push({ month: row.month.slice(0, 7), price: Number(row.price) });
    byPart.set(row.part_id, arr);
  }
  for (const arr of byPart.values()) arr.sort((a, b) => a.month.localeCompare(b.month));
  return byPart;
}

/** Up to the last 12 months of price history for one part, sorted ascending. Empty for an unknown part id. */
export function getPartHistory(partId: string): PartHistoryPoint[] {
  if (!partHistoryCache) partHistoryCache = buildPartHistoryCache();
  const rows = partHistoryCache.get(partId) ?? [];
  return rows.slice(-12);
}

/** Percent change from current to forecast price, or null if either is missing or current is zero. */
export function changePct(current: number | null, forecast: number | null): number | null {
  if (current === null || forecast === null || current === 0) return null;
  return ((forecast - current) / current) * 100;
}
