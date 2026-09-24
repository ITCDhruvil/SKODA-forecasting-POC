import { describe, it, expect } from 'vitest';
import { getDashboardJson } from '../data';
import { getAllStatuses, setStatus, type KvHashClient } from '../hitlStatus';

function fakeKvClient(initial: Record<string, string> = {}): KvHashClient {
  const store: Record<string, string> = { ...initial };
  return {
    hgetall: async (key: string) => (key === 'hitl-status' ? { ...store } : null),
    hset: async (key: string, fields: Record<string, string>) => {
      if (key !== 'hitl-status') throw new Error(`unexpected key: ${key}`);
      Object.assign(store, fields);
      return Object.keys(fields).length;
    },
  };
}

function throwingKvClient(): KvHashClient {
  return {
    hgetall: async () => {
      throw new Error('connection refused');
    },
    hset: async () => {
      throw new Error('connection refused');
    },
  };
}

function firstKnownAlertId(): string {
  const alerts = getDashboardJson().geoAnalysis?.hitl?.alerts ?? [];
  expect(alerts.length).toBeGreaterThan(0);
  return alerts[0].alertId;
}

describe('getAllStatuses', () => {
  it('returns an empty map when the hash has never been written', async () => {
    const result = await getAllStatuses(fakeKvClient());
    expect(result).toEqual({});
  });

  it('returns the stored status map', async () => {
    const alertId = firstKnownAlertId();
    const client = fakeKvClient({ [alertId]: 'confirmed' });
    const result = await getAllStatuses(client);
    expect(result).toEqual({ [alertId]: 'confirmed' });
  });

  it('returns a structured error when the client throws', async () => {
    const result = await getAllStatuses(throwingKvClient());
    expect(result).toEqual({ error: 'hitl status store unavailable' });
  });
});

describe('setStatus', () => {
  it('writes a status for a known alertId', async () => {
    const alertId = firstKnownAlertId();
    const client = fakeKvClient();
    const result = await setStatus(client, alertId, 'confirmed');
    expect(result).toEqual({ ok: true });
    expect(await getAllStatuses(client)).toEqual({ [alertId]: 'confirmed' });
  });

  it('rejects an unknown alertId without writing', async () => {
    const client = fakeKvClient();
    const result = await setStatus(client, 'DOES-NOT-EXIST', 'dismissed');
    expect(result).toEqual({ error: 'unknown alertId' });
    expect(await getAllStatuses(client)).toEqual({});
  });

  it('returns a structured error when the client throws', async () => {
    const alertId = firstKnownAlertId();
    const result = await setStatus(throwingKvClient(), alertId, 'confirmed');
    expect(result).toEqual({ error: 'hitl status store unavailable' });
  });
});
