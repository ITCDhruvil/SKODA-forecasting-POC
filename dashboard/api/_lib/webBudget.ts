import { createHash } from 'node:crypto';

export interface KvCounterClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export const WEB_REQUESTS_PER_HOUR = 10;
const HOUR_MS = 3_600_000;
const MAX_FALLBACK_KEYS = 1000;

let fallback = new Map<string, number>();

function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

/**
 * Fixed hourly window per IP, stored in KV so it holds across serverless instances.
 * If KV is unavailable it falls back to a per-instance counter rather than failing open.
 */
export async function checkWebBudget(
  client: KvCounterClient,
  ip: string,
  now: number = Date.now(),
): Promise<{ allowed: boolean }> {
  const key = `web-budget:${hashIp(ip)}:${Math.floor(now / HOUR_MS)}`;
  try {
    const count = await client.incr(key);
    if (count === 1) await client.expire(key, 2 * 3600);
    return { allowed: count <= WEB_REQUESTS_PER_HOUR };
  } catch (err) {
    console.error('web budget KV failed, using in-memory fallback:', err);
    if (fallback.size > MAX_FALLBACK_KEYS) fallback = new Map();
    const count = (fallback.get(key) ?? 0) + 1;
    fallback.set(key, count);
    return { allowed: count <= WEB_REQUESTS_PER_HOUR };
  }
}

export function _resetWebBudgetForTests(): void {
  fallback = new Map();
}
