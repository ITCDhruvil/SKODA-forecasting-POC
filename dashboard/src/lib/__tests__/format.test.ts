import { describe, expect, it } from 'vitest';
import { formatAxisCurrency, formatCurrency, formatSpend } from '../format';

describe('formatCurrency', () => {
  it('uses Lakh short form for compact headline values', () => {
    expect(formatCurrency(1760000)).toBe('₹17.6 L');
  });

  it('uses Lakh short form around a few lakhs', () => {
    expect(formatCurrency(282800)).toBe('₹2.8 L');
  });

  it('keeps precise 2-decimal formatting when compact is false', () => {
    expect(formatCurrency(3366.82, false)).toBe('₹3,366.82');
  });

  it('pads whole numbers to 2 decimals when compact is false', () => {
    expect(formatCurrency(1284, false)).toBe('₹1,284.00');
  });

  it('returns "--" for null', () => {
    expect(formatCurrency(null)).toBe('--');
  });

  it('returns "--" for NaN', () => {
    expect(formatCurrency(NaN)).toBe('--');
  });

  it('uses Crore short form above 1 Cr', () => {
    expect(formatCurrency(12345678)).toBe('₹1.23 Cr');
  });

  it('rounds compact lakh values', () => {
    expect(formatCurrency(1760000.6)).toBe('₹17.6 L');
  });
});

describe('formatSpend', () => {
  it('supports signed amounts', () => {
    expect(formatSpend(218020, true)).toBe('+₹2.2 L');
    expect(formatSpend(-50000)).toBe('₹50,000');
  });
});

describe('formatAxisCurrency', () => {
  it('uses Lakh ticks when the scale is in lakhs', () => {
    expect(formatAxisCurrency(1750000, 2000000)).toBe('₹17.5 L');
  });
});
