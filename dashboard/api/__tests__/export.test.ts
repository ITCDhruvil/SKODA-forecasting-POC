// dashboard/api/__tests__/export.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../export';

// The endpoint's docx path calls composeReport, which (absent this mock) would construct a real
// OpenAI client and make a live outbound HTTPS request on every test run. That is slow, flaky and
// network-dependent, so it is mocked here. Task 4 already covers composeReport's real fallback
// behaviour thoroughly with a fake API; nothing is lost by mocking it in this file.
vi.mock('../_lib/reportCompose', () => ({
  composeReport: vi.fn().mockResolvedValue({ title: 'Mocked report', sections: [{ heading: 'H', paragraphs: ['p'] }] }),
}));

function res() {
  const r: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    sent: undefined as Buffer | undefined,
  };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; return r; };
  r.send = (b: Buffer) => { r.sent = b; return r; };
  r.end = () => r;
  return r as VercelResponse & typeof r;
}

function req(body: unknown, method = 'POST') {
  return { method, body, headers: {}, socket: { remoteAddress: '1.2.3.4' } } as unknown as VercelRequest;
}

const XLSX_OFFER = {
  format: 'xlsx' as const,
  label: 'Parts flagged for procurement review',
  dataRef: { export: 'alerts', params: {} },
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
});

describe('POST /api/export', () => {
  it('rejects a non-POST method', async () => {
    const r = res();
    await handler(req(null, 'GET'), r);
    expect(r.statusCode).toBe(405);
  });

  it('rejects a malformed body', async () => {
    const r = res();
    await handler(req({ nope: true }), r);
    expect(r.statusCode).toBe(400);
  });

  it('rejects an unknown export id even when the client insists', async () => {
    const r = res();
    await handler(req({ format: 'xlsx', offer: { ...XLSX_OFFER, dataRef: { export: 'rm -rf', params: {} } } }), r);
    expect(r.statusCode).toBe(400);
  });

  it('rejects xlsx with a null dataRef', async () => {
    const r = res();
    await handler(req({ format: 'xlsx', offer: { ...XLSX_OFFER, dataRef: null } }), r);
    expect(r.statusCode).toBe(400);
  });

  it('rejects docx with no messages', async () => {
    const r = res();
    await handler(req({ format: 'docx', offer: { ...XLSX_OFFER, format: 'docx' } }), r);
    expect(r.statusCode).toBe(400);
  });

  it('builds a workbook and sends it as an attachment', async () => {
    const r = res();
    await handler(req({ format: 'xlsx', offer: XLSX_OFFER }), r);

    expect(r.statusCode).toBe(200);
    expect(r.headers['Content-Type']).toContain('spreadsheetml');
    expect(r.headers['Content-Disposition']).toMatch(/^attachment; filename="[a-z0-9-]+\.xlsx"$/);
    expect(r.sent).toBeInstanceOf(Buffer);
    expect((r.sent as Buffer).length).toBeGreaterThan(0);
  });

  it('ignores a client-supplied filename', async () => {
    const r = res();
    await handler(req({ format: 'xlsx', offer: XLSX_OFFER, filename: '../../etc/passwd' }), r);
    expect(r.headers['Content-Disposition']).not.toContain('passwd');
  });

  it('honours the format field over the offer format', async () => {
    const r = res();
    await handler(
      req({
        format: 'docx',
        offer: XLSX_OFFER,
        messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Three alerts are open.' }],
      }),
      r,
    );
    expect(r.statusCode).toBe(200);
    expect(r.headers['Content-Type']).toContain('wordprocessingml');
    expect(r.headers['Content-Disposition']).toContain('.docx');
  });

  it('returns 502 when the API key is missing on a docx request', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const r = res();
    await handler(
      req({ format: 'docx', offer: XLSX_OFFER, messages: [{ role: 'user', content: 'hi' }] }),
      r,
    );
    expect(r.statusCode).toBe(502);
  });
});
