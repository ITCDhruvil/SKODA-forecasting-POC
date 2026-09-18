# Dashboard Chatbot Phase 2 (HITL Confirm/Dismiss) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the chatbot confirm or dismiss a geopolitical HITL alert, backed by a shared Vercel KV store — replacing `GeoHitlPanel.tsx`'s per-browser `localStorage` state so chat and the existing UI buttons read/write the same source of truth.

**Architecture:** A new `hitlStatus.ts` module wraps a Redis hash (`hitl-status`: `alertId -> 'confirmed' | 'dismissed'`) behind a small injectable `KvHashClient` interface. Three new chat tools (`getGeoHitlAlerts`, `confirmGeoAlert`, `dismissGeoAlert`) and a new REST endpoint (`/api/hitl-status`, used by the existing UI buttons) both call this module directly — no internal HTTP hop between them. `GeoHitlPanel.tsx` is migrated from `localStorage` to fetching/posting against the new endpoint.

**Tech Stack:** TypeScript, `@vercel/kv` (Upstash Redis), Vitest, reuses Phase 1's `data.ts`, `rateLimit.ts`, `chatLoop.ts`, `tools.ts` unchanged in shape.

**Spec:** [docs/superpowers/specs/2026-09-18-chatbot-phase2-design.md](../specs/2026-09-18-chatbot-phase2-design.md)

## Global Constraints

- Storage: Vercel KV (Upstash Redis), one hash key `hitl-status`, field = `alertId`, value = `'confirmed' | 'dismissed'` (absent = pending).
- `alertId` values are validated against `dashboard.json`'s `geoAnalysis.hitl.alerts` before any write — unknown IDs are rejected, never written.
- No un-confirm/reset action. No real-time cross-tab sync. No auth beyond the existing rate limiter.
- Every module in this plan follows Phase 1's error posture: internal errors are caught and converted to `{error: string}`, never thrown past the module boundary.
- Requires `KV_REST_API_URL` / `KV_REST_API_TOKEN` env vars (from the user's Vercel KV store) for any live test — same pattern as Phase 1's `OPENAI_API_KEY`.

---

## Task 1: KV client adapter and the HITL status data layer

**Files:**
- Create: `dashboard/api/_lib/kvClient.ts`
- Create: `dashboard/api/_lib/hitlStatus.ts`
- Test: `dashboard/api/_lib/__tests__/hitlStatus.test.ts`
- Modify: `dashboard/package.json`
- Modify: `dashboard/.env.example`

**Interfaces:**
- Consumes: `getDashboardJson()` from `dashboard/api/_lib/data.ts` (Phase 1, unchanged).
- Produces:
  - `interface KvHashClient { hgetall(key: string): Promise<Record<string, string> | null>; hset(key: string, fields: Record<string, string>): Promise<number> }`
  - `type HitlStatusMap = Record<string, 'confirmed' | 'dismissed'>`
  - `getAllStatuses(client: KvHashClient): Promise<HitlStatusMap | { error: string }>`
  - `setStatus(client: KvHashClient, alertId: string, status: 'confirmed' | 'dismissed'): Promise<{ ok: true } | { error: string }>`
  - `kv: KvHashClient` exported from `kvClient.ts` (the real Vercel KV client, structurally satisfying `KvHashClient`)

  Task 2 imports `getAllStatuses`, `setStatus`, `KvHashClient` from `./hitlStatus` and `kv` from `./kvClient`. Task 3 imports the same four names.

- [ ] **Step 1: Add the `@vercel/kv` dependency and env var documentation**

Edit `dashboard/package.json` — add to `dependencies`:

```json
"@vercel/kv": "^3.0.0",
```

Run: `cd dashboard && npm install`
Expected: installs cleanly.

Edit `dashboard/.env.example`, adding two lines:

```
KV_REST_API_URL=
KV_REST_API_TOKEN=
```

- [ ] **Step 2: Write the failing tests for the data layer**

```ts
// dashboard/api/_lib/__tests__/hitlStatus.test.ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd dashboard && npm test`
Expected: FAIL — `../hitlStatus` module not found.

- [ ] **Step 4: Implement the KV client adapter**

```ts
// dashboard/api/_lib/kvClient.ts
import { kv } from '@vercel/kv';
import type { KvHashClient } from './hitlStatus';

export { kv };
export type { KvHashClient };
```

- [ ] **Step 5: Implement the HITL status data layer**

```ts
// dashboard/api/_lib/hitlStatus.ts
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd dashboard && npm test`
Expected: PASS — all `hitlStatus.test.ts` tests green, all Phase 1 tests still green.

- [ ] **Step 7: Commit**

```bash
git add dashboard/package.json dashboard/package-lock.json dashboard/.env.example dashboard/api/_lib/kvClient.ts dashboard/api/_lib/hitlStatus.ts dashboard/api/_lib/__tests__/hitlStatus.test.ts
git commit -m "feat: add HITL status KV data layer"
```

---

## Task 2: Chat tools for listing, confirming, and dismissing HITL alerts

**Files:**
- Modify: `dashboard/api/_lib/tools.ts`
- Modify: `dashboard/api/_lib/__tests__/tools.test.ts`

**Interfaces:**
- Consumes: `getAllStatuses`, `setStatus`, `KvHashClient` from `./hitlStatus` (Task 1); `kv` from `./kvClient` (Task 1); `getDashboardJson` from `./data` (Phase 1, already imported in `tools.ts`).
- Produces:
  - `getGeoHitlAlerts(client: KvHashClient): Promise<{ alerts: {alertId, headline, category, severity, regionScope, status}[] } | { error: string }>`
  - `confirmGeoAlert(client: KvHashClient, args: { alertId: string }): Promise<{ ok: true; impact: unknown } | { error: string }>`
  - `dismissGeoAlert(client: KvHashClient, args: { alertId: string }): Promise<{ ok: true } | { error: string }>`
  - `TOOL_HANDLERS` gains three new entries: `getGeoHitlAlerts`, `confirmGeoAlert`, `dismissGeoAlert` (each bound to the real `kv` client, matching the existing `(args: any) => unknown` signature every other handler uses).
  - `TOOL_DEFINITIONS` gains three matching OpenAI tool schemas.

  Task 3's REST endpoint does NOT import these three functions — it calls `hitlStatus.ts` directly (same underlying data, different entry point, since the REST endpoint doesn't need the "resolve alertId from a headline" framing a chat tool needs).

