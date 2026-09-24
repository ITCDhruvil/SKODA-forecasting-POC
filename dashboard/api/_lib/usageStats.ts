import type { Mode } from './router';

/** Minimal view of the Vercel KV client used for usage counters (the real `kv` satisfies it). */
export interface UsageKv {
  hincrby(key: string, field: string, by: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  get(key: string): Promise<unknown>;
}

export const USAGE_HASH_KEY = 'radar-usage';
export const LATEST_BRIEFING_KEY = 'radar-briefing-latest';

export interface UsageStats {
  briefing: { totalTokens: number; date: string; model: string } | null;
  webAnswer: { avgTokens: number; samples: number } | null;
  dataAnswer: { avgTokens: number; samples: number } | null;
}

const EMPTY: UsageStats = { briefing: null, webAnswer: null, dataAnswer: null };

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown error';
}

/**
 * Adds one answer to the counters: `<kind>:calls` +1 and `<kind>:tokens` +tokens. Never throws (stats must not
 * break an answer); tokens that are zero, negative or not finite are ignored. Only numbers are stored, never text.
 */
export async function recordUsage(kv: UsageKv, kind: Mode, tokens: number): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  try {
    await kv.hincrby(USAGE_HASH_KEY, `${kind}:calls`, 1);
    await kv.hincrby(USAGE_HASH_KEY, `${kind}:tokens`, Math.round(tokens));
  } catch (err) {
    console.error('usage stats: could not record usage:', errorName(err));
  }
}

function toCount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function average(hash: Record<string, unknown>, kind: Mode): { avgTokens: number; samples: number } | null {
  const calls = toCount(hash[`${kind}:calls`]);
  const tokens = toCount(hash[`${kind}:tokens`]);
  if (calls === null || tokens === null || calls < 1) return null;
  return { avgTokens: Math.round(tokens / calls), samples: calls };
}

function parseLatest(value: unknown): UsageStats['briefing'] {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const totalTokens = v.totalTokens;
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens < 0) return null;
  if (typeof v.date !== 'string' || typeof v.model !== 'string') return null;
  return { totalTokens, date: v.date, model: v.model };
}

/** Body of `GET /api/usage`. Never throws: any store failure yields null for the part that could not be read. */
export async function readUsage(kv: UsageKv): Promise<UsageStats> {
  let briefing: UsageStats['briefing'] = null;
  let hash: Record<string, unknown> | null = null;
  try {
    briefing = parseLatest(await kv.get(LATEST_BRIEFING_KEY));
  } catch (err) {
    console.error('usage stats: could not read latest briefing usage:', errorName(err));
  }
  try {
    hash = await kv.hgetall(USAGE_HASH_KEY);
  } catch (err) {
    console.error('usage stats: could not read counters:', errorName(err));
  }
  if (!briefing && !hash) return { ...EMPTY };
  return {
    briefing,
    webAnswer: hash ? average(hash, 'web') : null,
    dataAnswer: hash ? average(hash, 'data') : null,
  };
}
