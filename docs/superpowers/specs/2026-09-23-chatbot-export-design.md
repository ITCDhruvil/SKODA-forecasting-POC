# Dashboard Chatbot — Smart Document Export

Date: 2026-09-23

## Goal

Let the chatbot notice when a user would rather have a file than a chat bubble, offer it in its own words, and hand over an Excel workbook or a Word report in one click. The offer must read as part of the answer, not as a feature bolted beside it.

## Base

This design assumes the Phase 2 chatbot architecture (`router.ts`, `orchestrator.ts`, `toolsets.ts`, `charts.ts`, `responsesClient.ts`) is merged into `main`. It is built directly on that shape and does not apply to the Phase 1 code alone.

The load-bearing precedent is `showChart` in `dashboard/api/_lib/toolsets.ts`: the model calls a tool, the tool returns a small acknowledgement to the model, and the real payload leaves through a side channel (`onChart`) into `ChatResult.charts`, which the widget renders as `<ChartCard>`. The model picks a catalog id and a few parameters; the server computes every number. Export reuses that mechanism end to end.

## Decisions

Three choices shape everything below.

**Detection belongs to the model.** `offerExport` joins `showChart` in the toolset. The rule for when to offer lives in one description string, next to the chart description that already works. No keyword list, no scoring function, no second classifier call.

**Composition happens on click, not on offer.** The chat turn emits an intent only. Excel needs no model call at all. Word costs one small compose pass, paid only when someone actually clicks. A chat turn never pays for a document nobody wanted.

**Word only, no PDF.** Puppeteer/Chromium is too heavy for a Vercel function, and hand-coding a `pdfkit` layout would be most of the build. Word opens everywhere, exports to PDF in one click, and is editable, which is what a procurement reader usually wants.

## Architecture

```
CHAT TURN (cheap)
  model -> offerExport tool -> onExport collector -> ChatResult.exports[] -> <ExportCard>

CLICK (pays only now)
  POST /api/export
    xlsx -> exportCatalog -> docBuilder.buildXlsx -> bytes        (0 model calls)
    docx -> reportCompose (1 model pass) + exportCatalog -> docBuilder.buildDocx -> bytes
```

Bytes stream straight back to the browser as an attachment. Nothing is stored, so there is no blob store, no signed URL, no expiry policy and no cleanup job.

## Components

### 1. `dashboard/api/_lib/exportCatalog.ts`

The single source of truth for exported data. No model, no formatting.

```ts
export const EXPORT_IDS = [
  'parts_search', 'top_movers', 'category_breakdown',
  'hierarchy', 'alerts', 'scenarios',
] as const;
export type ExportId = (typeof EXPORT_IDS)[number];

export interface ExportData {
  title: string;                        // "Top 20 rising parts"
  columns: { key: string; label: string }[];
  rows: Record<string, string | number | null>[];
  source: string;                       // provenance line, same idea as ChartBase.source
  truncated: boolean;
}

export interface BuildExportArgs {
  export: ExportId;
  direction?: 'up' | 'down';                    // top_movers
  n?: number;                                   // top_movers
  level?: HierarchyLevel;                       // hierarchy
  family?: ScenarioFamily;                      // scenarios — reused from charts.ts
  query?: string; category?: string; vendor?: string; project?: string;  // parts_search
}

export function buildExportData(args: BuildExportArgs): ExportData | { error: string };
```

Each id is a thin wrapper over a function that already exists in `tools.ts` or `data.ts`, flattened into columns and rows. Charts cap at a handful of values because a chart must stay readable; an export does not, so the catalog is separate rather than reusing `CHART_IDS`.

The catalog covers six ids, not the fourteen read tools, because an id earns its place only by being row-shaped and worth sending to another person. `scenarios` takes a `family` parameter rather than splitting into an FX id and a geopolitical id, following the precedent already set by the `scenario_impact` chart, and reuses `ScenarioFamily` from `charts.ts`.

Three read tools are deliberately excluded. A single part's forecast is a curve, which is chart territory. Model comparison is three models and a few metrics. Validation is a paragraph of statistics. None of them is a spreadsheet. Nothing is lost by excluding them: a Word export with `dataRef: null` still writes a document about any of them from the conversation, which is what the null case exists for. Only the Excel button disappears, and only from things nobody wants in Excel.

