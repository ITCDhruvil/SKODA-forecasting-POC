# Dashboard Chatbot — Phase 2: HITL Alert Confirm/Dismiss

Status: approved for implementation
Scope: Phase 2 of 3 (see [Phase 1 spec](2026-09-17-chatbot-phase1-design.md) for the original 3-phase split). Phase 3 (pipeline/evaluation re-run trigger) is not in scope here. FX/geo scenario mutation via chat was considered for Phase 2 and explicitly deferred to a later phase — scenarios are already fully answerable read-only via Phase 1's `getFxScenarios`/`getGeoScenarios` tools, so there was no new capability to build there yet.

## Goal

Let the chatbot confirm or dismiss a geopolitical HITL (human-in-the-loop) alert on the user's behalf, backed by real shared persistence. Today, `GeoHitlPanel.tsx`'s "Yes, show price impact" / "No, dismiss" buttons write to `localStorage` only — each browser has its own view, and nothing outside that one browser session ever sees the decision. Phase 2 replaces that with a single shared backend store, used by both the chat tools and the existing UI buttons, so a decision made either way is visible everywhere.

## Context

- `GeoAlert` (`dashboard/src/types.ts:465-482`) is the alert shape: `alertId`, `headline`, `category`, `severity`, `regionScope`, `narrative`, `sourceVerifications`, `prompt`, and a precomputed `impact: GeoAlertImpact` block (`shockPct`, `overallPriceChangePct`, `byCategory`, etc.) that's already computed offline by the Python pipeline — confirming an alert never triggers new computation, it only reveals numbers that already exist.
- Alerts live at `dashboard.json.geoAnalysis.hitl.alerts[]` (`GeoHitlBlock`, `types.ts:507-512`).
- `GeoHitlPanel.tsx` currently owns all status logic client-side: `STORAGE_KEY = 'geo-hitl-state-v1'`, a `Record<alertId, 'pending'|'confirmed'|'dismissed'>` in `localStorage`, no reset action (once confirmed/dismissed, stays that way until the user clears their browser storage).
- No database or KV store exists anywhere in this project. This is the first Phase 2 needs.

## Architecture

```
GeoHitlPanel.tsx (existing UI buttons)  ──┐
                                           ├──►  GET/POST /api/hitl-status  ──►  hitlStatus.ts  ──►  Vercel KV (Redis hash)
Chat ("confirm the Red Sea alert")  ──────┘                                        ▲
   POST /api/chat → tool-calling loop → confirmGeoAlert/dismissGeoAlert tools ─────┘ (direct in-process call, no internal HTTP)
```

Both the REST endpoint (used by the browser UI) and the chat tools (used by the LLM, running server-side in the same function) call the same `dashboard/api/_lib/hitlStatus.ts` module directly — no self-referential HTTP call from the chat tools to the REST endpoint.

## Storage