- [ ] **Step 1: Write the failing tests**

Add to `dashboard/api/_lib/__tests__/tools.test.ts` (new imports at the top, new `describe` block anywhere in the file):

```ts
import type { KvHashClient } from '../hitlStatus';
import { getGeoHitlAlerts, confirmGeoAlert, dismissGeoAlert } from '../tools';

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
```

```ts
describe('getGeoHitlAlerts / confirmGeoAlert / dismissGeoAlert', () => {
  it('lists all alerts as pending when the store is empty', async () => {
    const client = fakeKvClient();
    const result = await getGeoHitlAlerts(client);
    if ('error' in result) throw new Error('expected success');
    expect(result.alerts.length).toBeGreaterThan(0);
    for (const a of result.alerts) expect(a.status).toBe('pending');
  });

  it('confirmGeoAlert persists the status and returns the impact block', async () => {
    const client = fakeKvClient();
    const listBefore = await getGeoHitlAlerts(client);
    if ('error' in listBefore) throw new Error('expected success');
    const alertId = listBefore.alerts[0].alertId;

    const result = await confirmGeoAlert(client, { alertId });
    if ('error' in result) throw new Error('expected success');
    expect(result.ok).toBe(true);
    expect(result.impact).toBeDefined();

    const listAfter = await getGeoHitlAlerts(client);
    if ('error' in listAfter) throw new Error('expected success');
    const updated = listAfter.alerts.find((a) => a.alertId === alertId);
    expect(updated?.status).toBe('confirmed');
  });

  it('dismissGeoAlert persists the status with no impact returned', async () => {
    const client = fakeKvClient();
    const listBefore = await getGeoHitlAlerts(client);
    if ('error' in listBefore) throw new Error('expected success');
    const alertId = listBefore.alerts[0].alertId;

    const result = await dismissGeoAlert(client, { alertId });
    expect(result).toEqual({ ok: true });

    const listAfter = await getGeoHitlAlerts(client);
    if ('error' in listAfter) throw new Error('expected success');
    const updated = listAfter.alerts.find((a) => a.alertId === alertId);
    expect(updated?.status).toBe('dismissed');
  });

  it('confirmGeoAlert returns a structured error for an unknown alertId', async () => {
    const client = fakeKvClient();
    const result = await confirmGeoAlert(client, { alertId: 'DOES-NOT-EXIST' });
    expect(result).toEqual({ error: 'unknown alertId' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && npm test`
