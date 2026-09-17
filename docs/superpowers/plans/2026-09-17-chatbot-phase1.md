# Dashboard Chatbot Phase 1 (Read-Only Q&A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a floating chat widget in the dashboard that answers questions about the forecasting data and the tool itself, backed by a new Vercel serverless function that gives an LLM tool-calling access to the pipeline's exported data — no invented numbers, no side effects.

**Architecture:** `ChatWidget.tsx` (frontend) posts the conversation to `POST /api/chat` (new Vercel Node function). The handler runs an OpenAI tool-calling loop: the model requests data via named tools (`searchParts`, `getTopMovers`, `getValidationSummary`, etc.), each tool reads a specific slice of `dashboard/public/dashboard.json` or the two CSV snapshots under `dashboard/api/_data/`, and the loop feeds results back until the model returns a final answer. No database, no new hosting target.

**Tech Stack:** TypeScript, Node 22, Vercel serverless functions (`@vercel/node`), OpenAI Node SDK (`openai`), `papaparse` for CSV parsing, Vitest for unit tests, existing Vite/React 19/Tailwind dashboard.

**Spec:** [docs/superpowers/specs/2026-09-17-chatbot-phase1-design.md](../specs/2026-09-17-chatbot-phase1-design.md)

## Global Constraints

- Node runtime: 22.x (matches installed `node -v`).
- Primary model: `xgboost` is the pipeline's selected model everywhere (confirmed in `export.py`) — all part-level forecast tools use `model === 'xgboost'` rows only.
- Currency: all source numbers are already in the same currency (INR) — no conversion needed anywhere in the tool layer.
- Rate limit: 20 requests / 10 minutes per client IP, in-memory (known limitation: resets on cold start).
- `searchParts` caps results at 25; `getTopMovers` defaults `n` to 10.
- No auth beyond the rate limiter. No chat history persistence — frontend state only.
- Deployment root is `dashboard/` (`.vercel/project.json` lives there) — nothing outside `dashboard/` ships in a deployment. `dashboard/public/dashboard.json` already exists there (written by `export.py`); `forecasts.csv`/`parts_prices.csv` do not, and Phase 1 adds a sync step for them.
- No feature outside Phase 1 scope: no HITL persistence, no scenario mutation, no pipeline trigger, no chat history persistence, no auth beyond rate limiting.

---

## Task 1: Data sync tooling for the two CSV snapshots

**Files:**
- Create: `dashboard/scripts/sync-part-data.mjs`
- Create: `dashboard/vercel.json`
- Create (generated, then committed): `dashboard/api/_data/forecasts.csv`
- Create (generated, then committed): `dashboard/api/_data/parts_prices.csv`

**Interfaces:**
- Produces: `dashboard/api/_data/forecasts.csv` and `dashboard/api/_data/parts_prices.csv`, byte-identical copies of `data/processed/forecasts.csv` and `data/raw/parts_prices.csv` at the repo root. Task 2's `data.ts` reads these two paths.

- [ ] **Step 1: Write the sync script**

```js
// dashboard/scripts/sync-part-data.mjs
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DASHBOARD_ROOT, '..');
const DEST_DIR = path.join(DASHBOARD_ROOT, 'api', '_data');

const FILES = [
  {
    src: path.join(REPO_ROOT, 'data', 'processed', 'forecasts.csv'),
    dest: path.join(DEST_DIR, 'forecasts.csv'),
  },
  {
    src: path.join(REPO_ROOT, 'data', 'raw', 'parts_prices.csv'),
    dest: path.join(DEST_DIR, 'parts_prices.csv'),
  },
];

mkdirSync(DEST_DIR, { recursive: true });

for (const { src, dest } of FILES) {
  if (!existsSync(src)) {
    console.error(`[sync-part-data] missing source file: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, dest);
  console.log(`[sync-part-data] copied ${path.basename(src)} -> ${dest}`);
}
```

- [ ] **Step 2: Create the Vercel functions config**

```json
// dashboard/vercel.json
{
  "functions": {
    "api/**/*.ts": {
      "includeFiles": "api/_data/**"
    }
  }
}
```

- [ ] **Step 3: Run the script and verify output**

Run (from `dashboard/`): `node scripts/sync-part-data.mjs`

Expected output:
```
[sync-part-data] copied forecasts.csv -> .../dashboard/api/_data/forecasts.csv
[sync-part-data] copied parts_prices.csv -> .../dashboard/api/_data/parts_prices.csv
```

Verify both files exist and are non-trivial in size (run `ls -la dashboard/api/_data/` — both should be roughly 0.8-1.3MB, matching the source files' sizes at the repo root).

- [ ] **Step 4: Commit**

```bash
git add dashboard/scripts/sync-part-data.mjs dashboard/vercel.json dashboard/api/_data/forecasts.csv dashboard/api/_data/parts_prices.csv
git commit -m "chore: add data sync script for chatbot's part-level CSVs"
```

---

## Task 2: Install dependencies, configure Vitest, build the data access layer

**Files:**
- Modify: `dashboard/package.json`
- Create: `dashboard/vitest.config.ts`
- Create: `dashboard/api/lib/data.ts`
- Test: `dashboard/api/lib/__tests__/data.test.ts`

**Interfaces:**
- Consumes: `dashboard/api/_data/forecasts.csv`, `dashboard/api/_data/parts_prices.csv` (Task 1), `dashboard/public/dashboard.json`, `DashboardData` type from `dashboard/src/types.ts`.
- Produces:
  - `getDashboardJson(): DashboardData`
  - `interface ForecastPoint { horizon: number; targetMonth: string; prediction: number; lower: number; upper: number }`
  - `interface PartRecord { partId: string; partName: string; category: string; vendor: string; vendorOrigin: string; project: string; oem: string; isAnomalyPart: boolean; currentPrice: number | null; currentMonth: string | null; forecast: ForecastPoint[] }`
  - `getPartsIndex(): PartRecord[]` (one entry per unique `part_id`, `forecast` sorted by horizon 1-6)

All deps needed by later tasks are installed here in one pass to avoid fragmenting `npm install` across the plan — Task 2 is the first task whose deliverable (a testable data layer) actually needs a test runner and a CSV parser.

- [ ] **Step 1: Add dependencies to package.json**

Edit `dashboard/package.json`:

```json
{
  "name": "dashboard",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "node scripts/dev-all.mjs",
    "build": "npm run sync-data && tsc -b && vite build",
    "lint": "oxlint",
    "preview": "vite preview",
    "sync-data": "node scripts/sync-part-data.mjs",
    "predev": "npm run sync-data",
    "test": "vitest run"
  },
  "dependencies": {
    "clsx": "^2.1.1",
    "openai": "^4.77.0",
    "papaparse": "^5.4.1",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "recharts": "^3.10.1"
  },
  "devDependencies": {
    "@types/node": "^24.13.2",
    "@types/papaparse": "^5.3.15",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vercel/node": "^3.2.24",
    "@vitejs/plugin-react": "^6.0.3",
    "autoprefixer": "^10.5.4",
    "dotenv": "^16.4.7",
    "oxlint": "^1.71.0",
    "postcss": "^8.5.23",
    "tailwindcss": "^3.4.19",
    "tsx": "^4.19.2",
    "typescript": "~6.0.2",
    "vite": "^8.1.1",
    "vitest": "^2.1.8"
  }
}
```

(`dev`/`predev`/`build` script bodies reference `scripts/dev-all.mjs`, which Task 6 creates — the `dev` script will not work until then; `npm test` and `npm run sync-data` work immediately.)

Run: `cd dashboard && npm install`
Expected: installs cleanly, `node_modules` updated, no errors.

- [ ] **Step 2: Add Vitest config**

```ts
// dashboard/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['api/**/__tests__/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Write the failing tests for the data layer**