Vercel KV (Upstash Redis, via the `@vercel/kv` package). One Redis **hash** at key `hitl-status`: field = `alertId`, value = `'confirmed' | 'dismissed'`. Absence of a field means pending (matches today's default — no need to store a `'pending'` value explicitly). A hash gives atomic per-field writes (`HSET`) — no read-modify-write race between concurrent confirmers — and the whole state is one `HGETALL`.

**Requires provisioning:** the user attaches a KV store to the Vercel project and supplies `KV_REST_API_URL` / `KV_REST_API_TOKEN` (the `@vercel/kv` package's standard env vars, auto-injected by Vercel when the store is attached in production; for local dev, added to `dashboard/.env` the same way `OPENAI_API_KEY` was in Phase 1).

## Components

### 1. `dashboard/api/_lib/hitlStatus.ts`
- `getAllStatuses(): Promise<Record<string, 'confirmed' | 'dismissed'>>` — `kv.hgetall('hitl-status')`, returns `{}` if the key doesn't exist yet (no alerts ever touched).
- `setStatus(alertId: string, status: 'confirmed' | 'dismissed'): Promise<{ok: true} | {error: string}>` — validates `alertId` against the known set of alert IDs in `dashboard.json`'s `geoAnalysis.hitl.alerts` (reusing `getDashboardJson()` from Phase 1's `data.ts`) before writing; returns `{error: "unknown alertId"}` for anything not in that set rather than writing garbage into the store. On success, `kv.hset('hitl-status', { [alertId]: status })`, returns `{ok: true}`.
- On any KV client error (network, auth, etc.), catches and returns `{error: "hitl status store unavailable"}` — never throws past this module, matching Phase 1's error-handling posture (tools/endpoints get a structured error, not an exception).

### 2. Two new chat tools + one new read tool (added to Phase 1's `tools.ts`/`TOOL_DEFINITIONS`/`TOOL_HANDLERS`)
- `getGeoHitlAlerts()` — reads `dashboard.json.geoAnalysis.hitl.alerts`, joins in the current status from `getAllStatuses()`, returns a compact list: `{alertId, headline, category, severity, regionScope, status}[]`. Lets the model resolve a natural-language reference ("the Red Sea alert") to an `alertId` before calling confirm/dismiss, and lets it answer "what's still pending?" without a write.
- `confirmGeoAlert({alertId: string})` — calls `setStatus(alertId, 'confirmed')`. On success, also returns the alert's `impact` block (so the model can immediately tell the user the revealed numbers in the same turn, rather than needing a second tool call) by re-reading the matching alert from `dashboard.json`.
- `dismissGeoAlert({alertId: string})` — calls `setStatus(alertId, 'dismissed')`, returns `{ok: true}` only (no impact to reveal).
- These are the only mutating tools in the tool layer; every Phase 1 tool stays read-only. `TOOL_DEFINITIONS` gets two additional `type: 'function'` entries with `alertId` as a required string parameter each, plus one for `getGeoHitlAlerts` with no parameters.

### 3. `dashboard/api/hitl-status.ts` (new Vercel function)
- `GET` → `{ statuses: await getAllStatuses() }`, 200.
- `POST` with body `{ alertId: string, status: 'confirmed' | 'dismissed' }` → validates shape (400 if malformed or `status` not one of the two literals), calls `setStatus`, returns `{ok: true}` (200) or `{error}` (400 for unknown `alertId`, 502 for a store-unavailable error).
- Rate-limited with the same `checkRateLimit` from Phase 1's `rateLimit.ts`, keyed by client IP the same way `chat.ts` does — this is a public, unauthenticated write endpoint, same exposure profile as `/api/chat`.
- No `OPENAI_API_KEY` dependency — this endpoint works even if the chat feature's key isn't configured.

### 4. `GeoHitlPanel.tsx` migration
- Replace `loadStored()`/`saveStored()`/`localStorage` entirely with: on mount, `fetch('/api/hitl-status')` (GET) to populate initial state; `setStatus(alertId, status)` now does an optimistic local update followed by `fetch('/api/hitl-status', {method: 'POST', body: ...})`, reverting the optimistic update and surfacing an inline error if the request fails.
- `STORAGE_KEY` constant and the two helper functions are deleted.
- Everything else in the component (the `AlertCard` rendering, the pending/confirmed/dismissed branches, the impact display) is unchanged — only where the status comes from and goes to changes.

## Error Handling

- KV store unreachable: `hitlStatus.ts` never throws; callers (both the REST endpoint and the chat tools, via Phase 1's `chatLoop.ts` catch-all) get a structured `{error: "hitl status store unavailable"}` instead of a 500 or a leaked exception.
- Unknown `alertId`: `{error: "unknown alertId"}` from both the tool and the REST endpoint — guards against a model hallucinating an ID or the frontend sending stale data after `dashboard.json` regenerates with different alert IDs.
- Frontend fetch failure: `GeoHitlPanel.tsx` shows an inline "couldn't save your decision, try again" message rather than silently losing the click (this is a real behavior improvement over today's `localStorage` path, which never fails visibly since it's synchronous and local).

## Testing

- Unit tests for `hitlStatus.ts` against a fake KV client (dependency-injected, same pattern as Phase 1's `chatLoop.ts` tests using a fake `ChatClient`) — covering: known alertId succeeds, unknown alertId rejected, KV client throwing is caught and converted to a structured error, `getAllStatuses` returns `{}` when the hash doesn't exist yet.
- Unit tests for the three new tool functions (`getGeoHitlAlerts`, `confirmGeoAlert`, `dismissGeoAlert`) against the fake KV client + real `dashboard.json` fixture, matching Phase 1's `tools.test.ts` style.
- No automated test for `hitl-status.ts` itself (needs a live KV connection) — manual verification only, same posture as Phase 1's `chat.ts`.
- Manual end-to-end browser check: open the Geo Risk panel, confirm an alert via chat, refresh the page, confirm the alert now shows as confirmed in the UI (proving the shared-state round trip); dismiss a different alert via the UI button, ask chat "what alerts are pending", confirm the dismissed one is excluded.

## Out of Scope (this phase)

- FX/geo scenario mutation via chat (deferred — no new capability needed yet, Phase 1's read tools already cover it).
- Un-confirming / resetting an alert back to pending (matches today's UI, which has no reset button either).
- Real-time sync across open tabs/browsers (no websockets/SSE — a manual refresh picks up another user's change; acceptable for a POC with a single analyst).
- Pipeline/evaluation re-run trigger (Phase 3).
- Any auth beyond what already exists (none) — the new write endpoint is exposed the same way `/api/chat` already is.
