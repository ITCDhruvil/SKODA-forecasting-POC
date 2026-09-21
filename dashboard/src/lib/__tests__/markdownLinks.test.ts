import { describe, it, expect } from 'vitest';
import { isDomainLabel } from '../markdownLinks';

describe('isDomainLabel', () => {
  it('accepts bare domain names', () => {
    expect(isDomainLabel('spglobal.com')).toBe(true);
    expect(isDomainLabel('www.reuters.com')).toBe(true);
    expect(isDomainLabel('business-standard.com')).toBe(true);
    expect(isDomainLabel('auto.economictimes.indiatimes.com')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isDomainLabel('S&P Global')).toBe(false);
    expect(isDomainLabel('https://x.com/a')).toBe(false);
    expect(isDomainLabel('Read more')).toBe(false);
    expect(isDomainLabel('a.b')).toBe(false);
    expect(isDomainLabel('12.5')).toBe(false);
    expect(isDomainLabel('')).toBe(false);
  });
});
