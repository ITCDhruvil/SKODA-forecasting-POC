export interface ChatSource {
  title: string;
  url: string;
  domain: string;
}

export type ChartUnit = 'pct' | 'currency' | 'number';
export interface ChartBase {
  title: string;
  unit: ChartUnit;
  currencySymbol: string;
  source: string;
}
export interface LineChartSeries {
  key: string;
  label: string;
  style: 'solid' | 'dashed';
}
export interface LineChartPoint {
  x: string;
  [seriesKey: string]: string | number | null;
}
export interface LineChartBand {
  lowerKey: string;
  upperKey: string;
  label: string;
}
export interface LineChartSpec extends ChartBase {
  kind: 'line';
  points: LineChartPoint[];
  series: LineChartSeries[];
  band?: LineChartBand;
}
export interface BarChartSeries {
  key: string;
  label: string;
}
export interface BarChartRow {
  label: string;
  values: Record<string, number>;
  tone?: 'up' | 'down' | 'neutral';
}
export interface BarChartSpec extends ChartBase {
  kind: 'bar';
  orientation: 'horizontal' | 'vertical';
  series: BarChartSeries[];
  rows: BarChartRow[];
}
export interface DonutSlice {
  label: string;
  value: number;
}
export interface DonutChartSpec extends ChartBase {
  kind: 'donut';
  slices: DonutSlice[];
}
export type ChartSpec = LineChartSpec | BarChartSpec | DonutChartSpec;

export interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  /** Present on assistant replies that used live news. */
  sources?: ChatSource[];
  usedWeb?: boolean;
  /** Present on assistant replies that include server-rendered charts. */
  charts?: ChartSpec[];
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatEntry[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export const HISTORY_STORAGE_KEY = 'radar-chat-history-v1';
export const MAX_CONVERSATIONS = 50;
const MAX_TITLE_LENGTH = 80;
const MAX_SOURCES = 10;
const MAX_CHARTS = 2;
const MAX_BAR_ROWS = 20;
const MAX_DONUT_SLICES = 12;
const MAX_CHART_TEXT_LENGTH = 200;

/** Validates untrusted source data (server payload or localStorage): http(s) urls only, string fields only. */
export function sanitizeSources(raw: unknown): ChatSource[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatSource[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.title !== 'string' || typeof s.url !== 'string' || typeof s.domain !== 'string') continue;
    let protocol: string;
    try {
      protocol = new URL(s.url).protocol;
    } catch {
      continue;
    }
    if (protocol !== 'https:' && protocol !== 'http:') continue;
    out.push({ title: s.title, url: s.url, domain: s.domain });
    if (out.length === MAX_SOURCES) break;
  }
  return out;
}

/** Trims, and non-empty-after-trim + length-caps, a string field; null if the input isn't usable. */
function sanitizeChartText(raw: unknown, maxLength: number = MAX_CHART_TEXT_LENGTH): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function sanitizeLinePoints(raw: unknown): LineChartPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: LineChartPoint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    if (typeof p.x !== 'string') continue;
    let valid = true;
    for (const [key, value] of Object.entries(p)) {
      if (key === 'x') continue;
      if (typeof value !== 'string' && typeof value !== 'number' && value !== null) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    out.push(p as LineChartPoint);
  }
  return out;
}

function sanitizeLineSeries(raw: unknown): LineChartSeries[] {
  if (!Array.isArray(raw)) return [];
  const out: LineChartSeries[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.key !== 'string' || typeof s.label !== 'string') continue;
    if (s.style !== 'solid' && s.style !== 'dashed') continue;
    out.push({ key: s.key, label: s.label, style: s.style });
  }
  return out;
}

function sanitizeLineBand(raw: unknown): LineChartBand | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as Record<string, unknown>;
  const lowerKey = sanitizeChartText(b.lowerKey);
  const upperKey = sanitizeChartText(b.upperKey);
  const label = sanitizeChartText(b.label);
  if (lowerKey === null || upperKey === null || label === null) return undefined;
  return { lowerKey, upperKey, label };
}