Expected: FAIL — `getGeoHitlAlerts`/`confirmGeoAlert`/`dismissGeoAlert` not exported from `../tools`.

- [ ] **Step 3: Implement the three functions in tools.ts**

Add to `dashboard/api/_lib/tools.ts` (new imports at the top, functions anywhere among the other tool functions):

```ts
import { getAllStatuses, setStatus, type KvHashClient } from './hitlStatus';
import { kv } from './kvClient';
```

```ts
export async function getGeoHitlAlerts(client: KvHashClient) {
  const alerts = getDashboardJson().geoAnalysis?.hitl?.alerts ?? [];
  const statuses = await getAllStatuses(client);
  if ('error' in statuses) return statuses;
  return {
    alerts: alerts.map((a) => ({
      alertId: a.alertId,
      headline: a.headline,
      category: a.category,
      severity: a.severity,
      regionScope: a.regionScope,
      status: statuses[a.alertId] ?? 'pending',
    })),
  };
}

export async function confirmGeoAlert(client: KvHashClient, args: { alertId: string }) {
  const result = await setStatus(client, args.alertId, 'confirmed');
  if ('error' in result) return result;
  const alerts = getDashboardJson().geoAnalysis?.hitl?.alerts ?? [];
  const alert = alerts.find((a) => a.alertId === args.alertId);
  return { ok: true as const, impact: alert?.impact ?? null };
}

export async function dismissGeoAlert(client: KvHashClient, args: { alertId: string }) {
  return setStatus(client, args.alertId, 'dismissed');
}
```

- [ ] **Step 4: Wire the three functions into `TOOL_HANDLERS` and `TOOL_DEFINITIONS`**

Add to the `TOOL_HANDLERS` object in `dashboard/api/_lib/tools.ts`:

```ts
  getGeoHitlAlerts: () => getGeoHitlAlerts(kv),
  confirmGeoAlert: (args) => confirmGeoAlert(kv, args),
  dismissGeoAlert: (args) => dismissGeoAlert(kv, args),
```

Add to the `TOOL_DEFINITIONS` array:

```ts
  {
    type: 'function',
    function: {
      name: 'getGeoHitlAlerts',
      description: 'List geopolitical HITL alerts awaiting analyst review, with their current status (pending/confirmed/dismissed).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirmGeoAlert',
      description: 'Confirm a geopolitical alert, revealing its precomputed price impact. Use getGeoHitlAlerts first to find the right alertId.',
      parameters: {
        type: 'object',
        properties: { alertId: { type: 'string' } },
        required: ['alertId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dismissGeoAlert',
      description: 'Dismiss a geopolitical alert (no impact shown). Use getGeoHitlAlerts first to find the right alertId.',
      parameters: {
        type: 'object',
        properties: { alertId: { type: 'string' } },
        required: ['alertId'],
      },
    },
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd dashboard && npm test`
Expected: PASS — all new tests green, all Phase 1 tests still green.

- [ ] **Step 6: Commit**

```bash
git add dashboard/api/_lib/tools.ts dashboard/api/_lib/__tests__/tools.test.ts
git commit -m "feat: add HITL alert chat tools (list, confirm, dismiss)"
```

---

## Task 3: `/api/hitl-status` REST endpoint

**Files:**
- Create: `dashboard/api/hitl-status.ts`

