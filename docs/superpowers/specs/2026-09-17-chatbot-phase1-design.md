# Dashboard Chatbot — Phase 1: Read-Only Q&A

Status: approved for implementation
Scope: Phase 1 of 3. Phase 2 = HITL confirm/dismiss + scenario apply via chat. Phase 3 = pipeline/evaluation re-run trigger. Neither is in scope here.

## Goal

A chat widget in the dashboard that answers questions about the forecasting data and the tool itself, grounded only in the pipeline's exported JSON — no invented numbers, no live computation, no side effects.

## Context

- Dashboard (`dashboard/`) is a static Vite/React app, deployed to Vercel (`.vercel/` present, no `api/` dir yet). All data comes from `data/processed/*.json` written by the Python pipeline (`src/price_forecasting/export.py` etc.) — nothing is hardcoded in the UI.
- No backend exists today. Every "action" in the current UI (geo/FX scenario filters, HITL confirm/dismiss) is client-side only; HITL state lives in `localStorage`.
- Largest relevant JSON (`dashboard.json`) is 1.8MB — too big to stuff into an LLM prompt wholesale, so the model must fetch precise slices via tool calls instead.

## Architecture

```
ChatWidget.tsx (frontend)
   → POST /api/chat  (Vercel Node serverless function)
       → OpenAI Chat Completions API, tool-calling loop
           → tool handlers (dashboard/api/lib/tools.ts)
               → read data/processed/*.json, filter/lookup, return small slice
           ← tool result appended to conversation
       ← OpenAI returns final text answer
   ← JSON response { reply }
```

No database. No new hosting target — everything ships inside the existing Vercel project as serverless functions alongside the static build.

## Components

### 1. `dashboard/api/chat.ts`
- Vercel serverless function (Node runtime), `POST` only.
- Body: `{ messages: {role, content}[] }` — the running conversation from the widget.
- Loads a fixed system prompt (see below), prepends it, runs the OpenAI tool-calling loop:
  1. Call OpenAI with messages + tool schemas.
  2. If response requests tool call(s): execute matching handler(s) from `tools.ts`, append `tool` role results, go to 1.
  3. If response is plain text: return `{ reply: text }`.
  4. Cap loop iterations (e.g. 6) to avoid runaway tool-call chains; if exceeded, return a graceful "couldn't finish that one, try rephrasing" reply.
- In-memory per-IP rate limit (e.g. 20 requests / 10 min, simple counter map). Known limitation: resets on cold start / doesn't work across multiple function instances — acceptable deterrence for Phase 1, not a hard cap. Returns HTTP 429 with a plain message when exceeded.
- `OPENAI_API_KEY` read from Vercel env var, never sent to client.

### 2. `dashboard/api/lib/tools.ts`
One function per data slice, each reading only the file(s) it needs from `data/processed/`:

| Tool | Source file(s) | Purpose |
|---|---|---|
| `getKpis()` | `dashboard.json` | Headline KPIs shown on the main dashboard |
| `searchParts(query?, category?, vendor?, project?)` | `data/processed/forecasts.csv` (model=`xgboost`, horizon=1) + `data/raw/parts_prices.csv` (latest month, for current price) | Find parts by name/id/filters across all 480 parts, returns matching rows (capped, e.g. top 25) |
| `getPartForecast(partId)` | same as above, all 6 horizons for that part | Full detail for one part: current price + 6-month forecast curve (xgboost), anomaly flag |
| `getTopMovers(direction, n)` | same as above | Biggest forecast increases/decreases across all 480 parts (not just the 12 in `dashboard.json.topParts`, which is display-only) |
| `getCategoryBreakdown()` | `dashboard.json` | Category donut data |
| `getModelComparison()` | `dashboard.json` or `evaluation_compact.json` | Model comparison table |
| `getValidationSummary()` | `validation.json` | Real-data validation scores |
| `getFutureTestResults()` | `future_test.json` | Simulated-future test results |
| `getFxScenarios()` | `fx_analysis.json` | FX scenario impacts (no `family` field exists on FX scenarios, unlike geo — returns all) |
| `getGeoScenarios(family?)` | `geo_analysis.json` | Geo scenario impacts, optionally filtered |
| `getGeoEventStudies()` | `geo_analysis.json` | Curated event studies |
| `getHierarchy(level)` | `dashboard.json` | Project/vendor/category/part rollups |
| `getAlerts()` | `dashboard.json` | Current alerts strip data |
| `getDataProvenance()` | `dashboard.json` | Source/provenance info for the "Data Source" panel |

