import { getDashboardJson } from './data';

export interface KvHashClient {
  hgetall(key: string): Promise<Record<string, string> | null>;
  hset(key: string, fields: Record<string, string>): Promise<number>;
}

export type HitlStatusMap = Record<string, 'confirmed' | 'dismissed'>;

const HASH_KEY = 'hitl-status';

function isKnownAlertId(alertId: string): boolean {
  const alerts = getDashboardJson().geoAnalysis?.hitl?.alerts ?? [];
  return alerts.some((a) => a.alertId === alertId);
}

export async function getAllStatuses(
  client: KvHashClient,
): Promise<HitlStatusMap | { error: string }> {
  try {
    const result = await client.hgetall(HASH_KEY);
    return (result ?? {}) as HitlStatusMap;
  } catch (err) {
    console.error('hitl-status KV read failed:', err);
    return { error: 'hitl status store unavailable' };
  }
}

export async function setStatus(
  client: KvHashClient,
  alertId: string,
  status: 'confirmed' | 'dismissed',
): Promise<{ ok: true } | { error: string }> {
  if (!isKnownAlertId(alertId)) {
    return { error: 'unknown alertId' };
  }
  try {
    await client.hset(HASH_KEY, { [alertId]: status });
    return { ok: true };
  } catch (err) {
    console.error('hitl-status KV write failed:', err);
    return { error: 'hitl status store unavailable' };
  }
}
