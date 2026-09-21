import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../chat';
import { answer, type ChatResult } from '../_lib/orchestrator';
import { _resetRateLimitForTests } from '../_lib/rateLimit';

vi.mock('../_lib/orchestrator', () => ({ answer: vi.fn() }));
vi.mock('../_lib/openaiApi', () => ({ createOpenAIResponsesApi: vi.fn(() => ({ create: vi.fn() })) }));
const kvMock = vi.hoisted(() => ({ hincrby: vi.fn() }));
vi.mock('../_lib/kvClient', () => ({ kv: kvMock }));

const RESULT: ChatResult = { reply: 'hello', mode: 'data', usedWeb: false, sources: [] };
const answerMock = vi.mocked(answer);

interface Sent {
  status: number | undefined;
  body: unknown;
  headers: Record<string, string>;
  written: string[];
  ended: boolean;
  jsonCalled: boolean;
  flushed: boolean;
}

async function call(opts: { method?: string; body?: unknown; ip?: string } = {}): Promise<Sent> {
  const sent: Sent = { status: undefined, body: undefined, headers: {}, written: [], ended: false, jsonCalled: false, flushed: false };
  const req = {
    method: opts.method ?? 'POST',
    headers: {},
    socket: { remoteAddress: opts.ip ?? '9.9.9.9' },
    body: opts.body,
  } as unknown as VercelRequest;
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      sent.jsonCalled = true;
      return res;
    },
    setHeader(name: string, value: string) {
      sent.headers[name.toLowerCase()] = value;
      return res;
    },
    flushHeaders() {
      sent.flushed = true;
    },
    write(chunk: string) {
      sent.written.push(chunk);
      return true;
    },
    end() {
      sent.ended = true;
      return res;
    },
  } as unknown as VercelResponse;
  await handler(req, res);
  return sent;
}

const userMsg = (content = 'hi') => ({ role: 'user', content });
const valid = (extra: Record<string, unknown> = {}) => ({ messages: [userMsg()], ...extra });

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  _resetRateLimitForTests();
  answerMock.mockReset();
  kvMock.hincrby.mockReset();
  answerMock.mockResolvedValue(RESULT);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  vi.restoreAllMocks();
});

