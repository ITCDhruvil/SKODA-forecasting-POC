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

/** Currency: short form ₹17.6 L / ₹1.2 Cr when compact; precise otherwise. */
export function formatCurrency(value: number | null, compact = true): string {
  if (value === null || Number.isNaN(value)) return '--';
  if (compact) return formatSpend(value, false);
  const s = currencySymbol;
  return `${s}${value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Finance-friendly headline amounts (Indian units).
 * Cr (≥1e7), Lakh (≥1e5), else grouped rupees.
 */
export function formatSpend(value: number | null, signed = false): string {
  if (value === null || Number.isNaN(value)) return '--';
  const s = currencySymbol;
  const sign = signed ? (value > 0 ? '+' : value < 0 ? '−' : '') : '';
  const abs = Math.abs(value);
  if (abs >= 1e7) {
    const cr = abs / 1e7;
    const digits = cr >= 100 ? 0 : cr >= 10 ? 1 : 2;
    return `${sign}${s}${cr.toFixed(digits)} Cr`;
  }
  if (abs >= 1e5) {
    const lakh = abs / 1e5;
    const digits = lakh >= 100 ? 0 : 1;
    return `${sign}${s}${lakh.toFixed(digits)} L`;
  }
  return `${sign}${s}${Math.round(abs).toLocaleString('en-IN')}`;
}

/**
 * Axis ticks: one consistent Indian short unit across the scale.
 */
export function formatAxisCurrency(value: number, max: number): string {
  const s = currencySymbol;
  if (max >= 1e7) return `${s}${(value / 1e7).toFixed(1)} Cr`;
  if (max >= 1e5) return `${s}${(value / 1e5).toFixed(1)} L`;
  // Sub-lakh ranges need a decimal so ticks do not all collapse to "₹4K".
  if (max >= 1_000 && max < 100_000) return `${s}${(value / 1_000).toFixed(1)}K`;
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