Each tool:
- Reads its source file(s) with Node `fs` (JSON via `JSON.parse`; the two CSVs via the `papaparse` library rather than hand-rolled splitting, since field values can't be assumed comma-free).
- **Deployment note:** Vercel's deployment root for this project is `dashboard/` (where `.vercel/project.json` lives) — `data/processed/` and `data/raw/` at the repo root are *not* included in a deployment. `dashboard/public/dashboard.json` already solves this for the main payload (the Python export stage writes it there directly). `forecasts.csv` and `parts_prices.csv` have no such copy today, so Phase 1 adds a `dashboard/scripts/sync-part-data.mjs` that copies them into `dashboard/api/_data/` (committed to git, like `public/dashboard.json`, and re-run whenever the Python pipeline regenerates data — wired into `predev`/`prebuild`). `dashboard/vercel.json` declares `includeFiles` for `api/_data/**` so the serverless bundle carries them.
- Parses `forecasts.csv` and `parts_prices.csv` once per warm function instance (module-level cache — parse on first call, reuse for subsequent calls in the same instance) rather than on every request, since they're 1-1.2MB each.
- Returns a small, typed JSON object/array — never the raw file.
- On file-read/parse failure, returns `{ error: "data unavailable: <what>" }` instead of throwing, so the model can tell the user rather than the request 500ing.

Tool JSON-schemas (name, description, parameters) live alongside each function for passing to the OpenAI API.

### 3. `dashboard/src/components/ChatWidget.tsx`
- Floating bubble, bottom-right, all dashboard views (mounted once in `App.tsx`, outside the view switch).
- Click opens an expandable panel: scrollable message list + text input + send button.
- Local component state only (`useState`), no persistence — history clears on refresh/navigation away, per approved scope.
- Sends full message history to `/api/chat` each turn (simplest; conversation length is short-lived per session so token cost is bounded).
- Loading state while awaiting response; inline error state ("chat unavailable, try again") on network/API failure — no stack traces surfaced to the user.
- Styled consistent with existing Tailwind setup; reuses `Icons.tsx` pattern for a chat icon.

## System Prompt

Grounds the model: answering questions about this car-parts price-forecasting POC; must only use tool data, never invent numbers or use outside knowledge of real-world part prices; must say "I don't know" / "not available" when a tool returns nothing relevant; should cite which part/category/scenario the numbers came from; can also explain what dashboard panels do (static knowledge of the tool's own features, written into the prompt) since "tool navigation help" is in scope for Phase 1 per the approved answer-scope question.

## Error Handling

- Tool read failure → structured `{error}` returned to model, not a thrown exception.
- OpenAI API failure (timeout, rate limit, 5xx) → `/api/chat` returns HTTP 502 with `{ error: "chat temporarily unavailable" }`; widget shows a friendly inline message.
- Rate limit exceeded → HTTP 429, widget shows "too many messages, try again in a few minutes."
- Malformed request body → HTTP 400.

## Testing

- Unit tests for every function in `tools.ts` against the real fixture files in `data/processed/` (pure functions, no network/LLM calls) — assert shape and filtering logic.
- Unit test for the rate limiter (pure logic, mock the clock/counter).
- One or two manual end-to-end smoke tests hitting the real OpenAI API through `/api/chat` (documented as manual, not part of CI, since they cost money and need a live key) — confirm the tool-calling loop actually round-trips.
- Browser check: widget opens/closes, sends a message, renders a real answer, survives a tool-call round trip (e.g. ask "what's the top mover?").

## Out of Scope (later phases)

- HITL confirm/dismiss via chat (needs new backend persistence — doesn't exist even outside chat today).
- FX/geo scenario mutation via chat.
- Pipeline/evaluation re-run trigger via chat.
- Chat history persistence across sessions.
- Any auth beyond the Phase 1 rate limiter.