describe('POST /api/chat handler', () => {
  it('rejects non-POST methods with 405', async () => {
    const sent = await call({ method: 'GET' });
    expect(sent.status).toBe(405);
    expect(answerMock).not.toHaveBeenCalled();
  });

  it('rate limits the 21st request from the same ip within the window', async () => {
    for (let i = 0; i < 20; i++) expect((await call({ body: valid() })).status).toBe(200);
    const sent = await call({ body: valid() });
    expect(sent.status).toBe(429);
    expect(answerMock).toHaveBeenCalledTimes(20);
    // A different ip is unaffected.
    expect((await call({ body: valid(), ip: '8.8.8.8' })).status).toBe(200);
  });

  it('rejects an empty messages array with 400', async () => {
    const sent = await call({ body: { messages: [] } });
    expect(sent).toMatchObject({ status: 400, body: { error: 'invalid request body' } });
    expect(answerMock).not.toHaveBeenCalled();
  });

  it('rejects a conversation whose last message is from the assistant with 400', async () => {
    const sent = await call({ body: { messages: [userMsg(), { role: 'assistant', content: 'yo' }] } });
    expect(sent).toMatchObject({ status: 400, body: { error: 'invalid request body' } });
    expect(answerMock).not.toHaveBeenCalled();
  });

  it('rejects a missing body, non-array messages and malformed messages with 400', async () => {
    expect((await call({ body: undefined })).status).toBe(400);
    expect((await call({ body: { messages: 'hi' } })).status).toBe(400);
    expect((await call({ body: { messages: [{ role: 'system', content: 'x' }] } })).status).toBe(400);
    expect((await call({ body: { messages: [{ role: 'user', content: 5 }] } })).status).toBe(400);
    expect(answerMock).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean webEnabled with 400', async () => {
    const sent = await call({ body: valid({ webEnabled: 'yes' }) });
    expect(sent).toMatchObject({ status: 400, body: { error: 'invalid request body' } });
    expect(answerMock).not.toHaveBeenCalled();
  });

  it('defaults webEnabled to true and passes an explicit false through', async () => {
    await call({ body: valid() });
    expect(answerMock.mock.calls[0][0].webEnabled).toBe(true);
    await call({ body: valid({ webEnabled: false }) });
    expect(answerMock.mock.calls[1][0].webEnabled).toBe(false);
  });

  it('forwards only role and content of each message', async () => {
    const messages = [
      { role: 'user', content: 'q1', id: 'm1' },
      { role: 'assistant', content: 'a1', sources: [{ url: 'https://x.com' }], usedWeb: true, id: 'm2' },
      { role: 'user', content: 'q2', extra: 1 },
    ];
    await call({ body: { messages } });
    expect(answerMock.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(answerMock.mock.calls[0][0].ip).toBe('9.9.9.9');
  });

  it('rejects more than 30 messages with 400 too many messages', async () => {
    const messages = Array.from({ length: 31 }, (_, i) => (i % 2 === 0 ? userMsg() : { role: 'assistant', content: 'a' }));
    const sent = await call({ body: { messages } });
    expect(sent).toMatchObject({ status: 400, body: { error: 'too many messages' } });
  });

  it('accepts exactly 30 messages ending with a user message', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? { role: 'assistant', content: 'a' } : userMsg()));
    expect((await call({ body: { messages } })).status).toBe(200);
  });

  it('rejects a message over 4000 characters with 400 message too long', async () => {
    const sent = await call({ body: { messages: [userMsg('x'.repeat(4001))] } });
    expect(sent).toMatchObject({ status: 400, body: { error: 'message too long' } });
    expect((await call({ body: { messages: [userMsg('x'.repeat(4000))] } })).status).toBe(200);
  });

  it('returns 502 when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    const sent = await call({ body: valid() });
    expect(sent.status).toBe(502);
    expect(answerMock).not.toHaveBeenCalled();
  });

  it('returns 502 chat temporarily unavailable when answer rejects', async () => {
    answerMock.mockRejectedValue(new Error('boom'));
    const sent = await call({ body: valid() });
    expect(sent).toMatchObject({ status: 502, body: { error: 'chat temporarily unavailable' } });
  });

  it('returns 200 with the ChatResult on success', async () => {
    const sent = await call({ body: valid() });
    expect(sent).toMatchObject({ status: 200, body: RESULT });
  });

  it('a plain request does not stream: no NDJSON headers, no writes, and no onMode wired', async () => {
    const sent = await call({ body: valid() });
    expect(sent.headers['content-type']).toBeUndefined();
    expect(sent.written).toEqual([]);
    expect(sent.ended).toBe(false);
    expect(answerMock.mock.calls[0][1].onMode).toBeUndefined();
    const explicitFalse = await call({ body: valid({ stream: false }) });
    expect(explicitFalse).toMatchObject({ status: 200, body: RESULT, written: [] });
  });

  it('wires recordUsage to the usage counters in the KV store', async () => {
    kvMock.hincrby.mockResolvedValue(1);
    await call({ body: valid() });
    const record = answerMock.mock.calls[0][1].recordUsage;
    expect(typeof record).toBe('function');
    await record?.('web', 1234);
    expect(kvMock.hincrby.mock.calls).toEqual([
      ['radar-usage', 'web:calls', 1],
      ['radar-usage', 'web:tokens', 1234],
    ]);
  });

  it('a failing usage store does not make the recordUsage dependency throw', async () => {
    kvMock.hincrby.mockRejectedValue(new Error('kv down'));
    await call({ body: valid() });
    await expect(answerMock.mock.calls[0][1].recordUsage?.('data', 10)).resolves.toBeUndefined();
  });

  describe('stream: true', () => {
    const lines = (sent: Sent) => sent.written.map((w) => JSON.parse(w));

    it('rejects a non-boolean stream with 400 invalid request body', async () => {
      const sent = await call({ body: valid({ stream: 'yes' }) });
      expect(sent).toMatchObject({ status: 400, body: { error: 'invalid request body' }, written: [] });
      expect(answerMock).not.toHaveBeenCalled();
    });

    it('streams a mode line then the result line as NDJSON, then ends', async () => {
      answerMock.mockImplementation(async (_req, deps) => {
        deps.onMode?.('web');
        return RESULT;
      });
      const sent = await call({ body: valid({ stream: true }) });

      expect(sent.status).toBe(200);
      expect(sent.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
      expect(sent.headers['cache-control']).toBe('no-cache, no-transform');
      expect(sent.flushed).toBe(true);
      expect(sent.written.every((w) => w.endsWith('\n') && !w.slice(0, -1).includes('\n'))).toBe(true);
      expect(lines(sent)).toEqual([{ type: 'mode', mode: 'web' }, { type: 'result', ...RESULT }]);
      expect(sent.ended).toBe(true);
      expect(sent.jsonCalled).toBe(false);
    });

    it('forwards a second mode line when the orchestrator falls back', async () => {
      answerMock.mockImplementation(async (_req, deps) => {
        deps.onMode?.('web');
        deps.onMode?.('data');
        return RESULT;
      });
      const sent = await call({ body: valid({ stream: true }) });
      expect(lines(sent).map((l) => l.type)).toEqual(['mode', 'mode', 'result']);
      expect(lines(sent)[1]).toEqual({ type: 'mode', mode: 'data' });
    });

    it('writes a single error line and ends when answer rejects, without a JSON 502 afterwards', async () => {
      answerMock.mockRejectedValue(new Error('boom'));
      const sent = await call({ body: valid({ stream: true }) });

      expect(sent.status).toBe(200);
      expect(lines(sent)).toEqual([{ type: 'error', error: 'chat temporarily unavailable' }]);
      expect(sent.ended).toBe(true);
      expect(sent.jsonCalled).toBe(false);
    });

    it('keeps validation errors as plain JSON before streaming starts', async () => {
      const sent = await call({ body: { messages: [], stream: true } });
      expect(sent).toMatchObject({ status: 400, body: { error: 'invalid request body' }, written: [], ended: false });
      expect(sent.headers['content-type']).toBeUndefined();
    });

    it('keeps the missing-key 502 as plain JSON before streaming starts', async () => {
      delete process.env.OPENAI_API_KEY;
      const sent = await call({ body: valid({ stream: true }) });
      expect(sent).toMatchObject({ status: 502, body: { error: 'chat temporarily unavailable' }, written: [], ended: false });
    });
  });
});
