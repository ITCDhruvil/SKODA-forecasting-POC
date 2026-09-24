export type Impact = 'cost_up' | 'cost_down' | 'watch';

const IMPACTS: readonly Impact[] = ['cost_up', 'cost_down', 'watch'];

export interface BriefingItem {
  headline: string;
  impact: Impact;
  area: string;
  why: string;
  outlet: string;
  /** Publication date, YYYY-MM-DD. */
  date: string;
  url: string;
  /** From the verified search source, never from the model. */
  domain: string;
}

export interface Briefing {
  /** YYYY-MM-DD in the briefing time zone (server: Asia/Kolkata). */
  date: string;
  /** ISO timestamp. */
  generatedAt: string;
  model: string;
  /** 1 to 5 items. */
  items: BriefingItem[];
}

export type BriefingParseResult =
  | { kind: 'ready'; briefing: Briefing }
  | { kind: 'pending' }
  | { kind: 'disabled' }
  | { kind: 'error' };

const MAX_ITEMS = 5;

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

const ITEM_STRING_FIELDS = ['headline', 'area', 'why', 'outlet', 'date', 'url', 'domain'] as const;

/** Validates one briefing item; strings only, a real http(s) url, a known impact. Anything else is dropped. */
function sanitizeItem(raw: unknown): BriefingItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  for (const field of ITEM_STRING_FIELDS) {
    if (typeof r[field] !== 'string' || r[field] === '') return null;
  }
  if (!IMPACTS.includes(r.impact as Impact)) return null;
  const url = r.url as string;
  if (!isHttpUrl(url)) return null;
  return {
    headline: r.headline as string,
    impact: r.impact as Impact,
    area: r.area as string,
    why: r.why as string,
    outlet: r.outlet as string,
    date: r.date as string,
    url,
    domain: r.domain as string,
  };
}

/** Validates the briefing envelope and filters items; returns null when the whole thing is unusable. */
function sanitizeBriefing(raw: unknown): Briefing | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.date !== 'string' || typeof r.generatedAt !== 'string' || typeof r.model !== 'string') return null;
  if (!Array.isArray(r.items)) return null;

  const items: BriefingItem[] = [];
  for (const rawItem of r.items) {
    const item = sanitizeItem(rawItem);
    if (item) items.push(item);
    if (items.length === MAX_ITEMS) break;
  }
  if (items.length === 0) return null;

  return { date: r.date, generatedAt: r.generatedAt, model: r.model, items };
}

/**
 * Parses the body of `GET /api/briefing`. Never throws: any status/body combination that is not exactly one of the
 * contract's four shapes (200 ready with a valid briefing, 200 disabled, 202 pending) yields `error`.
 */
export function parseBriefingResponse(status: number, body: unknown): BriefingParseResult {
  if (!body || typeof body !== 'object') return { kind: 'error' };
  const b = body as Record<string, unknown>;

  if (status === 200 && b.status === 'ready') {
    const briefing = sanitizeBriefing(b.briefing);
    return briefing ? { kind: 'ready', briefing } : { kind: 'error' };
  }
  if (status === 200 && b.status === 'disabled') return { kind: 'disabled' };
  if (status === 202 && b.status === 'pending') return { kind: 'pending' };
  return { kind: 'error' };
}

export const BRIEFING_CACHE_KEY = 'radar-briefing-cache-v1';

/** Returns the cached briefing only when it is for exactly `today` (a YYYY-MM-DD, browser-local date). */
export function loadCachedBriefing(storage: Pick<Storage, 'getItem'>, today: string): Briefing | null {
  try {
    const raw = storage.getItem(BRIEFING_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const briefing = sanitizeBriefing(parsed);
    if (!briefing || briefing.date !== today) return null;
    return briefing;
  } catch {
    return null;
  }
}

export function saveCachedBriefing(storage: Pick<Storage, 'setItem'>, briefing: Briefing): void {
  try {
    storage.setItem(BRIEFING_CACHE_KEY, JSON.stringify(briefing));
  } catch {
    /* storage blocked or quota exceeded: the cache just won't persist */
  }
}

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const FRESH_MAX_AGE_MS = 20 * 3_600_000;

/**
 * A cached briefing is still worth showing when its `date` is today's or yesterday's browser-local date (the
 * server's day boundary is Asia/Kolkata, which can be a day ahead or behind the browser) and it was generated less
 * than 20 hours ago.
 */
export function isFresh(briefing: Briefing, now: Date = new Date()): boolean {
  const today = localDateKey(now);
  const yesterday = localDateKey(new Date(now.getTime() - 24 * 3_600_000));
  if (briefing.date !== today && briefing.date !== yesterday) return false;

  const generatedAt = new Date(briefing.generatedAt).getTime();
  if (!Number.isFinite(generatedAt)) return false;
  const age = now.getTime() - generatedAt;
  return age >= 0 && age < FRESH_MAX_AGE_MS;
}