function sanitizeBarSeries(raw: unknown): BarChartSeries[] {
  if (!Array.isArray(raw)) return [];
  const out: BarChartSeries[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.key !== 'string' || typeof s.label !== 'string') continue;
    out.push({ key: s.key, label: s.label });
  }
  return out;
}

function sanitizeBarRows(raw: unknown): BarChartRow[] {
  if (!Array.isArray(raw)) return [];
  const out: BarChartRow[] = [];
  for (const item of raw) {
    if (out.length === MAX_BAR_ROWS) break;
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.label !== 'string') continue;
    if (!r.values || typeof r.values !== 'object') continue;
    const values: Record<string, number> = {};
    let valid = true;
    for (const [key, value] of Object.entries(r.values as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        valid = false;
        break;
      }
      values[key] = value;
    }
    if (!valid) continue;
    const tone = r.tone === 'up' || r.tone === 'down' || r.tone === 'neutral' ? r.tone : undefined;
    out.push({ label: r.label, values, ...(tone ? { tone } : {}) });
  }
  return out;
}

function sanitizeDonutSlices(raw: unknown): DonutSlice[] {
  if (!Array.isArray(raw)) return [];
  const out: DonutSlice[] = [];
  for (const item of raw) {
    if (out.length === MAX_DONUT_SLICES) break;
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.label !== 'string') continue;
    if (typeof s.value !== 'number' || !Number.isFinite(s.value) || s.value < 0) continue;
    out.push({ label: s.label, value: s.value });
  }
  return out;
}

/** Validates one untrusted chart spec (server payload or localStorage); null if it can't be salvaged. */
function sanitizeChart(raw: unknown): ChartSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (c.kind !== 'line' && c.kind !== 'bar' && c.kind !== 'donut') return null;
  const title = sanitizeChartText(c.title);
  const source = sanitizeChartText(c.source);
  const currencySymbol = sanitizeChartText(c.currencySymbol);
  if (title === null || source === null || currencySymbol === null) return null;
  if (c.unit !== 'pct' && c.unit !== 'currency' && c.unit !== 'number') return null;
  const base: ChartBase = { title, source, currencySymbol, unit: c.unit };

  if (c.kind === 'line') {
    const points = sanitizeLinePoints(c.points);
    if (points.length === 0) return null;
    const series = sanitizeLineSeries(c.series);
    if (series.length === 0) return null;
    const band = sanitizeLineBand(c.band);
    return { kind: 'line', ...base, points, series, ...(band ? { band } : {}) };
  }

  if (c.kind === 'bar') {
    if (c.orientation !== 'horizontal' && c.orientation !== 'vertical') return null;
    const series = sanitizeBarSeries(c.series);
    if (series.length === 0) return null;
    const rows = sanitizeBarRows(c.rows);
    if (rows.length === 0) return null;
    return { kind: 'bar', ...base, orientation: c.orientation, series, rows };
  }

  const slices = sanitizeDonutSlices(c.slices);
  if (slices.length === 0) return null;
  return { kind: 'donut', ...base, slices };
}

/** Validates untrusted chart data (server payload or localStorage) the same way `sanitizeSources` does. */
export function sanitizeCharts(raw: unknown): ChartSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: ChartSpec[] = [];
  for (const item of raw) {
    const chart = sanitizeChart(item);
    if (!chart) continue;
    out.push(chart);
    if (out.length === MAX_CHARTS) break;
  }
  return out;
}

/** What is sent to /api/chat: role and content only (sources and flags stay on the client). */
export function toApiMessages(entries: ChatEntry[]): { role: 'user' | 'assistant'; content: string }[] {
  return entries.map(({ role, content }) => ({ role, content }));
}

export function createId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function deriveTitle(messages: ChatEntry[]): string {
  const first = messages.find((m) => m.role === 'user');
  const text = first?.content.replace(/\s+/g, ' ').trim();
  if (!text) return 'New chat';
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : text;
}

function capConversations(list: Conversation[]): Conversation[] {
  if (list.length <= MAX_CONVERSATIONS) return list;
  const oldestUnpinned = list.filter((c) => !c.pinned).sort((x, y) => x.updatedAt - y.updatedAt);
  const dropIds = new Set(oldestUnpinned.slice(0, list.length - MAX_CONVERSATIONS).map((c) => c.id));
  return list.filter((c) => !dropIds.has(c.id));
}