```ts
// dashboard/api/lib/__tests__/data.test.ts
import { describe, it, expect } from 'vitest';
import Papa from 'papaparse';
import fs from 'node:fs';
import path from 'node:path';
import { getDashboardJson, getPartsIndex } from '../data';

const FORECASTS_CSV_PATH = path.join(process.cwd(), 'api', '_data', 'forecasts.csv');

describe('getDashboardJson', () => {
  it('loads the dashboard payload with expected top-level shape', () => {
    const data = getDashboardJson();
    expect(data.meta.nParts).toBeGreaterThan(0);
    expect(Array.isArray(data.kpis)).toBe(true);
  });
});

describe('getPartsIndex', () => {
  it('returns one record per unique part_id in the raw CSV', () => {
    const raw = fs.readFileSync(FORECASTS_CSV_PATH, 'utf-8');
    const parsed = Papa.parse<{ part_id: string }>(raw, { header: true, skipEmptyLines: true });
    const uniqueIds = new Set(parsed.data.map((row) => row.part_id));

    const index = getPartsIndex();
    expect(index.length).toBe(uniqueIds.size);
  });

  it('gives every part a full, sorted 6-month xgboost forecast curve', () => {
    const index = getPartsIndex();
    expect(index.length).toBeGreaterThan(0);
    for (const rec of index) {
      expect(rec.forecast.map((f) => f.horizon)).toEqual([1, 2, 3, 4, 5, 6]);
    }
  });

  it('resolves a numeric current price for parts present in parts_prices.csv', () => {
    const index = getPartsIndex();
    const withPrice = index.filter((rec) => rec.currentPrice !== null);
    expect(withPrice.length).toBeGreaterThan(0);
    for (const rec of withPrice.slice(0, 20)) {
      expect(typeof rec.currentPrice).toBe('number');
      expect(Number.isNaN(rec.currentPrice)).toBe(false);
    }
  });

  it('cross-checks one known part against an independent parse of the raw CSV', () => {
    const raw = fs.readFileSync(FORECASTS_CSV_PATH, 'utf-8');
    const parsed = Papa.parse<Record<string, string>>(raw, { header: true, skipEmptyLines: true });
    const partId = parsed.data[0].part_id;
    const rawHorizon1 = parsed.data.find(
      (row) => row.part_id === partId && row.model === 'xgboost' && row.horizon === '1',
    );
    expect(rawHorizon1).toBeDefined();

    const rec = getPartsIndex().find((r) => r.partId === partId);
    expect(rec).toBeDefined();
    const horizon1 = rec!.forecast.find((f) => f.horizon === 1);
    expect(horizon1?.prediction).toBeCloseTo(Number(rawHorizon1!.prediction), 4);
    expect(horizon1?.targetMonth).toBe(rawHorizon1!.target_month);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd dashboard && npm test`
Expected: FAIL — `../data` module not found.

- [ ] **Step 5: Implement the data access layer**

