import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../usage';
import { readUsage, type UsageStats } from '../_lib/usageStats';
import { _resetRateLimitForTests } from '../_lib/rateLimit';

vi.mock('../_lib/usageStats', () => ({ readUsage: vi.fn() }));
vi.mock('../_lib/kvClient', () => ({ kv: {} }));

const readMock = vi.mocked(readUsage);

const STATS: UsageStats = {
  briefing: { totalTokens: 9700, date: '2026-09-21', model: 'gpt-5.4-nano' },
  webAnswer: { avgTokens: 5000, samples: 3 },
  dataAnswer: { avgTokens: 1500, samples: 12 },
};
const ALL_NULL = { briefing: null, webAnswer: null, dataAnswer: null };

async function call(opts: { method?: string; ip?: string } = {}) {
  const sent: { status?: number; body?: unknown } = {};
  const req = {
    method: opts.method ?? 'GET',
    headers: {},
    socket: { remoteAddress: opts.ip ?? '9.9.9.9' },
  } as unknown as VercelRequest;
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    },
  } as unknown as VercelResponse;
  await handler(req, res);
  return sent;
}

beforeEach(() => {
  _resetRateLimitForTests();
  readMock.mockReset();
  readMock.mockResolvedValue(STATS);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/usage handler', () => {
  it('rejects non-GET methods with 405', async () => {
    expect(await call({ method: 'POST' })).toEqual({ status: 405, body: { error: 'method not allowed' } });
    expect(readMock).not.toHaveBeenCalled();
  });

  it('rate limits the 21st request from the same ip', async () => {
    for (let i = 0; i < 20; i++) expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });

  it('returns 200 with the stats', async () => {
    expect(await call()).toEqual({ status: 200, body: STATS });
  });

  it('returns 200 with all null when the stats are empty', async () => {
    readMock.mockResolvedValue(ALL_NULL);
    expect(await call()).toEqual({ status: 200, body: ALL_NULL });
  });

  it('returns 200 with all null, never a 5xx, when reading throws', async () => {
    readMock.mockRejectedValue(new Error('kv down'));
    expect(await call()).toEqual({ status: 200, body: ALL_NULL });
  });
});
