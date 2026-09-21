import { describe, it, expect } from 'vitest';
import {
  MAX_CONVERSATIONS,
  createId,
  deleteConversation,
  deriveTitle,
  formatRelativeTime,
  loadHistory,
  sanitizeSources,
  saveHistory,
  splitForDisplay,
  togglePin,
  toApiMessages,
  truncateForEdit,
  truncateForRegenerate,
  upsertConversation,
  type ChatEntry,
  type Conversation,
} from '../chatHistory';

const u = (content: string): ChatEntry => ({ role: 'user', content });
const a = (content: string): ChatEntry => ({ role: 'assistant', content });

function conv(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: `title ${id}`,
    messages: [u('hi')],
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('deriveTitle', () => {
  it('uses the first user message, whitespace collapsed', () => {
    expect(deriveTitle([u('  What   is\nthe top mover? '), a('x')])).toBe('What is the top mover?');
  });

  it('truncates long titles with an ellipsis', () => {
    const title = deriveTitle([u('x'.repeat(200))]);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back when there is no user message', () => {
    expect(deriveTitle([])).toBe('New chat');
    expect(deriveTitle([a('hello')])).toBe('New chat');
  });
});

describe('upsertConversation', () => {
  it('prepends a new conversation with derived title and timestamps', () => {
    const list = upsertConversation([conv('old')], { id: 'new', messages: [u('Hello there')] }, 500);
    expect(list.map((c) => c.id)).toEqual(['new', 'old']);
    expect(list[0]).toMatchObject({ title: 'Hello there', pinned: false, createdAt: 500, updatedAt: 500 });
  });

  it('updates an existing conversation in place, keeping pin and createdAt', () => {
    const start = [conv('a', { pinned: true, createdAt: 10, updatedAt: 10 })];
    const list = upsertConversation(start, { id: 'a', messages: [u('first'), a('reply')] }, 900);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pinned: true, createdAt: 10, updatedAt: 900, title: 'first' });
    expect(list[0].messages).toHaveLength(2);
  });

  it('does not save an empty conversation', () => {
    const start = [conv('a')];
    expect(upsertConversation(start, { id: 'b', messages: [] }, 5)).toEqual(start);
  });

  it('caps the list by dropping the oldest unpinned conversations', () => {
    let list: Conversation[] = [];
    list = upsertConversation(list, { id: 'pinned', messages: [u('keep me')] }, 1);
    list = togglePin(list, 'pinned');
    for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) {
      list = upsertConversation(list, { id: `c${i}`, messages: [u(`q${i}`)] }, 100 + i);
    }
    expect(list).toHaveLength(MAX_CONVERSATIONS);
    expect(list.some((c) => c.id === 'pinned')).toBe(true);
    expect(list.some((c) => c.id === 'c0')).toBe(false);
    expect(list.some((c) => c.id === `c${MAX_CONVERSATIONS + 4}`)).toBe(true);
  });
});

describe('togglePin / deleteConversation / splitForDisplay', () => {
  it('toggles the pinned flag for one conversation only', () => {
    const list = togglePin([conv('a'), conv('b')], 'b');
    expect(list.find((c) => c.id === 'a')?.pinned).toBe(false);
    expect(list.find((c) => c.id === 'b')?.pinned).toBe(true);
    expect(togglePin(list, 'b').find((c) => c.id === 'b')?.pinned).toBe(false);
  });

  it('deletes by id', () => {
    expect(deleteConversation([conv('a'), conv('b')], 'a').map((c) => c.id)).toEqual(['b']);
  });

  it('splits pinned vs recent, each newest first', () => {
    const list = [
      conv('r1', { updatedAt: 10 }),
      conv('p1', { pinned: true, updatedAt: 5 }),
      conv('r2', { updatedAt: 30 }),
      conv('p2', { pinned: true, updatedAt: 50 }),
    ];
    const { pinned, recent } = splitForDisplay(list);
    expect(pinned.map((c) => c.id)).toEqual(['p2', 'p1']);
    expect(recent.map((c) => c.id)).toEqual(['r2', 'r1']);
  });
});

describe('truncateForRegenerate', () => {
  const msgs = [u('q1'), a('a1'), u('q2'), a('a2')];

  it('drops the chosen assistant message and everything after it', () => {
    expect(truncateForRegenerate(msgs, 3)).toEqual([u('q1'), a('a1'), u('q2')]);
    expect(truncateForRegenerate(msgs, 1)).toEqual([u('q1')]);
  });

  it('refuses invalid targets', () => {
    expect(truncateForRegenerate(msgs, 0)).toBeNull(); // a user message
    expect(truncateForRegenerate(msgs, 9)).toBeNull(); // out of range
    expect(truncateForRegenerate([a('orphan')], 0)).toBeNull(); // no preceding user message
  });
});

describe('truncateForEdit', () => {
  const msgs = [u('q1'), a('a1'), u('q2'), a('a2')];

  it('replaces the user message and drops everything after it', () => {
    expect(truncateForEdit(msgs, 2, '  better question ')).toEqual([u('q1'), a('a1'), u('better question')]);
    expect(truncateForEdit(msgs, 0, 'new first')).toEqual([u('new first')]);
  });

  it('refuses invalid targets or empty text', () => {
    expect(truncateForEdit(msgs, 1, 'x')).toBeNull(); // an assistant message
    expect(truncateForEdit(msgs, 7, 'x')).toBeNull();
    expect(truncateForEdit(msgs, 2, '   ')).toBeNull();
  });
});