`MAX_EXPORT_ROWS = 5000`. Past that the rows are truncated and `truncated` is set — a serverless function must not become a memory bomb over a cell count nobody will read.

### 2. `dashboard/api/_lib/exportOffer.ts`

The tool definition and a per-request handler factory, modelled on `buildShowChartHandler`.

```ts
export const MAX_EXPORTS_PER_ANSWER = 1;

export interface ExportOffer {
  format: 'xlsx' | 'docx';   // the model's pick; becomes the primary button
  label: string;             // "Top 20 rising parts"
  dataRef: { export: ExportId; params: Record<string, string | number> } | null;
}

export function offerExportDefinition(): ToolDefinition;
export function buildOfferExportHandler(onExport?: (o: ExportOffer) => void): (args: any) => unknown;
```

Parameters are flat, matching `showChart`: `format`, `label`, `export`, plus the optional `direction` / `n` / `level` / `family` / `query` / `category` / `vendor` / `project` that the catalog entries need. The handler assembles `dataRef` from them.

The cap is one offer per answer, where charts allow two. Two charts can answer two different questions — a trend and a ranking. Two export cards would be the same content in two wrappers, which is a format picker in disguise, and the single card already carries the other format as a link. An answer holding two genuinely separate exportables is rare, and the user can ask for the second one.

`dataRef` may be `null` for a pure narrative document. **`format: 'xlsx'` requires a `dataRef`** — a spreadsheet of nothing is an error, not an empty file.

The handler dedupes on the same `callKey` helper the chart handler uses, enforces `MAX_EXPORTS_PER_ANSWER`, and returns a small acknowledgement:

```ts
{ ok: true, offered: 'xlsx', label: 'Top 20 rising parts' }
```

That acknowledgement is what makes the offer read naturally: the model knows it offered and closes its answer in its own words. Without it, a card appears under prose that never mentions it.

**The detection rule, which lives in this file's description string:**

- Offer when the answer covers more than roughly ten rows, when the user asks for "all" / "every" / "the full list", or when the message carries a sharing word — send, share, report, deck, team, meeting, procurement, sign-off.
- Do not offer for five rows or fewer, or for a single number. The user can read those in the chat.
- Pick `xlsx` when the answer is rows, rankings or many parts; `docx` when it is an explanation, a scenario or a recommendation; `xlsx` when it is clearly both.

A wrong format pick costs one extra click, because the card offers the other format too. That is the deliberate insurance against having to tune the routing rule.

### 3. `dashboard/api/_lib/docBuilder.ts`

Pure formatting. No model, no data access, no network.

```ts
export function buildXlsx(data: ExportData): Promise<Buffer>;
export function buildDocx(doc: ReportDoc, table: ExportData | null): Promise<Buffer>;
export function exportFilename(title: string, format: 'xlsx' | 'docx'): string;
```

`exportFilename` slugs the title, appends the date, and strips anything outside `[a-z0-9-]`: `top-20-rising-parts-2026-09-23.xlsx`. Filenames are always derived server-side; a client-supplied filename is ignored.

Dependencies: `exceljs` for the workbook, `docx` for the Word file. Both are pure JavaScript and run fine in a Vercel function.

### 4. `dashboard/api/_lib/reportCompose.ts`

The only place a model writes document prose.

```ts
export interface ReportDoc {
  title: string;
  sections: { heading: string; paragraphs: string[] }[];
}

export function composeReport(deps, input: {
  messages: IncomingMessage[];
  label: string;
}): Promise<ReportDoc>;
```

One `responsesClient` call with a `strict` `json_schema`, the same mechanism the router uses. The model reads the conversation and writes only the parts that belong in a document — the relevant turns, not a transcript.

**The model never chooses the data.** `ReportDoc` has no table reference at all; the server appends the table from the already-validated `offer.dataRef`. So the compose pass cannot invent a number, cannot reach a catalog id the offer did not name, and the schema stays simple enough to be `strict`.

Conversation text is untrusted input. `composeReport` reuses the router's discipline: the text is wrapped in tags, angle brackets are stripped, and the instructions state that the tagged text is data to summarize and never instructions to follow.

On any failure — timeout, malformed JSON, API error — `composeReport` returns a deterministic fallback document: the label as title, one section holding the last assistant message. The user gets a file either way. This mirrors the orchestrator's web-to-data fallback.

