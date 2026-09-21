import { describe, it, expect } from 'vitest';
import { ALLOWED_DOMAINS, dedupeSources, isAllowedHost, toWebSource } from '../webSources';

const DOMAINS = ['reuters.com', 'ft.com'];

describe('isAllowedHost', () => {
  it('matches the domain and its subdomains', () => {
    expect(isAllowedHost('reuters.com', DOMAINS)).toBe(true);
    expect(isAllowedHost('www.reuters.com', DOMAINS)).toBe(true);
    expect(isAllowedHost('uk.reuters.com', DOMAINS)).toBe(true);
  });

  it('rejects look-alike hosts', () => {
    expect(isAllowedHost('evilreuters.com', DOMAINS)).toBe(false);
    expect(isAllowedHost('reuters.com.evil.io', DOMAINS)).toBe(false);
    expect(isAllowedHost('example.com', DOMAINS)).toBe(false);
  });
});

describe('toWebSource', () => {
  it('normalises an allowed url: strips utm_source and hash, derives the domain', () => {
    expect(toWebSource('https://www.reuters.com/a/b?x=1&utm_source=openai#frag', 'Steel jumps', DOMAINS)).toEqual({
      title: 'Steel jumps',
      url: 'https://www.reuters.com/a/b?x=1',
      domain: 'reuters.com',
    });
  });

  it('falls back to the domain when the title is missing and trims long titles', () => {
    expect(toWebSource('https://ft.com/x', undefined, DOMAINS)?.title).toBe('ft.com');
    expect(toWebSource('https://ft.com/x', 'a'.repeat(500), DOMAINS)?.title).toHaveLength(200);
  });

  it('rejects non-http(s) schemes, malformed urls and hosts outside the allow-list', () => {
    expect(toWebSource('javascript:alert(1)', 'x', DOMAINS)).toBeNull();
    expect(toWebSource('ftp://reuters.com/a', 'x', DOMAINS)).toBeNull();
    expect(toWebSource('not a url', 'x', DOMAINS)).toBeNull();
    expect(toWebSource('https://evil.example.com/a', 'x', DOMAINS)).toBeNull();
  });
});

describe('dedupeSources', () => {
  it('keeps the first occurrence of each url', () => {
    const a = { title: 'A', url: 'https://ft.com/1', domain: 'ft.com' };
    const b = { title: 'B', url: 'https://ft.com/2', domain: 'ft.com' };
    expect(dedupeSources([a, b, { ...a, title: 'A again' }])).toEqual([a, b]);
  });
});

describe('ALLOWED_DOMAINS', () => {
  it('has no scheme, path or duplicates', () => {
    for (const d of ALLOWED_DOMAINS) expect(d).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
    expect(new Set(ALLOWED_DOMAINS).size).toBe(ALLOWED_DOMAINS.length);
  });
});