**Interfaces:**
- Consumes: `getAllStatuses`, `setStatus` from `./_lib/hitlStatus` (Task 1); `kv` from `./_lib/kvClient` (Task 1); `checkRateLimit` from `./_lib/rateLimit` (Phase 1, unchanged).
- Produces: `GET /api/hitl-status` -> `{ statuses: HitlStatusMap }` (200) or `{ error }` (429/502). `POST /api/hitl-status` with `{ alertId, status }` -> `{ ok: true }` (200) or `{ error }` (400/429/502). Task 4's `GeoHitlPanel.tsx` calls this endpoint directly via `fetch`.

No automated test for this task — it needs a live KV connection, same posture as Phase 1's `chat.ts`. Verified manually in Task 5.

- [ ] **Step 1: Write the endpoint**

```ts
// dashboard/api/hitl-status.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkRateLimit } from './_lib/rateLimit';
import { getAllStatuses, setStatus } from './_lib/hitlStatus';
import { kv } from './_lib/kvClient';

function isValidStatus(s: unknown): s is 'confirmed' | 'dismissed' {
  return s === 'confirmed' || s === 'dismissed';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip =
    (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';

  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    res.status(429).json({ error: 'too many requests, try again in a few minutes' });
    return;
  }

  if (req.method === 'GET') {
    const statuses = await getAllStatuses(kv);
    if ('error' in statuses) {
      res.status(502).json(statuses);
      return;
    }
    res.status(200).json({ statuses });
    return;
  }

  if (req.method === 'POST') {
    const body = req.body as { alertId?: unknown; status?: unknown } | undefined;
    if (!body || typeof body.alertId !== 'string' || !isValidStatus(body.status)) {
      res.status(400).json({ error: 'invalid request body' });
      return;
    }
    const result = await setStatus(kv, body.alertId, body.status);
    if ('error' in result) {
      res.status(result.error === 'unknown alertId' ? 400 : 502).json(result);
      return;
    }
    res.status(200).json(result);
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
```

- [ ] **Step 2: Manual verification (no live KV needed for this step — confirms routing/validation only)**

Run: `cd dashboard && npm run dev`
Expected: `[vite]` on 5173, `[dev-api]` on 3001, no crash (the new endpoint file doesn't break the existing dev server wiring — `dev-api-server.mjs` only special-cases `/api/`-prefixed paths generically, this new file needs no changes there).

In another terminal: `curl -s -X POST http://localhost:5173/api/hitl-status -H "Content-Type: application/json" -d "{\"alertId\":\"x\",\"status\":\"bogus\"}"`
Expected: `{"error":"invalid request body"}` with HTTP 400 — confirms validation runs before any KV call is attempted (so this works even without `KV_REST_API_URL`/`KV_REST_API_TOKEN` set).

Stop both processes.

- [ ] **Step 3: Commit**

```bash
git add dashboard/api/hitl-status.ts
git commit -m "feat: add /api/hitl-status REST endpoint"
```

---

## Task 4: Migrate `GeoHitlPanel.tsx` off `localStorage`

**Files:**
- Modify: `dashboard/src/components/GeoHitlPanel.tsx`

**Interfaces:**
- Consumes: `GET`/`POST /api/hitl-status` (Task 3).
- Produces: no change to `GeoHitlPanel`'s own exported signature (`export function GeoHitlPanel({ hitl }: { hitl?: GeoHitlBlock })` stays identical) — only its internal state source changes, so nothing else in the codebase needs updating.

No automated test (UI, verified by hand in Task 5, same posture as Phase 1's `ChatWidget.tsx`).

- [ ] **Step 1: Read the current file, then replace the storage layer**

Read `dashboard/src/components/GeoHitlPanel.tsx` first. Replace lines 1-27 (the imports through `saveStored`) with:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { GeoHitlBlock, GeoAlert } from '../types';
import { formatSigned } from '../lib/format';

type AlertStatus = 'pending' | 'confirmed' | 'dismissed';

type StoredState = Record<string, AlertStatus>;
```

(This drops `STORAGE_KEY`, `loadStored`, and `saveStored` entirely — `useCallback`/`useMemo`/`useState` now also need `useEffect`, added to the import.)

- [ ] **Step 2: Replace the component's state management**

Inside `export function GeoHitlPanel({ hitl }: { hitl?: GeoHitlBlock })`, replace:

```tsx
  const [stored, setStored] = useState<StoredState>(loadStored);

  const setStatus = useCallback((alertId: string, status: AlertStatus) => {
    setStored((prev) => {
      const next = { ...prev, [alertId]: status };
      saveStored(next);
      return next;
    });
  }, []);
```

with:

```tsx
  const [stored, setStored] = useState<StoredState>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/hitl-status')
      .then((r) => r.json())
      .then((payload: { statuses?: StoredState }) => {
        if (payload.statuses) setStored(payload.statuses);
      })
      .catch(() => {
        /* leave everything pending if the initial load fails */
      });
  }, []);

  const setStatus = useCallback((alertId: string, status: AlertStatus) => {
    const previous = stored;
    setStored((prev) => ({ ...prev, [alertId]: status }));
    setSaveError(null);
    fetch('/api/hitl-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertId, status }),
    })
      .then((r) => {
        if (!r.ok) throw new Error('save failed');
      })
      .catch(() => {
        setStored(previous);
        setSaveError("Couldn't save your decision — try again.");
      });
  }, [stored]);
