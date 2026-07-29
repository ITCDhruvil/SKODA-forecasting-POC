import type { NumberFormat } from '../types';

/**
 * Currency symbol for the pricing currency, set once from the payload.
 *
 * Parts are priced in the assembly plant's currency (INR for a Kushaq built at
 * Pune). Labelling rupee figures with a dollar sign would misstate every number
 * on the page by a factor of ~90, so the symbol travels with the data rather
 * than being hardcoded.
 */
let currencySymbol = '₹';

export function setCurrencySymbol(symbol: string): void {
  if (symbol) currencySymbol = symbol;
}

/** Compact currency: ₹2.45M, ₹128.4K, ₹1,284.00. */
export function formatCurrency(value: number | null, compact = true): string {
  if (value === null || Number.isNaN(value)) return '--';
  const s = currencySymbol;
  if (compact && Math.abs(value) >= 1_000_000) return `${s}${(value / 1_000_000).toFixed(2)}M`;
  if (compact && Math.abs(value) >= 10_000) return `${s}${(value / 1_000).toFixed(1)}K`;
  return `${s}${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Axis ticks: always the same shape across a scale.
 *
 * `formatCurrency` switches to compact form above a threshold, which on an axis
 * produces the mixed run "$0.00, $8,500.00, $17.0K". Ticks need one consistent
 * unit, chosen from the largest value on the axis.
 */
export function formatAxisCurrency(value: number, max: number): string {
  const s = currencySymbol;
  if (max >= 1_000_000) return `${s}${(value / 1_000_000).toFixed(1)}M`;
  if (max >= 1_000) return `${s}${Math.round(value / 1_000)}K`;
  return `${s}${Math.round(value)}`;
}

export function formatNumber(value: number | null, digits = 0): string {
  if (value === null || Number.isNaN(value)) return '--';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatPercent(value: number | null, digits = 1): string {
  if (value === null || Number.isNaN(value)) return '--';
  return `${value.toFixed(digits)}%`;
}

export function formatSigned(value: number | null, digits = 1): string {
  if (value === null || Number.isNaN(value)) return '--';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function formatByType(value: number | null, format: NumberFormat): string {
  switch (format) {
    case 'currency':
      return formatCurrency(value);
    case 'percent':
      return formatPercent(value, 1);
    case 'integer':
      return formatNumber(value, 0);
    default:
      return formatNumber(value, 2);
  }
}

/** "Jun 2026" from "2026-06". */
export function monthLabel(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(year, m - 1, 1).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
}