export function upsertConversation(
  list: Conversation[],
  update: { id: string; messages: ChatEntry[] },
  now: number = Date.now(),
): Conversation[] {
  if (update.messages.length === 0) return list;
  const title = deriveTitle(update.messages);
  const exists = list.some((c) => c.id === update.id);
  const next = exists
    ? list.map((c) => (c.id === update.id ? { ...c, title, messages: update.messages, updatedAt: now } : c))
    : [
        { id: update.id, title, messages: update.messages, pinned: false, createdAt: now, updatedAt: now },
        ...list,
      ];
  return capConversations(next);
}

/**
 * Like `upsertConversation`, but a no-op when `update.id` was deleted while the request that produced it was in
 * flight (so a late reply cannot re-create a conversation the user removed from History).
 */
export function upsertUnlessDeleted(
  list: Conversation[],
  update: { id: string; messages: ChatEntry[] },
  deletedIds: ReadonlySet<string>,
  now: number = Date.now(),
): Conversation[] {
  if (deletedIds.has(update.id)) return list;
  return upsertConversation(list, update, now);
}

export function togglePin(list: Conversation[], id: string): Conversation[] {
  return list.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c));
}

export function deleteConversation(list: Conversation[], id: string): Conversation[] {
  return list.filter((c) => c.id !== id);
}

export function splitForDisplay(list: Conversation[]): { pinned: Conversation[]; recent: Conversation[] } {
  const newestFirst = [...list].sort((x, y) => y.updatedAt - x.updatedAt);
  return {
    pinned: newestFirst.filter((c) => c.pinned),
    recent: newestFirst.filter((c) => !c.pinned),
  };
}

/** Messages to resend when regenerating the assistant reply at `assistantIndex`. */
export function truncateForRegenerate(messages: ChatEntry[], assistantIndex: number): ChatEntry[] | null {
  if (assistantIndex < 1 || assistantIndex >= messages.length) return null;
  if (messages[assistantIndex].role !== 'assistant') return null;
  if (messages[assistantIndex - 1].role !== 'user') return null;
  return messages.slice(0, assistantIndex);
}

/** Messages to resend after editing the user message at `userIndex`. */
export function truncateForEdit(messages: ChatEntry[], userIndex: number, newText: string): ChatEntry[] | null {
  const text = newText.trim();
  if (!text || userIndex < 0 || userIndex >= messages.length) return null;
  if (messages[userIndex].role !== 'user') return null;
  return [...messages.slice(0, userIndex), { role: 'user', content: text }];
}

function normalizeConversation(raw: unknown): Conversation[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.title !== 'string' || !Array.isArray(o.messages)) return [];

  const messages: ChatEntry[] = [];
  for (const m of o.messages) {
    if (!m || typeof m !== 'object') return [];
    const entry = m as Record<string, unknown>;
    if ((entry.role !== 'user' && entry.role !== 'assistant') || typeof entry.content !== 'string') return [];
    const sources = sanitizeSources(entry.sources);
    const charts = sanitizeCharts(entry.charts);
    messages.push({
      role: entry.role,
      content: entry.content,
      ...(sources.length > 0 ? { sources } : {}),
      ...(entry.usedWeb === true ? { usedWeb: true } : {}),
      ...(charts.length > 0 ? { charts } : {}),
    });
  }
  if (messages.length === 0) return [];

  return [
    {
      id: o.id,
      title: o.title,
      messages,
      pinned: o.pinned === true,
      createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    },
  ];
}

export function loadHistory(storage: Pick<Storage, 'getItem'>): Conversation[] {
  try {
    const raw = storage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.flatMap(normalizeConversation) : [];
  } catch {
    return [];
  }
}

export function saveHistory(storage: Pick<Storage, 'setItem'>, list: Conversation[]): void {
  try {
    storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* quota exceeded or storage blocked — history just won't persist */
  }
}

export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 172_800_000) return 'Yesterday';
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
