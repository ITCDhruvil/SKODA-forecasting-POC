import { describe, it, expect } from 'vitest';
import { ALLOWED_DOMAINS, dedupeSources, isAllowedHost, titleFromUrl, toWebSource } from '../webSources';

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

describe('titleFromUrl', () => {
  it('uses the last non-empty path segment, drops the extension, and turns - and _ into spaces', () => {
    expect(titleFromUrl('https://www.supplychaindive.com/news/truckload-capacity-shortage.html')).toBe('truckload capacity shortage');
    expect(titleFromUrl('https://www.spglobal.com/x/latest-news/houthi_threat--tanker-crunch/')).toBe('houthi threat tanker crunch');
  });

  it('drops a language suffix such as _en, before or without an extension', () => {
    expect(titleFromUrl('https://www.wto.org/english/news_e/tariff_update_en.htm')).toBe('tariff update');
    expect(titleFromUrl('https://europa.eu/docs/customs-duty-notice_en')).toBe('customs duty notice');
  });

  it('decodes percent-encoding, ignores the query string and the hash, and collapses whitespace', () => {
    expect(titleFromUrl('https://ft.com/content/steel%20tariffs%20%20rise?utm_source=openai#top')).toBe('steel tariffs rise');
  });

  it('falls back to the domain when the result is shorter than 4 characters or purely numeric', () => {
    expect(titleFromUrl('https://www.reuters.com/a/b')).toBe('reuters.com');
    expect(titleFromUrl('https://ft.com/content/12345678')).toBe('ft.com');
    expect(titleFromUrl('https://ft.com/content/2026-07-22')).toBe('ft.com');
    expect(titleFromUrl('https://www.reuters.com/')).toBe('reuters.com');
    expect(titleFromUrl('https://www.reuters.com')).toBe('reuters.com');
  });

  it('trims the result to 200 characters', () => {
    expect(titleFromUrl(`https://ft.com/${'a'.repeat(300)}`)).toBe('a'.repeat(200));
    // A cut that lands on a separator leaves no trailing space.
    const cut = titleFromUrl(`https://ft.com/${'word-'.repeat(100)}end`);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut).toBe(cut.trim());
  });

  it('returns an empty string for a url that cannot be parsed', () => {
    expect(titleFromUrl('not a url')).toBe('');
  });
});

describe('toWebSource title', () => {
  it('derives a title from the url only when the given title is missing or blank', () => {
    const url = 'https://www.ft.com/content/steel-tariffs-rise';
    expect(toWebSource(url, undefined, DOMAINS)?.title).toBe('steel tariffs rise');
    expect(toWebSource(url, '', DOMAINS)?.title).toBe('steel tariffs rise');
    expect(toWebSource(url, '   ', DOMAINS)?.title).toBe('steel tariffs rise');
    expect(toWebSource(url, 'Provider title', DOMAINS)?.title).toBe('Provider title');
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
