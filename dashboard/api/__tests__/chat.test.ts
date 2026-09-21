import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../chat';
import { answer, type ChatResult } from '../_lib/orchestrator';
import { _resetRateLimitForTests } from '../_lib/rateLimit';

vi.mock('../_lib/orchestrator', () => ({ answer: vi.fn() }));
vi.mock('../_lib/openaiApi', () => ({ createOpenAIResponsesApi: vi.fn(() => ({ create: vi.fn() })) }));
vi.mock('../_lib/kvClient', () => ({ kv: {} }));

const RESULT: ChatResult = { reply: 'hello', mode: 'data', usedWeb: false, sources: [] };
const answerMock = vi.mocked(answer);

interface Sent {
  status: number | undefined;
  body: unknown;
}

async function call(opts: { method?: string; body?: unknown; ip?: string } = {}): Promise<Sent> {
  const sent: Sent = { status: undefined, body: undefined };
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
    expect(sent).toEqual({ status: 400, body: { error: 'invalid request body' } });
    expect(answerMock).not.toHaveBeenCalled();
  });

  it('rejects a conversation whose last message is from the assistant with 400', async () => {
    const sent = await call({ body: { messages: [userMsg(), { role: 'assistant', content: 'yo' }] } });
    expect(sent).toEqual({ status: 400, body: { error: 'invalid request body' } });
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
    expect(sent).toEqual({ status: 400, body: { error: 'invalid request body' } });
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
    expect(sent).toEqual({ status: 400, body: { error: 'too many messages' } });
  });

  it('accepts exactly 30 messages ending with a user message', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? { role: 'assistant', content: 'a' } : userMsg()));
    expect((await call({ body: { messages } })).status).toBe(200);
  });

  it('rejects a message over 4000 characters with 400 message too long', async () => {
    const sent = await call({ body: { messages: [userMsg('x'.repeat(4001))] } });
    expect(sent).toEqual({ status: 400, body: { error: 'message too long' } });
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
    expect(sent).toEqual({ status: 502, body: { error: 'chat temporarily unavailable' } });
  });

  it('returns 200 with the ChatResult on success', async () => {
    const sent = await call({ body: valid() });
    expect(sent).toEqual({ status: 200, body: RESULT });
  });
});
