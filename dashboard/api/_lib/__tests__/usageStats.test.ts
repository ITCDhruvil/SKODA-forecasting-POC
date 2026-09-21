import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LATEST_BRIEFING_KEY, USAGE_HASH_KEY, readUsage, recordUsage, type UsageKv } from '../usageStats';

function fakeKv(initial: { hash?: Record<string, unknown> | null; values?: Record<string, unknown> } = {}) {
  const hash: Record<string, unknown> = { ...(initial.hash ?? {}) };
  const values = initial.values ?? {};
  const kv = {
    hincrby: vi.fn(async (key: string, field: string, by: number) => {
      expect(key).toBe(USAGE_HASH_KEY);
      const next = Number(hash[field] ?? 0) + by;
      hash[field] = next;
      return next;
    }),
    hgetall: vi.fn(async () => (initial.hash === null ? null : { ...hash })),
    get: vi.fn(async (key: string) => values[key] ?? null),
  } satisfies UsageKv;
  return { kv, hash };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('recordUsage', () => {
  it('increments calls by one and tokens by the rounded amount', async () => {
    const { kv, hash } = fakeKv();
    await recordUsage(kv, 'web', 1234.6);
    await recordUsage(kv, 'web', 1000);
    await recordUsage(kv, 'data', 500);
    expect(hash).toEqual({ 'web:calls': 2, 'web:tokens': 2235, 'data:calls': 1, 'data:tokens': 500 });
    expect(kv.hincrby).toHaveBeenCalledWith(USAGE_HASH_KEY, 'web:calls', 1);
    expect(kv.hincrby).toHaveBeenCalledWith(USAGE_HASH_KEY, 'web:tokens', 1235);
  });

  it('ignores zero, negative and non-finite token counts', async () => {
    const { kv } = fakeKv();
    await recordUsage(kv, 'data', 0);
    await recordUsage(kv, 'data', -5);
    await recordUsage(kv, 'data', Number.NaN);
    await recordUsage(kv, 'data', Number.POSITIVE_INFINITY);
    expect(kv.hincrby).not.toHaveBeenCalled();
  });

  it('never throws when the store fails, and logs a short message without the error object', async () => {
    const kv: UsageKv = {
      hincrby: vi.fn().mockRejectedValue(new Error('redis down')),
      hgetall: vi.fn(),
      get: vi.fn(),
    };
    await expect(recordUsage(kv, 'action', 100)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe('readUsage', () => {
  const latest = { totalTokens: 9000, date: '2026-09-21', model: 'gpt-5.4-nano' };

  it('returns the briefing usage and rounded averages', async () => {
    const { kv } = fakeKv({
      hash: { 'web:calls': 3, 'web:tokens': 10000, 'data:calls': 2, 'data:tokens': 3001, 'action:calls': 1, 'action:tokens': 400 },
      values: { [LATEST_BRIEFING_KEY]: latest },
    });
    expect(await readUsage(kv)).toEqual({
      briefing: latest,
      webAnswer: { avgTokens: 3333, samples: 3 },
      dataAnswer: { avgTokens: 1501, samples: 2 },
    });
  });

  it('accepts numeric strings in the hash', async () => {
    const { kv } = fakeKv({ hash: { 'web:calls': '4', 'web:tokens': '8000', 'data:calls': '1', 'data:tokens': '700' } });
    const out = await readUsage(kv);
    expect(out.webAnswer).toEqual({ avgTokens: 2000, samples: 4 });
    expect(out.dataAnswer).toEqual({ avgTokens: 700, samples: 1 });
  });

  it('has null averages with no samples, a missing hash, or malformed values', async () => {
    expect(await readUsage(fakeKv({ hash: null }).kv)).toEqual({ briefing: null, webAnswer: null, dataAnswer: null });
    expect(await readUsage(fakeKv({ hash: {} }).kv)).toEqual({ briefing: null, webAnswer: null, dataAnswer: null });
    const malformed = fakeKv({ hash: { 'web:calls': 'abc', 'web:tokens': 100, 'data:calls': 0, 'data:tokens': 50 } });
    expect(await readUsage(malformed.kv)).toEqual({ briefing: null, webAnswer: null, dataAnswer: null });
  });

  it('has a null briefing when the latest key is missing or malformed', async () => {
    expect((await readUsage(fakeKv().kv)).briefing).toBeNull();
    const bads = ['text', 5, { totalTokens: 'x', date: '2026-09-21', model: 'm' }, { totalTokens: 10, date: 5, model: 'm' }, { totalTokens: -1, date: 'd', model: 'm' }];
    for (const bad of bads) {
      expect((await readUsage(fakeKv({ values: { [LATEST_BRIEFING_KEY]: bad } }).kv)).briefing).toBeNull();
    }
  });

  it('returns all null and does not throw when the store fails', async () => {
    const kv: UsageKv = {
      hincrby: vi.fn(),
      hgetall: vi.fn().mockRejectedValue(new Error('down')),
      get: vi.fn().mockRejectedValue(new Error('down')),
    };
    expect(await readUsage(kv)).toEqual({ briefing: null, webAnswer: null, dataAnswer: null });
  });

  it('still returns the averages when only the latest-briefing read fails', async () => {
    const kv: UsageKv = {
      hincrby: vi.fn(),
      hgetall: vi.fn().mockResolvedValue({ 'web:calls': 1, 'web:tokens': 100 }),
      get: vi.fn().mockRejectedValue(new Error('down')),
    };
    expect(await readUsage(kv)).toEqual({ briefing: null, webAnswer: { avgTokens: 100, samples: 1 }, dataAnswer: null });
  });
});
