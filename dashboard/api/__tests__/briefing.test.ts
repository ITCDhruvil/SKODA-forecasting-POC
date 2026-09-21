import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../briefing';
import { getOrCreateBriefing, type Briefing } from '../_lib/briefing';
import { _resetRateLimitForTests } from '../_lib/rateLimit';

vi.mock('../_lib/briefing', () => ({ getOrCreateBriefing: vi.fn() }));
vi.mock('../_lib/openaiApi', () => ({ createOpenAIResponsesApi: vi.fn(() => ({ create: vi.fn() })) }));
vi.mock('../_lib/kvClient', () => ({ kv: {} }));

const getMock = vi.mocked(getOrCreateBriefing);

const BRIEFING: Briefing = {
  date: '2026-09-21',
  generatedAt: '2026-09-21T06:00:00.000Z',
  model: 'gpt-5.4-nano',
  items: [
    {
      headline: 'Steel prices rise',
      impact: 'cost_up',
      area: 'steel',
      why: 'Raises body part costs.',
      outlet: 'Reuters',
      date: '2026-09-20',
      url: 'https://www.reuters.com/a',
      domain: 'reuters.com',
    },
  ],
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, searches: 1 },
};

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

const saved: Record<string, string | undefined> = {};
const KEYS = ['OPENAI_API_KEY', 'BRIEFING_TIMEZONE', 'WEB_SEARCH_ENABLED', 'OPENAI_WEB_MODEL'];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.OPENAI_API_KEY = 'test-key';
  delete process.env.BRIEFING_TIMEZONE;
  _resetRateLimitForTests();
  getMock.mockReset();
  getMock.mockResolvedValue({ status: 'ready', briefing: BRIEFING });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('GET /api/briefing handler', () => {
  it('rejects non-GET methods with 405', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect(await call({ method })).toEqual({ status: 405, body: { error: 'method not allowed' } });
    }
    expect(getMock).not.toHaveBeenCalled();
  });

  it('rate limits the 21st request from the same ip', async () => {
    for (let i = 0; i < 20; i++) expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
    expect((await call({ ip: '8.8.8.8' })).status).toBe(200);
  });

  it('maps ready to 200 with the briefing', async () => {
    expect(await call()).toEqual({ status: 200, body: { status: 'ready', briefing: BRIEFING } });
  });

  it('maps disabled to 200', async () => {
    getMock.mockResolvedValue({ status: 'disabled' });
    expect(await call()).toEqual({ status: 200, body: { status: 'disabled' } });
  });

  it('maps pending to 202', async () => {
    getMock.mockResolvedValue({ status: 'pending' });
    expect(await call()).toEqual({ status: 202, body: { status: 'pending' } });
  });

  it('maps failed to a sanitized 502', async () => {
    getMock.mockResolvedValue({ status: 'failed' });
    expect(await call()).toEqual({ status: 502, body: { error: 'briefing temporarily unavailable' } });
  });

  it('answers a sanitized 502 when the briefing code throws', async () => {
    getMock.mockRejectedValue(new Error('secret detail'));
    expect(await call()).toEqual({ status: 502, body: { error: 'briefing temporarily unavailable' } });
  });

  it('is disabled without calling the briefing code when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await call()).toEqual({ status: 200, body: { status: 'disabled' } });
    expect(getMock).not.toHaveBeenCalled();
  });

  it('passes the config, a clock and the time zone (default Asia/Kolkata, BRIEFING_TIMEZONE overrides)', async () => {
    process.env.WEB_SEARCH_ENABLED = 'true';
    process.env.OPENAI_WEB_MODEL = 'web-model';
    await call();
    const deps = getMock.mock.calls[0][0];
    expect(deps.timeZone).toBe('Asia/Kolkata');
    expect(deps.config.webSearchEnabled).toBe(true);
    expect(deps.config.webModel).toBe('web-model');
    expect(deps.now()).toBeInstanceOf(Date);

    process.env.BRIEFING_TIMEZONE = 'Europe/Prague';
    await call();
    expect(getMock.mock.calls[1][0].timeZone).toBe('Europe/Prague');
  });
});