```ts
// dashboard/api/lib/data.ts
import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import type { DashboardData } from '../../src/types';

const DASHBOARD_JSON_PATH = path.join(process.cwd(), 'public', 'dashboard.json');
const FORECASTS_CSV_PATH = path.join(process.cwd(), 'api', '_data', 'forecasts.csv');
const PARTS_PRICES_CSV_PATH = path.join(process.cwd(), 'api', '_data', 'parts_prices.csv');

let dashboardCache: DashboardData | null = null;

export function getDashboardJson(): DashboardData {
  if (!dashboardCache) {
    const raw = fs.readFileSync(DASHBOARD_JSON_PATH, 'utf-8');
    dashboardCache = JSON.parse(raw) as DashboardData;
  }
  return dashboardCache;
}

export interface ForecastPoint {
  horizon: number;
  targetMonth: string;
  prediction: number;
  lower: number;
  upper: number;
}

export interface PartRecord {
  partId: string;
  partName: string;
  category: string;
  vendor: string;
  vendorOrigin: string;
  project: string;
  oem: string;
  isAnomalyPart: boolean;
  currentPrice: number | null;
  currentMonth: string | null;
  forecast: ForecastPoint[];
}

interface RawForecastRow {
  model: string;
  part_id: string;
  horizon: string;
  target_month: string;
  prediction: string;
  lower: string;
  upper: string;
  part_name: string;
  project: string;
  vendor: string;
  vendor_origin: string;
  category: string;
  oem: string;
  is_anomaly_part: string;
}

interface RawPriceRow {
  month: string;
  price: string;
  part_id: string;
}

function parseCsv<T>(filePath: string): T[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = Papa.parse<T>(raw, { header: true, skipEmptyLines: true });
  return parsed.data;
}

let partsIndexCache: PartRecord[] | null = null;

export function getPartsIndex(): PartRecord[] {
  if (partsIndexCache) return partsIndexCache;

  const priceRows = parseCsv<RawPriceRow>(PARTS_PRICES_CSV_PATH);
  const latestPriceByPart = new Map<string, { price: number; month: string }>();
  for (const row of priceRows) {
    const existing = latestPriceByPart.get(row.part_id);
    if (!existing || row.month > existing.month) {
      latestPriceByPart.set(row.part_id, { price: Number(row.price), month: row.month });
    }
  }

  const forecastRows = parseCsv<RawForecastRow>(FORECASTS_CSV_PATH);
  const byPart = new Map<string, PartRecord>();
  for (const row of forecastRows) {
    if (row.model !== 'xgboost') continue;
    let rec = byPart.get(row.part_id);
    if (!rec) {
      const priceInfo = latestPriceByPart.get(row.part_id) ?? null;
      rec = {
        partId: row.part_id,
        partName: row.part_name,
        category: row.category,
        vendor: row.vendor,
        vendorOrigin: row.vendor_origin,
        project: row.project,
        oem: row.oem,
        isAnomalyPart: row.is_anomaly_part === 'True',
        currentPrice: priceInfo?.price ?? null,
        currentMonth: priceInfo?.month ?? null,
        forecast: [],
      };
      byPart.set(row.part_id, rec);
    }
    rec.forecast.push({
      horizon: Number(row.horizon),
      targetMonth: row.target_month,
      prediction: Number(row.prediction),
      lower: Number(row.lower),
      upper: Number(row.upper),
    });
  }

  for (const rec of byPart.values()) {
    rec.forecast.sort((a, b) => a.horizon - b.horizon);
  }

  partsIndexCache = Array.from(byPart.values()).sort((a, b) => a.partId.localeCompare(b.partId));
  return partsIndexCache;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd dashboard && npm test`
Expected: PASS — all `data.test.ts` tests green.

- [ ] **Step 7: Commit**

```bash
git add dashboard/package.json dashboard/package-lock.json dashboard/vitest.config.ts dashboard/api/lib/data.ts dashboard/api/lib/__tests__/data.test.ts
git commit -m "feat: add chatbot data access layer (dashboard.json + part-level CSVs)"
```

---

## Task 3: Tool layer (the functions the LLM can call)

**Files:**
- Create: `dashboard/api/lib/tools.ts`
- Test: `dashboard/api/lib/__tests__/tools.test.ts`

**Interfaces:**
- Consumes: `getDashboardJson`, `getPartsIndex`, `PartRecord` from `./data` (Task 2).
- Produces:
  - `export const TOOL_DEFINITIONS: OpenAI.Chat.ChatCompletionTool[]`
  - `export const TOOL_HANDLERS: Record<string, (args: any) => unknown>`
  - Individual handler exports: `searchParts`, `getPartForecast`, `getTopMovers`, `getKpis`, `getCategoryBreakdown`, `getModelComparison`, `getValidationSummary`, `getFutureTestResults`, `getFxScenarios`, `getGeoScenarios`, `getGeoEventStudies`, `getHierarchy`, `getAlerts`, `getDataProvenance`.

  Task 5 (`chatLoop.ts`) consumes `TOOL_HANDLERS` (a name → handler map) and Task 6 (`chat.ts`) consumes `TOOL_DEFINITIONS` (schemas passed to the OpenAI API).

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/api/lib/__tests__/tools.test.ts
import { describe, it, expect } from 'vitest';
import { getPartsIndex } from '../data';
import {
  searchParts,
  getPartForecast,
  getTopMovers,
  getKpis,
  getCategoryBreakdown,
  getModelComparison,
  getValidationSummary,
  getFutureTestResults,
  getFxScenarios,
  getGeoScenarios,
  getGeoEventStudies,
  getHierarchy,
  getAlerts,
  getDataProvenance,
} from '../tools';

describe('searchParts', () => {
  it('finds parts by partId substring, case-insensitively', () => {
    const target = getPartsIndex()[0];
    const result = searchParts({ query: target.partId.slice(0, 6).toLowerCase() });
    expect(result.results.some((r) => r.partId === target.partId)).toBe(true);
  });

  it('filters by category', () => {
    const category = getPartsIndex()[0].category;
    const result = searchParts({ category });
    expect(result.results.length).toBeGreaterThan(0);
    for (const r of result.results) expect(r.category).toBe(category);
  });

  it('caps results at 25', () => {
    const result = searchParts({});
    expect(result.results.length).toBeLessThanOrEqual(25);
  });
});

describe('getPartForecast', () => {
  it('returns full detail for a known part', () => {
    const known = getPartsIndex()[0];
    const result = getPartForecast({ partId: known.partId });
    expect(result.partId).toBe(known.partId);
    expect(result.forecast).toHaveLength(6);
  });

  it('returns a structured error for an unknown part', () => {
    const result = getPartForecast({ partId: 'DOES-NOT-EXIST' });
    expect(result.error).toBeDefined();
  });
});

describe('getTopMovers', () => {
  it('sorts descending for direction "up"', () => {
    const result = getTopMovers({ direction: 'up', n: 5 });
    expect(result).toHaveLength(5);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].changePct).toBeGreaterThanOrEqual(result[i].changePct as number);
    }
  });

  it('sorts ascending for direction "down"', () => {
    const result = getTopMovers({ direction: 'down', n: 5 });
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].changePct).toBeLessThanOrEqual(result[i].changePct as number);
    }
  });
});

