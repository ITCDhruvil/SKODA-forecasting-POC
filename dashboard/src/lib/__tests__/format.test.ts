import { describe, expect, it } from 'vitest';
import { formatCurrency } from '../format';

describe('formatCurrency', () => {
  it('renders compact/headline values with Indian digit grouping and no M/K suffix', () => {
    expect(formatCurrency(1760000)).toBe('₹17,60,000');
  });

  it('renders a lakh-level compact value correctly', () => {
    expect(formatCurrency(282800)).toBe('₹2,82,800');
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

  it('applies crore-level Indian digit grouping, not just lakh-level', () => {
    expect(formatCurrency(12345678)).toBe('₹1,23,45,678');
  });

  it('rounds compact values to the nearest whole rupee', () => {
    expect(formatCurrency(1760000.6)).toBe('₹17,60,001');
  });
});
