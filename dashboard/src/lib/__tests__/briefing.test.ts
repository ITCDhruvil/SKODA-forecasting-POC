import { describe, it, expect } from 'vitest';
import {
  BRIEFING_CACHE_KEY,
  isFresh,
  loadCachedBriefing,
  parseBriefingResponse,
  saveCachedBriefing,
  type Briefing,
  type BriefingItem,
} from '../briefing';

/** A raw (untyped) item payload as the server/JSON would send it — used for parse-time validation tests. */
function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headline: 'Steel tariffs raised',
    impact: 'cost_up',
    area: 'steel',
    why: 'Raises input cost for stamped parts.',
    outlet: 'Reuters',
    date: '2026-09-20',
    url: 'https://reuters.com/a',
    domain: 'reuters.com',
    ...overrides,
  };
}

function rawBriefing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: '2026-09-21',
    generatedAt: '2026-09-21T08:12:00.000Z',
    model: 'gpt-x',
    items: [rawItem()],
    ...overrides,
  };
}

/** A validated `BriefingItem`, for tests that exercise the cache (which is typed, not raw JSON). */
function validItem(overrides: Partial<BriefingItem> = {}): BriefingItem {
  return {
    headline: 'Steel tariffs raised',
    impact: 'cost_up',
    area: 'steel',
    why: 'Raises input cost for stamped parts.',
    outlet: 'Reuters',
    date: '2026-09-20',
    url: 'https://reuters.com/a',
    domain: 'reuters.com',
    ...overrides,
  };
}

function validBriefing(overrides: Partial<Briefing> = {}): Briefing {
  return {
    date: '2026-09-21',
    generatedAt: '2026-09-21T08:12:00.000Z',
    model: 'gpt-x',
    items: [validItem()],
    ...overrides,
  };
}

function fakeStorage(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  };
}

describe('parseBriefingResponse', () => {
  it('parses a ready response with valid items', () => {
    const result = parseBriefingResponse(200, { status: 'ready', briefing: rawBriefing() });
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.briefing.items).toHaveLength(1);
      expect(result.briefing.date).toBe('2026-09-21');
    }
  });

  it('drops items with a non-http(s) url and keeps the rest', () => {
    const b = rawBriefing({
      items: [rawItem(), rawItem({ url: 'javascript:alert(1)', headline: 'bad url' })],
    });
    const result = parseBriefingResponse(200, { status: 'ready', briefing: b });
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.briefing.items).toHaveLength(1);
      expect(result.briefing.items[0].headline).toBe('Steel tariffs raised');
    }
  });

  it('caps items at 5', () => {
    const b = rawBriefing({ items: Array.from({ length: 8 }, (_, i) => rawItem({ headline: `h${i}` })) });
    const result = parseBriefingResponse(200, { status: 'ready', briefing: b });
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') expect(result.briefing.items).toHaveLength(5);
  });

  it('errors when every item is malformed', () => {
    const b = rawBriefing({ items: [rawItem({ url: 'not a url' }), { headline: 5 }] });
    const result = parseBriefingResponse(200, { status: 'ready', briefing: b });
    expect(result.kind).toBe('error');
  });

  it('errors when the top-level briefing shape is missing required fields', () => {
    expect(parseBriefingResponse(200, { status: 'ready', briefing: { items: [rawItem()] } }).kind).toBe('error');
    expect(parseBriefingResponse(200, { status: 'ready', briefing: rawBriefing({ items: 'nope' }) }).kind).toBe(
      'error',
    );
  });

  it('parses disabled and pending', () => {
    expect(parseBriefingResponse(200, { status: 'disabled' }).kind).toBe('disabled');
    expect(parseBriefingResponse(202, { status: 'pending' }).kind).toBe('pending');
  });

  it('errors on a 502 or any unexpected body', () => {
    expect(parseBriefingResponse(502, { error: 'nope' }).kind).toBe('error');
    expect(parseBriefingResponse(200, null).kind).toBe('error');
    expect(parseBriefingResponse(200, 'nope').kind).toBe('error');
    expect(parseBriefingResponse(200, {}).kind).toBe('error');
    expect(parseBriefingResponse(200, { status: 'pending' }).kind).toBe('error'); // wrong status code for pending
  });
});

describe('loadCachedBriefing / saveCachedBriefing', () => {
  it('round-trips a briefing for the matching date', () => {
    const storage = fakeStorage();
    const b = validBriefing({ date: '2026-09-21' });
    saveCachedBriefing(storage, b);
    expect(loadCachedBriefing(storage, '2026-09-21')).toEqual(b);
  });

  it('returns null when the cached date does not match', () => {
    const storage = fakeStorage();
    saveCachedBriefing(storage, validBriefing({ date: '2026-09-20' }));
    expect(loadCachedBriefing(storage, '2026-09-21')).toBeNull();
  });

  it('returns null for missing, corrupt or blocked storage', () => {
    expect(loadCachedBriefing(fakeStorage(), '2026-09-21')).toBeNull();
    expect(loadCachedBriefing(fakeStorage({ [BRIEFING_CACHE_KEY]: 'not json{' }), '2026-09-21')).toBeNull();
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadCachedBriefing(blocked, '2026-09-21')).toBeNull();
  });

  it('saveCachedBriefing never throws when storage is blocked', () => {
    const blocked = {
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => saveCachedBriefing(blocked, validBriefing())).not.toThrow();
  });
});

// Built from local Date components (not UTC ISO strings) so the "today/yesterday" comparison inside isFresh,
// which is necessarily based on the browser's local date, does not depend on the test runner's time zone.
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('isFresh', () => {
  it('is fresh for today, generated recently', () => {
    const now = new Date(2026, 8, 21, 10, 0, 0);
    const generatedAt = new Date(now.getTime() - 2 * 3_600_000).toISOString();
    const b = validBriefing({ date: localDateKey(now), generatedAt });
    expect(isFresh(b, now)).toBe(true);
  });

  it('is fresh for yesterday (server day-boundary slack) when recently generated', () => {
    const now = new Date(2026, 8, 21, 1, 0, 0);
    const yesterday = new Date(now.getTime() - 24 * 3_600_000);
    const generatedAt = new Date(now.getTime() - 2 * 3_600_000).toISOString();
    const b = validBriefing({ date: localDateKey(yesterday), generatedAt });
    expect(isFresh(b, now)).toBe(true);
  });

  it('is stale once generatedAt is 20 hours old or more', () => {
    const now = new Date(2026, 8, 21, 10, 0, 0);
    const generatedAt = new Date(now.getTime() - 20 * 3_600_000 - 1_000).toISOString();
    const b = validBriefing({ date: localDateKey(now), generatedAt });
    expect(isFresh(b, now)).toBe(false);
  });

  it('is stale for a date older than yesterday', () => {
    const now = new Date(2026, 8, 21, 10, 0, 0);
    const twoDaysAgo = new Date(now.getTime() - 48 * 3_600_000);
    const generatedAt = new Date(now.getTime() - 2 * 3_600_000).toISOString();
    const b = validBriefing({ date: localDateKey(twoDaysAgo), generatedAt });
    expect(isFresh(b, now)).toBe(false);
  });
});