describe('dashboard.json passthrough tools', () => {
  it('getKpis returns the kpis array', () => {
    expect(Array.isArray(getKpis().kpis)).toBe(true);
  });

  it('getCategoryBreakdown returns categories', () => {
    expect(Array.isArray(getCategoryBreakdown().categories)).toBe(true);
  });

  it('getModelComparison returns both comparison and backtest summary', () => {
    const result = getModelComparison();
    expect(Array.isArray(result.modelComparison)).toBe(true);
    expect(Array.isArray(result.backtestSummary)).toBe(true);
  });

  it('getValidationSummary returns validation', () => {
    expect(getValidationSummary().validation).toBeDefined();
  });

  it('getFutureTestResults returns futureTest', () => {
    expect(getFutureTestResults().futureTest).toBeDefined();
  });

  it('getFxScenarios returns a scenarios array', () => {
    expect(Array.isArray(getFxScenarios().scenarios)).toBe(true);
  });

  it('getGeoScenarios returns scenarios, filterable by family', () => {
    const all = getGeoScenarios({});
    expect(Array.isArray(all.scenarios)).toBe(true);
    if (all.scenarios.length > 0) {
      const family = all.scenarios[0].family;
      const filtered = getGeoScenarios({ family });
      for (const s of filtered.scenarios) expect(s.family).toBe(family);
    }
  });

  it('getGeoEventStudies returns eventStudies', () => {
    expect(Array.isArray(getGeoEventStudies().eventStudies)).toBe(true);
  });

  it('getHierarchy returns data for a valid level', () => {
    const result = getHierarchy({ level: 'category' });
    expect(result.data).toBeDefined();
  });

  it('getHierarchy errors for an invalid level', () => {
    const result = getHierarchy({ level: 'bogus' });
    expect(result.error).toBeDefined();
  });

  it('getAlerts returns alerts', () => {
    expect(Array.isArray(getAlerts().alerts)).toBe(true);
  });

  it('getDataProvenance returns dataSources and provenance', () => {
    const result = getDataProvenance();
    expect(Array.isArray(result.dataSources)).toBe(true);
    expect(result.provenance).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && npm test`
Expected: FAIL — `../tools` module not found.

- [ ] **Step 3: Implement the tool layer**

```ts
// dashboard/api/lib/tools.ts
import type OpenAI from 'openai';
import { getDashboardJson, getPartsIndex, type PartRecord } from './data';

function changePct(current: number | null, forecast: number | null): number | null {
  if (current === null || forecast === null || current === 0) return null;
  return ((forecast - current) / current) * 100;
}

function summarizePart(rec: PartRecord) {
  const horizon1 = rec.forecast.find((f) => f.horizon === 1) ?? null;
  return {
    partId: rec.partId,
    partName: rec.partName,
    category: rec.category,
    vendor: rec.vendor,
    project: rec.project,
    currentPrice: rec.currentPrice,
    forecastPrice: horizon1?.prediction ?? null,
    changePct: changePct(rec.currentPrice, horizon1?.prediction ?? null),
    isAnomalyPart: rec.isAnomalyPart,
  };
}

const SEARCH_RESULT_LIMIT = 25;

export function searchParts(args: {
  query?: string;
  category?: string;
  vendor?: string;
  project?: string;
}) {
  const q = args.query?.toLowerCase().trim();
  const matches = getPartsIndex().filter((rec) => {
    if (q && !(rec.partId.toLowerCase().includes(q) || rec.partName.toLowerCase().includes(q))) {
      return false;
    }
    if (args.category && rec.category.toLowerCase() !== args.category.toLowerCase()) return false;
    if (args.vendor && rec.vendor.toLowerCase() !== args.vendor.toLowerCase()) return false;
    if (args.project && rec.project.toLowerCase() !== args.project.toLowerCase()) return false;
    return true;
  });
  return {
    totalMatches: matches.length,
    results: matches.slice(0, SEARCH_RESULT_LIMIT).map(summarizePart),
  };
}

export function getPartForecast(args: { partId: string }) {
  const rec = getPartsIndex().find((r) => r.partId.toLowerCase() === args.partId?.toLowerCase());
  if (!rec) return { error: `no part found with id ${args.partId}` };
  return rec;
}

export function getTopMovers(args: { direction: 'up' | 'down'; n?: number }) {
  const n = args.n ?? 10;
  const withChange = getPartsIndex()
    .map((rec) => ({
      rec,
      change: changePct(rec.currentPrice, rec.forecast.find((f) => f.horizon === 1)?.prediction ?? null),
    }))
    .filter((x): x is { rec: PartRecord; change: number } => x.change !== null);
  withChange.sort((a, b) => (args.direction === 'up' ? b.change - a.change : a.change - b.change));
  return withChange.slice(0, n).map((x) => summarizePart(x.rec));
}

export function getKpis() {
  const d = getDashboardJson();
  return { kpis: d.kpis, meta: d.meta };
}

export function getCategoryBreakdown() {
  return { categories: getDashboardJson().categories };
}

export function getModelComparison() {
  const d = getDashboardJson();
  return { modelComparison: d.modelComparison, backtestSummary: d.backtestSummary };
}

export function getValidationSummary() {
  return { validation: getDashboardJson().validation };
}

export function getFutureTestResults() {
  return { futureTest: getDashboardJson().futureTest };
}

export function getFxScenarios() {
  return { scenarios: getDashboardJson().fxAnalysis?.scenarios ?? [] };
}

export function getGeoScenarios(args: { family?: string }) {
  const scenarios = getDashboardJson().geoAnalysis?.scenarios ?? [];
  const filtered = args.family ? scenarios.filter((s) => s.family === args.family) : scenarios;
  return { scenarios: filtered };
}

export function getGeoEventStudies() {
  return { eventStudies: getDashboardJson().geoAnalysis?.eventStudies ?? [] };
}

const HIERARCHY_LEVELS = ['project', 'vendor', 'category'];

export function getHierarchy(args: { level: string }) {
  const h = getDashboardJson().hierarchy;
  if (!h || !HIERARCHY_LEVELS.includes(args.level) || !(args.level in h)) {
    return { error: `no hierarchy data for level "${args.level}" (valid: ${HIERARCHY_LEVELS.join(', ')})` };
  }
  return { level: args.level, data: h[args.level] };
}

export function getAlerts() {
  return { alerts: getDashboardJson().alerts };
}

export function getDataProvenance() {
  const d = getDashboardJson();
  return { dataSources: d.dataSources, provenance: d.provenance };
}

export const TOOL_HANDLERS: Record<string, (args: any) => unknown> = {
  searchParts,
  getPartForecast,
  getTopMovers,
  getKpis,
  getCategoryBreakdown,
  getModelComparison,
  getValidationSummary,
  getFutureTestResults,
  getFxScenarios,
  getGeoScenarios,
  getGeoEventStudies,
  getHierarchy,
  getAlerts,
  getDataProvenance,
};

export const TOOL_DEFINITIONS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'searchParts',
      description: 'Search across all 480 parts by name/id substring and optional category/vendor/project filters. Returns up to 25 matches.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to match against part id or part name' },
          category: { type: 'string' },
          vendor: { type: 'string' },
          project: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getPartForecast',
      description: 'Get full detail for one part: current price and its 6-month forecast curve.',
      parameters: {
        type: 'object',
        properties: { partId: { type: 'string' } },
        required: ['partId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getTopMovers',
      description: 'Get the parts with the biggest forecast price change (next-month horizon) across all 480 parts.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'] },
          n: { type: 'number', description: 'How many to return, default 10' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getKpis',
      description: 'Get the headline KPIs shown on the main dashboard (basket price, change, etc.) plus run metadata.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getCategoryBreakdown',
      description: 'Get spend and forecast-change breakdown by part category.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getModelComparison',
      description: 'Get model comparison (xgboost/sarima/seasonal_naive) and backtest stability summary.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getValidationSummary',
      description: 'Get how well the forecasts validate against real published BLS data.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getFutureTestResults',
      description: 'Get the simulated-future test results (forecast blind, then scored against held-out data).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getFxScenarios',
      description: 'Get FX shock scenarios and their modeled price impact.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getGeoScenarios',
      description: 'Get geopolitical shock scenarios and their modeled price impact, optionally filtered by family (freight/gpr/duty).',
      parameters: {
        type: 'object',
        properties: { family: { type: 'string', enum: ['freight', 'gpr', 'duty'] } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getGeoEventStudies',
      description: 'Get curated geopolitical event studies (event, channel, price response over time).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getHierarchy',
      description: 'Get spend/forecast rollups at a given hierarchy level.',
      parameters: {
        type: 'object',
        properties: { level: { type: 'string', enum: ['project', 'vendor', 'category'] } },
        required: ['level'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getAlerts',
      description: 'Get parts whose forecast movement warrants a procurement review.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getDataProvenance',
      description: 'Get the provenance of every data source feeding the dashboard (macro anchor, FX, freight, etc.).',
      parameters: { type: 'object', properties: {} },
    },
  },
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && npm test`
Expected: PASS — all `tools.test.ts` and `data.test.ts` tests green.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/lib/tools.ts dashboard/api/lib/__tests__/tools.test.ts
git commit -m "feat: add chatbot tool layer (14 read-only data tools)"
```

---

## Task 4: Rate limiter

**Files:**
- Create: `dashboard/api/lib/rateLimit.ts`
- Test: `dashboard/api/lib/__tests__/rateLimit.test.ts`

**Interfaces:**
- Produces: `checkRateLimit(key: string, now?: number): { allowed: boolean; retryAfterMs: number }`, `_resetRateLimitForTests(): void`.
- Consumed by: Task 6's `chat.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/api/lib/__tests__/rateLimit.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, _resetRateLimitForTests } from '../rateLimit';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;

describe('checkRateLimit', () => {
  beforeEach(() => {
    _resetRateLimitForTests();
  });

  it('allows requests under the limit', () => {
    const now = 0;
    for (let i = 0; i < MAX_REQUESTS; i++) {
      expect(checkRateLimit('1.2.3.4', now).allowed).toBe(true);
    }
  });

  it('blocks the request that exceeds the limit within the window', () => {
    const now = 0;
    for (let i = 0; i < MAX_REQUESTS; i++) checkRateLimit('1.2.3.4', now);
    const result = checkRateLimit('1.2.3.4', now);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('tracks separate keys independently', () => {
    const now = 0;
    for (let i = 0; i < MAX_REQUESTS; i++) checkRateLimit('1.2.3.4', now);
    expect(checkRateLimit('5.6.7.8', now).allowed).toBe(true);
  });

  it('resets once the window elapses', () => {
    const start = 0;
    for (let i = 0; i < MAX_REQUESTS; i++) checkRateLimit('1.2.3.4', start);
    expect(checkRateLimit('1.2.3.4', start).allowed).toBe(false);

    const afterWindow = start + WINDOW_MS + 1;
    expect(checkRateLimit('1.2.3.4', afterWindow).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test`
Expected: FAIL — `../rateLimit` module not found.

- [ ] **Step 3: Implement the rate limiter**

```ts
// dashboard/api/lib/rateLimit.ts
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;

interface Bucket {
  count: number;
  resetAt: number;
}

let buckets = new Map<string, Bucket>();

export function checkRateLimit(
  key: string,
  now: number = Date.now(),
): { allowed: boolean; retryAfterMs: number } {
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > MAX_REQUESTS) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  return { allowed: true, retryAfterMs: 0 };
}

export function _resetRateLimitForTests(): void {
  buckets = new Map();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/lib/rateLimit.ts dashboard/api/lib/__tests__/rateLimit.test.ts
git commit -m "feat: add in-memory rate limiter for chat endpoint"
```

---

## Task 5: Tool-calling loop (pure logic, provider-agnostic)

**Files:**
- Create: `dashboard/api/lib/chatLoop.ts`
- Test: `dashboard/api/lib/__tests__/chatLoop.test.ts`

**Interfaces:**
- Consumes: a `handlers: Record<string, (args: any) => unknown>` map (Task 3's `TOOL_HANDLERS`).
- Produces:
  - `type ChatRole = 'system' | 'user' | 'assistant' | 'tool'`
  - `interface ToolCall { id: string; name: string; arguments: string }`
  - `interface ChatMessage { role: ChatRole; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; name?: string }`
  - `interface ChatClient { createCompletion(messages: ChatMessage[]): Promise<{ content: string | null; toolCalls: ToolCall[] }> }`
  - `runChatLoop(client: ChatClient, handlers: Record<string, (args: any) => unknown>, initialMessages: ChatMessage[]): Promise<string>`
  - `MAX_ITERATIONS = 6`

  Task 6's `chat.ts` implements `ChatClient` against the real OpenAI SDK and calls `runChatLoop` with `TOOL_HANDLERS` from Task 3.

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/api/lib/__tests__/chatLoop.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runChatLoop, type ChatClient, type ChatMessage } from '../chatLoop';

function fakeClient(
  responses: { content: string | null; toolCalls: { id: string; name: string; arguments: string }[] }[],
): ChatClient {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  // repeat the last response for any calls beyond the provided list
  create.mockResolvedValue(responses[responses.length - 1]);
  return { createCompletion: create };
}

const baseMessages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

describe('runChatLoop', () => {
  it('returns text directly when the model makes no tool call', async () => {
    const client = fakeClient([{ content: 'hi there', toolCalls: [] }]);
    const result = await runChatLoop(client, {}, baseMessages);
    expect(result).toBe('hi there');
    expect(client.createCompletion).toHaveBeenCalledTimes(1);
  });

  it('executes a requested tool and feeds the result back before returning', async () => {
    const handler = vi.fn().mockReturnValue({ kpis: [{ id: 'basket' }] });
    const client = fakeClient([
      { content: null, toolCalls: [{ id: 'call_1', name: 'getKpis', arguments: '{}' }] },
      { content: 'the basket kpi is X', toolCalls: [] },
    ]);

    const result = await runChatLoop(client, { getKpis: handler }, baseMessages);

    expect(result).toBe('the basket kpi is X');
    expect(handler).toHaveBeenCalledWith({});
    const secondCallMessages = (client.createCompletion as any).mock.calls[1][0] as ChatMessage[];
    const toolMessage = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolMessage?.tool_call_id).toBe('call_1');
    expect(toolMessage?.content).toBe(JSON.stringify({ kpis: [{ id: 'basket' }] }));
  });

  it('reports an unknown tool name back to the model instead of throwing', async () => {
    const client = fakeClient([
      { content: null, toolCalls: [{ id: 'call_1', name: 'doesNotExist', arguments: '{}' }] },
      { content: 'ok', toolCalls: [] },
    ]);

    const result = await runChatLoop(client, {}, baseMessages);

    expect(result).toBe('ok');
    const secondCallMessages = (client.createCompletion as any).mock.calls[1][0] as ChatMessage[];
    const toolMessage = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('unknown tool');
  });

  it('stops after MAX_ITERATIONS and returns a fallback message', async () => {
    const client: ChatClient = {
      createCompletion: vi
        .fn()
        .mockResolvedValue({ content: null, toolCalls: [{ id: 'call_x', name: 'getKpis', arguments: '{}' }] }),
    };

    const result = await runChatLoop(client, { getKpis: () => ({}) }, baseMessages);

    expect(result).toContain("wasn't able to finish");
    expect(client.createCompletion).toHaveBeenCalledTimes(6);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && npm test`
Expected: FAIL — `../chatLoop` module not found.

- [ ] **Step 3: Implement the loop**

```ts
// dashboard/api/lib/chatLoop.ts
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatClient {
  createCompletion(messages: ChatMessage[]): Promise<{ content: string | null; toolCalls: ToolCall[] }>;
}

export const MAX_ITERATIONS = 6;

const FALLBACK_MESSAGE =
  "I wasn't able to finish that one — could you rephrase or ask something more specific?";

export async function runChatLoop(
  client: ChatClient,
  handlers: Record<string, (args: any) => unknown>,
  initialMessages: ChatMessage[],
): Promise<string> {
  const messages: ChatMessage[] = [...initialMessages];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.createCompletion(messages);

    if (!response.toolCalls || response.toolCalls.length === 0) {
      return response.content ?? '';
    }

    messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls });

    for (const call of response.toolCalls) {
      const handler = handlers[call.name];
      let result: unknown;
      if (!handler) {
        result = { error: `unknown tool: ${call.name}` };
      } else {
        try {
          const args = call.arguments ? JSON.parse(call.arguments) : {};
          result = handler(args);
        } catch (err) {
          result = { error: `tool ${call.name} failed: ${(err as Error).message}` };
        }
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: JSON.stringify(result),
      });
    }
  }

  return FALLBACK_MESSAGE;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/api/lib/chatLoop.ts dashboard/api/lib/__tests__/chatLoop.test.ts
git commit -m "feat: add provider-agnostic tool-calling loop"
```

---

## Task 6: Chat endpoint, system prompt, and local dev wiring

**Files:**
- Create: `dashboard/api/chat.ts`
- Create: `dashboard/api/lib/systemPrompt.ts`
- Create: `dashboard/scripts/dev-api-server.mjs`
- Create: `dashboard/scripts/dev-all.mjs`
- Create: `dashboard/.env.example`
- Modify: `dashboard/vite.config.ts`

**Interfaces:**
- Consumes: `TOOL_DEFINITIONS`, `TOOL_HANDLERS` (Task 3), `runChatLoop`, `ChatClient`, `ChatMessage` (Task 5), `checkRateLimit` (Task 4).
- Produces: `POST /api/chat` — request body `{ messages: { role: 'user' | 'assistant'; content: string }[] }`, response `{ reply: string }` on 200, `{ error: string }` on 400/429/502. Consumed by Task 7's `ChatWidget.tsx`.

No automated test for this task (it needs a live OpenAI API key and network access — see Task 8 for the manual end-to-end check). The deliverable is verified by starting the local dev stack and hitting the endpoint directly.

- [ ] **Step 1: Write the system prompt**

```ts
// dashboard/api/lib/systemPrompt.ts
export const SYSTEM_PROMPT = `You are the assistant embedded in a car-parts price-forecasting dashboard (a SKODA/VW auto-parts proof of concept).

Rules:
- Only use information returned by your tools. Never invent a price, percentage, or date, and never rely on outside knowledge of real-world auto-parts prices.
- If a tool returns no relevant data, or an "error" field, say plainly that the information isn't available rather than guessing.
- When you state a number, say which part/category/scenario/model it came from.
- You may also explain what the dashboard's own panels do, using this reference (these are static facts about the tool, not data):
  - Dashboard: headline KPIs, price forecast chart, category breakdown, top parts, horizon chart, risk, alerts.
  - Forecast Detail: model comparison and backtest stability.
  - Hierarchy Drill-down: project -> vendor -> category -> part rollups.
  - Technical FAQ: answers to technical review questions from live pipeline output.
  - FX Impact: currency-shock scenarios and whether the FX response can be trusted.
  - Geopolitical Risk: event-driven scenarios, event studies, and a human-in-the-loop alert queue.
  - Parts: every part ranked by forecast price movement.
  - Simulated-Future Test: extra generated months forecast blind, then revealed and scored.
  - Real-Data Validation: predictions scored against published BLS data.
  - Alerts: parts whose forecast movement warrants a procurement review.
  - Data Source: provenance of every number in the dashboard.
- Keep answers concise and concrete.`;
```

- [ ] **Step 2: Write the chat endpoint**

```ts
// dashboard/api/chat.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';
import { runChatLoop, type ChatClient, type ChatMessage } from './lib/chatLoop';
import { checkRateLimit } from './lib/rateLimit';
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from './lib/tools';
import { SYSTEM_PROMPT } from './lib/systemPrompt';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function toOpenAIMessage(m: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.tool_call_id!, content: m.content ?? '' };
  }
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.tool_calls?.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: m.role, content: m.content ?? '' };
}

class OpenAIChatClient implements ChatClient {
  constructor(
    private openai: OpenAI,
    private model: string,
  ) {}

  async createCompletion(messages: ChatMessage[]) {
    const completion = await this.openai.chat.completions.create({
      model: this.model,
      messages: messages.map(toOpenAIMessage),
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
    });
    const choice = completion.choices[0].message;
    const toolCalls = (choice.tool_calls ?? [])
      .filter((tc): tc is OpenAI.Chat.ChatCompletionMessageToolCall & { type: 'function' } => tc.type === 'function')
      .map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
    return { content: choice.content, toolCalls };
  }
}

function isValidIncomingMessage(m: unknown): m is { role: 'user' | 'assistant'; content: string } {
  if (!m || typeof m !== 'object') return false;
  const obj = m as Record<string, unknown>;
  return (obj.role === 'user' || obj.role === 'assistant') && typeof obj.content === 'string';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  const ip =
    (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';

  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    res.status(429).json({ error: 'too many messages, try again in a few minutes' });
    return;
  }

  const body = req.body as { messages?: unknown } | undefined;
  if (!body || !Array.isArray(body.messages) || !body.messages.every(isValidIncomingMessage)) {
    res.status(400).json({ error: 'invalid request body' });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    res.status(502).json({ error: 'chat temporarily unavailable' });
    return;
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(body.messages as { role: 'user' | 'assistant'; content: string }[]),
  ];

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const client = new OpenAIChatClient(openai, MODEL);
    const reply = await runChatLoop(client, TOOL_HANDLERS, messages);
    res.status(200).json({ reply });
  } catch (err) {
    console.error('chat endpoint error', err);
    res.status(502).json({ error: 'chat temporarily unavailable' });
  }
}
```

- [ ] **Step 3: Write the local dev API server (stand-in for Vercel's runtime, no CLI login required)**

```js
// dashboard/scripts/dev-api-server.mjs
import 'dotenv/config';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const PORT = process.env.API_PORT || 3001;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function withHelpers(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  return res;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/api/')) {
    send(res, 404, { error: 'not found' });
    return;
  }
  try {
    req.body = await readBody(req);
  } catch {
    send(res, 400, { error: 'invalid JSON body' });
    return;
  }
  withHelpers(res);
  try {
    const mod = await import(pathToFileURL(new URL('../api/chat.ts', import.meta.url)).href);
    await mod.default(req, res);
  } catch (err) {
    console.error('[dev-api] handler error', err);
    send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`[dev-api] listening on http://localhost:${PORT}`);
});
```

- [ ] **Step 4: Write the combined dev launcher**

```js
// dashboard/scripts/dev-all.mjs
import { spawn } from 'node:child_process';

function run(name, cmd, args) {
  const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}`);
    shutdown(code ?? 0);
  });
  return child;
}

const children = [];

function shutdown(code = 0) {
  for (const child of children) child.kill();
  process.exit(code);
}

children.push(run('vite', 'npx', ['vite']));
children.push(run('api', 'npx', ['tsx', 'watch', 'scripts/dev-api-server.mjs']));

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
```

- [ ] **Step 5: Add the Vite dev proxy so the frontend's relative `/api/chat` reaches the dev API server**

Read `dashboard/vite.config.ts` first, then add a `server.proxy` entry for `/api` pointing at `http://localhost:3001`, preserving the existing plugins/config already in the file.

- [ ] **Step 6: Add an env example file**

```
# dashboard/.env.example
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
API_PORT=3001
```

- [ ] **Step 7: Manual verification (no OpenAI key needed for this step)**

Run: `cd dashboard && npm run dev`
Expected: two processes start (`[vite]` on port 5173, `[dev-api]` on port 3001), no crash.

In another terminal: `curl -s -X POST http://localhost:5173/api/chat -H "Content-Type: application/json" -d "{\"messages\":[]}"`
Expected: proxied through Vite to the dev API server; since `OPENAI_API_KEY` isn't set yet, response is `{"error":"chat temporarily unavailable"}` with HTTP 502 — confirms routing, body parsing, and the missing-key guard all work end-to-end without needing a real key.

Stop both processes (Ctrl+C).

- [ ] **Step 8: Commit**

```bash
git add dashboard/api/chat.ts dashboard/api/lib/systemPrompt.ts dashboard/scripts/dev-api-server.mjs dashboard/scripts/dev-all.mjs dashboard/.env.example dashboard/vite.config.ts
git commit -m "feat: add /api/chat endpoint with local dev server wiring"
```

---

## Task 7: Chat widget UI

**Files:**
- Create: `dashboard/src/components/ChatWidget.tsx`
- Modify: `dashboard/src/components/Icons.tsx` (add `IconChat`)
- Modify: `dashboard/src/App.tsx` (mount the widget)

**Interfaces:**
- Consumes: `POST /api/chat` (Task 6).
- Produces: `<ChatWidget />`, a self-contained component with no props, mounted once in `App.tsx`.

No automated test (per spec — UI is verified by hand in the browser, done together with Task 8's end-to-end check).

- [ ] **Step 1: Add a chat icon**

Read `dashboard/src/components/Icons.tsx`, then add, following the file's existing pattern (`base` size constant, `stroke="currentColor"` outline style):

```tsx
export const IconChat = ({ className = base }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </svg>
);
```

- [ ] **Step 2: Write the widget**

```tsx
// dashboard/src/components/ChatWidget.tsx
import { useEffect, useRef, useState } from 'react';
import { IconChat } from './Icons';

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setInput('');
    setError(null);
    setLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? 'chat unavailable, try again');
        return;
      }
      setMessages([...next, { role: 'assistant', content: payload.reply as string }]);
    } catch {
      setError('chat unavailable, try again');
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') send();
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg transition hover:bg-brand-700"
        aria-label={open ? 'Close chat' : 'Open chat'}
      >
        <IconChat className="h-6 w-6" />
      </button>

      {open && (
        <div className="fixed bottom-24 right-6 z-50 flex h-[32rem] w-96 flex-col rounded-xl border border-slate-200 bg-white shadow-2xl">
          <div className="border-b border-slate-200 px-4 py-3">
            <p className="text-sm font-semibold text-slate-900">Ask about this dashboard</p>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <p className="text-sm text-slate-400">
                Ask about forecasts, alerts, validation, scenarios, or how to use this tool.
              </p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={
                  m.role === 'user'
                    ? 'ml-8 rounded-lg bg-brand-50 px-3 py-2 text-sm text-slate-800'
                    : 'mr-8 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-800'
                }
              >
                {m.content}
              </div>
            ))}
            {loading && <div className="mr-8 text-sm text-slate-400">Thinking…</div>}
            {error && <div className="mr-8 text-sm text-red-600">{error}</div>}
            <div ref={bottomRef} />
          </div>

          <div className="flex items-center gap-2 border-t border-slate-200 p-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question..."
              className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
            />
            <button
              onClick={send}
              disabled={loading || !input.trim()}
              className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: Mount it in App.tsx**

Read `dashboard/src/App.tsx`, then add `import { ChatWidget } from './components/ChatWidget';` to the imports, and add `<ChatWidget />` as the last child inside the outermost `<div className="min-h-screen">`, after the `{parametersOpen && (...)}` block — so it renders once `data` has loaded, on every view.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/ChatWidget.tsx dashboard/src/components/Icons.tsx dashboard/src/App.tsx
git commit -m "feat: add floating chat widget to the dashboard"
```

---

## Task 8: End-to-end manual verification

**Files:** none (verification only).

**Requires:** a real `OPENAI_API_KEY`. Ask the user for one and have them place it in `dashboard/.env.local` (already covered by the repo's `*.local` gitignore rule) before this task, e.g.:

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

- [ ] **Step 1: Start the full local stack**

Run: `cd dashboard && npm run dev`
Expected: `[vite]` serving on 5173, `[dev-api]` on 3001, no errors.

- [ ] **Step 2: Open the dashboard in a browser and use the widget**

Open `http://localhost:5173`, click the chat bubble bottom-right, ask: "What's the top mover by forecast increase?"

Expected: the widget shows "Thinking…", then an answer naming a specific part and a percentage — confirming the model actually round-tripped through `getTopMovers`.

- [ ] **Step 3: Check the network tab / dev-api server logs**

Confirm the browser's network tab shows a `POST /api/chat` returning 200 with `{"reply": "..."}`, and the `[dev-api]` terminal shows no errors.

- [ ] **Step 4: Ask a tool-navigation question**

Ask: "How do I see the FX impact scenarios?"

Expected: an answer referencing the "FX Impact" panel (sourced from the system prompt's panel reference, not a tool call) — confirms the "tool navigation help" part of Phase 1's approved scope works.

- [ ] **Step 5: Ask something outside the data's scope**

Ask: "What will the price of gold be next year?"

Expected: the assistant declines / says that's not available from this tool's data, rather than inventing an answer — confirms the system prompt's grounding rule holds.

No commit for this task — it's verification of Tasks 1-7's combined behavior. If any step fails, return to the relevant task, fix, and re-run this task's steps.