describe('loadHistory / saveHistory', () => {
  function fakeStorage(initial?: string) {
    let value: string | null = initial ?? null;
    return {
      getItem: () => value,
      setItem: (_k: string, v: string) => {
        value = v;
      },
      peek: () => value,
    };
  }

  it('round-trips a list', () => {
    const s = fakeStorage();
    const list = [conv('a', { pinned: true }), conv('b')];
    saveHistory(s, list);
    expect(loadHistory(s)).toEqual(list);
  });

  it('returns [] for empty, corrupt, or wrong-shaped storage', () => {
    expect(loadHistory(fakeStorage())).toEqual([]);
    expect(loadHistory(fakeStorage('not json{'))).toEqual([]);
    expect(loadHistory(fakeStorage('{"a":1}'))).toEqual([]);
  });

  it('drops malformed entries but keeps valid ones', () => {
    const good = conv('good');
    const raw = JSON.stringify([
      good,
      { id: 5, title: 'bad id', messages: [] },
      { id: 'x', title: 't', messages: [{ role: 'system', content: 'nope' }] },
      null,
    ]);
    expect(loadHistory(fakeStorage(raw)).map((c) => c.id)).toEqual(['good']);
  });

  it('never throws when storage is unavailable', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadHistory(throwing)).toEqual([]);
    expect(() => saveHistory(throwing, [conv('a')])).not.toThrow();
  });
});

describe('formatRelativeTime', () => {
  const now = new Date(2026, 8, 21, 12, 0, 0).getTime();
  it('formats recent times compactly', () => {
    expect(formatRelativeTime(now - 20_000, now)).toBe('Just now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatRelativeTime(now - 30 * 3_600_000, now)).toBe('Yesterday');
  });

  it('falls back to a short date for older items', () => {
    const old = new Date(2026, 0, 5, 12, 0, 0).getTime();
    expect(formatRelativeTime(old, now)).toBe('Jan 5');
  });
});

describe('createId', () => {
  it('returns distinct non-empty ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.length).toBeGreaterThan(5);
  });
});

describe('sanitizeSources', () => {
  it('keeps well-formed http(s) sources and drops everything else', () => {
    const raw = [
      { title: 'Steel up', url: 'https://reuters.com/a', domain: 'reuters.com' },
      { title: 'bad scheme', url: 'javascript:alert(1)', domain: 'x' },
      { title: 5, url: 'https://ft.com/b', domain: 'ft.com' },
      'nope',
      null,
    ];
    expect(sanitizeSources(raw)).toEqual([{ title: 'Steel up', url: 'https://reuters.com/a', domain: 'reuters.com' }]);
  });

  it('returns an empty list for non-arrays and caps the list at 10', () => {
    expect(sanitizeSources(undefined)).toEqual([]);
    expect(sanitizeSources({})).toEqual([]);
    const many = Array.from({ length: 15 }, (_, i) => ({ title: `t${i}`, url: `https://ft.com/${i}`, domain: 'ft.com' }));
    expect(sanitizeSources(many)).toHaveLength(10);
  });
});

describe('toApiMessages', () => {
  it('sends only role and content, never sources or flags', () => {
    const entries: ChatEntry[] = [
      u('hi'),
      { role: 'assistant', content: 'yo', usedWeb: true, sources: [{ title: 't', url: 'https://reuters.com/a', domain: 'reuters.com' }] },
    ];
    expect(toApiMessages(entries)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]);
  });
});

describe('history with web sources', () => {
  function memoryStorage() {
    const store = { value: '' };
    return {
      getItem: () => store.value || null,
      setItem: (_k: string, v: string) => {
        store.value = v;
      },
    };
  }

  it('round-trips usedWeb and sources on assistant messages', () => {
    const storage = memoryStorage();
    const sources = [{ title: 'Steel', url: 'https://reuters.com/a', domain: 'reuters.com' }];
    saveHistory(storage, [conv('a', { messages: [u('q'), { role: 'assistant', content: 'r', usedWeb: true, sources }] })]);
    const loaded = loadHistory(storage);
    expect(loaded[0].messages[1]).toEqual({ role: 'assistant', content: 'r', usedWeb: true, sources });
  });

  it('drops unsafe source urls from stored history and still loads records without sources', () => {
    const storage = memoryStorage();
    storage.setItem(
      'k',
      JSON.stringify([
        {
          id: 'a',
          title: 't',
          messages: [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'r', usedWeb: true, sources: [{ title: 'x', url: 'javascript:alert(1)', domain: 'x' }] },
          ],
        },
        { id: 'b', title: 't2', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'r' }] },
      ]),
    );
    const loaded = loadHistory(storage);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].messages[1].sources).toBeUndefined();
    expect(loaded[1].messages[1]).toEqual({ role: 'assistant', content: 'r' });
  });
});