```

- [ ] **Step 3: Surface the save error in the UI**

Immediately after the closing `</div>` of the "Analyst review queue" card (the first `<div className="card px-5 py-4">...</div>` block in the returned JSX), add:

```tsx
      {saveError && (
        <div className="card border-red-200 bg-red-50 px-5 py-3 text-sm text-red-700">
          {saveError}
        </div>
      )}
```

- [ ] **Step 4: Manual verification**

Read the full updated file back to confirm it's coherent (no leftover references to `loadStored`/`saveStored`/`STORAGE_KEY`), then run:

Run: `cd dashboard && npx tsc -b tsconfig.api.json` — expected clean (this file isn't part of that project, but confirms the api-side typecheck still passes untouched).
Run: `cd dashboard && npx tsc -b` — expected only the 2 known pre-existing `GeoScenarioPanel.tsx` errors, nothing new from this file.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/GeoHitlPanel.tsx
git commit -m "feat: migrate GeoHitlPanel from localStorage to shared KV-backed status"
```

---

## Task 5: End-to-end manual verification

**Files:** none (verification only).

**Requires:** a real Vercel KV store attached with `KV_REST_API_URL`/`KV_REST_API_TOKEN` in `dashboard/.env.local` (or `.env`, whichever `dotenv/config` is picking up per the dev server setup), plus the `OPENAI_API_KEY` from Phase 1 (re-added if the worktree that had it was cleaned up). Ask the user for both before this task if not already present.

- [ ] **Step 1: Start the full local stack**

Run: `cd dashboard && npm run dev`
Expected: `[vite]` on 5173, `[dev-api]` on 3001, no errors.

- [ ] **Step 2: Confirm an alert via chat, verify it persists across a page reload**

Open `http://localhost:5173`, go to the Geo Risk panel, note a pending alert's headline. Open the chat widget, ask: "What geo alerts are pending?" — expect a list including that headline. Ask: "Confirm the [headline] alert." — expect confirmation plus a stated impact number.

Reload the page (full browser refresh, not HMR). Expected: that alert now shows as confirmed in the UI (impact visible) without you clicking anything — proves the KV round trip, not just in-memory chat state.

- [ ] **Step 3: Dismiss via the UI button, confirm chat sees it**

On a different pending alert, click "No, dismiss" in the UI. Ask chat: "What geo alerts are pending?" — expect that alert excluded from the list, confirming both interaction paths share state.

- [ ] **Step 4: Confirm rate limiting and validation still work**

Ask chat something unrelated to alerts (e.g. "what's the top mover?") to confirm Phase 1's tools still work unchanged alongside the new ones. Check the browser network tab / `[dev-api]` terminal for errors — expect none.

- [ ] **Step 5: Stop the dev processes**

No commit for this task — it's verification of Tasks 1-4's combined behavior. If any step fails, return to the relevant task, fix, and re-run this task's steps.
