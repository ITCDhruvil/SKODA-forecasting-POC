export interface ChatSource {
  title: string;
  url: string;
  domain: string;
}

export interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  /** Present on assistant replies that used live news. */
  sources?: ChatSource[];
  usedWeb?: boolean;
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
    messages.push({
      role: entry.role,
      content: entry.content,
      ...(sources.length > 0 ? { sources } : {}),
      ...(entry.usedWeb === true ? { usedWeb: true } : {}),
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
