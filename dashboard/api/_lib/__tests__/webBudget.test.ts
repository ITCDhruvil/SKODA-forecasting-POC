import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkWebBudget, WEB_REQUESTS_PER_HOUR, _resetWebBudgetForTests, type KvCounterClient } from '../webBudget';

function fakeKv() {
  const counts = new Map<string, number>();
  const incr = vi.fn(async (key: string) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n;
  });
  const expire = vi.fn(async (_key: string, _seconds: number) => 1);
  const client: KvCounterClient = { incr, expire };
  return { client, incr, expire };
}

beforeEach(() => {
  _resetWebBudgetForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('checkWebBudget', () => {
  it('allows the first 10 requests in an hour and blocks the 11th', async () => {
    const { client } = fakeKv();
    for (let i = 0; i < WEB_REQUESTS_PER_HOUR; i++) expect((await checkWebBudget(client, '1.2.3.4', 0)).allowed).toBe(true);
    expect((await checkWebBudget(client, '1.2.3.4', 0)).allowed).toBe(false);
  });

  it('tracks IPs separately and resets in the next hour', async () => {
    const { client } = fakeKv();
    for (let i = 0; i < WEB_REQUESTS_PER_HOUR + 1; i++) await checkWebBudget(client, '1.2.3.4', 0);
    expect((await checkWebBudget(client, '5.6.7.8', 0)).allowed).toBe(true);
    expect((await checkWebBudget(client, '1.2.3.4', 3_600_000)).allowed).toBe(true);
  });

  it('sets an expiry on the first hit only, and never puts the raw IP in the key', async () => {
    const { client, incr, expire } = fakeKv();
    await checkWebBudget(client, '1.2.3.4', 0);
    await checkWebBudget(client, '1.2.3.4', 0);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(expire.mock.calls[0][1]).toBe(7200);
    expect(incr.mock.calls[0][0]).not.toContain('1.2.3.4');
  });

  it('falls back to an in-memory counter when KV fails, still enforcing the limit', async () => {
    const broken: KvCounterClient = {
      incr: vi.fn().mockRejectedValue(new Error('kv down')),
      expire: vi.fn(),
    };
    for (let i = 0; i < WEB_REQUESTS_PER_HOUR; i++) expect((await checkWebBudget(broken, '1.2.3.4', 0)).allowed).toBe(true);
    expect((await checkWebBudget(broken, '1.2.3.4', 0)).allowed).toBe(false);
  });
});