### 5. `dashboard/api/export.ts`

A new Vercel function.

```
POST /api/export
  body: { offer: ExportOffer, format: 'xlsx' | 'docx', messages?: IncomingMessage[] }
```

`format` travels separately from `offer.format` so the card's secondary button can override the model's pick without another chat turn. `messages` is required for `docx` and ignored for `xlsx`.

Sequence: reject non-POST (405); rate limit via the existing `checkRateLimit` (429); validate the body shape (400); **re-validate `offer.dataRef.export` against `EXPORT_IDS`** (400 on anything else — the client-supplied id is a string and nothing more); apply the existing `MAX_MESSAGES` and `MAX_MESSAGE_LENGTH` caps to `messages` (400); build the bytes; respond 200 with the right `Content-Type` and `Content-Disposition: attachment; filename="..."`. A build failure is a 502 with a short JSON error.

`vercel.json` gains an `api/export.ts` entry with `includeFiles: "api/_data/**"` and `maxDuration: 60`, matching `api/chat.ts`.

### 6. Orchestrator and client wiring

`ChatResult` gains `exports: ExportOffer[]`, collected exactly like `charts`: a fresh array per run inside `answer()`, so a failed web attempt's offer never leaks into the data fallback. `buildToolset` adds `offerExport` alongside `showChart` for `data` and `web` modes, and omits it in `action` mode.

Client side: `sanitizeExports` next to the existing `sanitizeCharts`, `ChatEntry.exports`, and a new `ExportCard.tsx` rendered in the same slot as `<ChartCard>`.

```
+--------------------------------+
|  Top 20 rising parts           |
|  [ Excel ]   Word              |
+--------------------------------+
```

One line. The primary button is the model's pick; the alternative is a plain text link, not a competing button. No dropdown, no options panel, no filename field. States are idle, `Preparing...` with the button disabled, then `Downloaded` once the blob is saved. Download is a `fetch` POST, `response.blob()`, an object URL, a synthetic anchor click, then `URL.revokeObjectURL`.

Nothing here blocks the conversation. An ignored card does nothing. A user who wants the other format can also just say so — the model calls `offerExport` again, which is why no format-picker UI is needed.

## Error handling

- Unknown export id: 400, the card shows "couldn't build that file" and stays clickable.
- Compose pass fails or times out: the deterministic fallback document, so a file is still delivered.
- Row cap exceeded: truncate and append a note row inside the sheet. Not an error.
- 502 from `/api/export`: an inline error line under the card; the card survives and retry is one click.
- A second click while a download is in flight: the button is disabled, so no duplicate request.

## Testing

- `exportCatalog`: every id against the real `dashboard.json` fixture — non-empty columns, row counts matching the underlying tool function, the truncation flag at the cap. Follows `tools.test.ts`.
- `docBuilder`: fixture in, Buffer out; the workbook is parsed back with `exceljs` to assert the header row and row count; filenames are asserted against the slug rules.
- `offerExport` handler: the per-answer cap, dedupe on repeated identical calls, an unknown id returning an error, `onExport` firing exactly once, and `xlsx` without a `dataRef` being rejected. Follows the chart tests in `toolsets.test.ts`.
- `reportCompose`: a fake `ResponsesApi` returning a canned `ReportDoc`; prose passes through unchanged; malformed JSON and a thrown error both produce the fallback document. Follows `router.test.ts`.
- `api/export.ts`: method and body validation, unknown id, the `Content-Type` and `Content-Disposition` headers, and the 502 path. Follows `__tests__/chat.test.ts`.
- An offer golden set: about twenty messages tagged should-offer or should-not-offer, kept beside `_eval/routerGolden.ts` and run after any edit to the description string. This is the one piece of ongoing maintenance the design accepts, and it exists so false positives are visible rather than guessed at.
- Manual end-to-end check: ask for the top twenty rising parts, confirm the answer's own last sentence mentions the spreadsheet, click Excel, open the file, confirm the numbers match the chat. Then ask a scenario question, click Word, confirm the document contains the reasoning and a table whose numbers match.

## Out of scope

PDF output. Stored files and shareable links. Emailed or scheduled exports. Multi-sheet workbooks. Charts embedded in the Word document. Export buttons on the dashboard panels themselves, outside the chat.
