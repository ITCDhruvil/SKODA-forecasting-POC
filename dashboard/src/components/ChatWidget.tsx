import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ChartCard } from './ChartCard';
import { ChatHistoryPanel } from './ChatHistoryPanel';
import { ChatOpenScreen } from './ChatOpenScreen';
import { ExportCard } from './ExportCard';
import { RadarSettings } from './RadarSettings';
import { MessageMarkdown } from './chatMarkdown';
import { SourceList } from './SourceList';
import {
  IconCheck,
  IconClose,
  IconCopy,
  IconEdit,
  IconGear,
  IconGlobe,
  IconHistory,
  IconNewChat,
  IconRefresh,
  IconSend,
  IconStop,
} from './Icons';
import {
  createId,
  deleteConversation,
  loadHistory,
  saveHistory,
  sanitizeCharts,
  sanitizeExports,
  sanitizeSources,
  togglePin,
  toApiMessages,
  truncateForEdit,
  truncateForRegenerate,
  upsertConversation,
  upsertUnlessDeleted,
  type ChartSpec,
  type ChatEntry,
  type Conversation,
} from '../lib/chatHistory';
import { readChatStream, type ChatMode } from '../lib/chatStream';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type RadarSettings as RadarSettingsState } from '../lib/radarSettings';
import { buildSnapshot } from '../lib/snapshot';
import { pickThinkingWord } from '../lib/thinkingWords';
import type { DashboardData } from '../types';

function getStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

interface ReplyPayload {
  reply?: unknown;
  usedWeb?: unknown;
  sources?: unknown;
  charts?: unknown;
  exports?: unknown;
}

/** Builds the stored assistant entry from a chat reply payload (streamed result or plain JSON body). */
function entryFromPayload(payload: ReplyPayload): ChatEntry {
  const entry: ChatEntry = { role: 'assistant', content: payload.reply as string };
  if (payload.usedWeb === true) {
    entry.usedWeb = true;
    entry.sources = sanitizeSources(payload.sources);
  }
  const charts: ChartSpec[] = sanitizeCharts(payload.charts);
  if (charts.length > 0) entry.charts = charts;
  const exports = sanitizeExports(payload.exports);
  if (exports.length > 0) entry.exports = exports;
  return entry;
}

function ThinkingIndicator({ mode }: { mode: ChatMode | null }) {
  const [word, setWord] = useState(() => pickThinkingWord(null));
  const searching = mode === 'web';

  useEffect(() => {
    if (searching) return;
    const id = setInterval(() => setWord((previous) => pickThinkingWord(previous)), 1800);
    return () => clearInterval(id);
  }, [searching]);

  return (
    <div className="flex justify-start">
      <div
        aria-label="Radar is thinking"
        className="flex items-center gap-1.5 rounded-2xl bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-500"
      >
        {searching && <IconGlobe className="h-3.5 w-3.5" />}
        <span className="sr-only">{searching ? 'Radar is searching the web' : 'Radar is thinking'}</span>
        <span aria-hidden="true" className="text-shimmer [--shimmer-base:#94a3b8] [--shimmer-hi:#1e293b]">
          {searching ? 'Searching the web' : word}…
        </span>
      </div>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function EditBox({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim()) onSubmit(text);
    }
  }

  return (
    <div className="w-full rounded-2xl bg-slate-100 p-3">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        aria-label="Edit your message"
        className="max-h-48 w-full resize-none bg-transparent text-sm leading-relaxed text-slate-800 outline-none"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel edit"
          title="Cancel"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50"
        >
          <IconClose className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => text.trim() && onSubmit(text)}
          disabled={!text.trim()}
          aria-label="Send edited message"
          title="Send"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-40"
        >
          <IconSend className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  conversation,
  isLast,
  copied,
  editing,
  busy,
  onCopy,
  onRegenerate,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  message: ChatEntry;
  conversation: ChatEntry[];
  isLast: boolean;
  copied: boolean;
  editing: boolean;
  busy: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
}) {
  const isUser = message.role === 'user';
  const copyIcon = copied ? <IconCheck className="h-4 w-4" /> : <IconCopy className="h-4 w-4" />;

  if (isUser && editing) {
    return (
      <div className="w-full">
        <EditBox initial={message.content} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
      </div>
    );
  }

  return (
    <div className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={clsx('group flex flex-col gap-1', isUser ? 'max-w-[85%] items-end' : 'w-full')}>
        {isUser ? (
          <p
            aria-label="You"
            className="whitespace-pre-wrap rounded-2xl bg-brand-600 px-4 py-2.5 text-sm leading-relaxed text-white"
          >
            {message.content}
          </p>
        ) : (
          <div aria-label="Radar" className="space-y-2 rounded-2xl bg-slate-100 px-4 py-2.5">
            <MessageMarkdown content={message.content} />
            {(message.charts ?? []).map((chart, i) => (
              <ChartCard key={i} chart={chart} />
            ))}
            {(message.exports ?? []).map((offer, i) => (
              <ExportCard key={i} offer={offer} messages={conversation} />
            ))}
            <SourceList sources={message.sources ?? []} usedWeb={message.usedWeb === true} />
          </div>
        )}

        <div
            className={clsx(
              'mt-0.5 flex items-center gap-0.5',
              isUser && 'opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100',
            )}
          >
            <ActionButton label={copied ? 'Copied' : 'Copy'} onClick={onCopy}>
              {copyIcon}
            </ActionButton>
            {isUser && (
              <ActionButton label="Edit" onClick={onStartEdit} disabled={busy}>
                <IconEdit className="h-4 w-4" />
              </ActionButton>
            )}
            {!isUser && isLast && (
              <ActionButton label="Regenerate" onClick={onRegenerate} disabled={busy}>
                <IconRefresh className="h-4 w-4" />
              </ActionButton>
            )}
          </div>
      </div>
    </div>
  );
}

interface ChatWidgetProps {
  open: boolean;
  onClose: () => void;
  data: DashboardData | null;
}

export function ChatWidget({ open, onClose, data }: ChatWidgetProps) {
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const storage = getStorage();
    return storage ? loadHistory(storage) : [];
  });
  const [activeId, setActiveId] = useState(() => createId());
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMode, setLoadingMode] = useState<ChatMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<RadarSettingsState>(() => {
    const storage = getStorage();
    return storage ? loadSettings(storage) : DEFAULT_SETTINGS;
  });
  const [pendingAlerts, setPendingAlerts] = useState<number | null>(null);
  const requestRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const deletedIdsRef = useRef(new Set<string>());
  const abortRef = useRef<AbortController | null>(null);

  const snapshot = useMemo(() => (data ? buildSnapshot(data, pendingAlerts) : []), [data, pendingAlerts]);

  useEffect(() => {
    const storage = getStorage();
    if (storage) saveHistory(storage, conversations);
  }, [conversations]);

  useEffect(() => {
    const storage = getStorage();
    if (storage) saveSettings(storage, settings);
  }, [settings]);

  // Today's pending-alert count is only worth fetching while the panel is open and the snapshot is shown.
  useEffect(() => {
    if (!open || !settings.snapshot) return;
    let cancelled = false;
    fetch('/api/hitl-status')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('hitl-status unavailable'))))
      .then((body: { statuses?: Record<string, unknown> }) => {
        if (cancelled) return;
        const total = data?.geoAnalysis?.hitl?.alerts?.length ?? 0;
        const decided = body.statuses ? Object.keys(body.statuses).length : 0;
        setPendingAlerts(total - decided);
      })
      .catch(() => {
        if (!cancelled) setPendingAlerts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, settings.snapshot, data]);

  useEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    // Empty state stays at the top so the open screen is visible; conversations follow the latest message.
    if (messages.length === 0) list.scrollTo({ top: 0 });
    else list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [messages, loading, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else {
      setHistoryOpen(false);
      setSettingsOpen(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || editingIndex !== null) return;
      if (settingsOpen) setSettingsOpen(false);
      else if (historyOpen) setHistoryOpen(false);
      else onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, historyOpen, settingsOpen, editingIndex, onClose]);

  async function requestReply(base: ChatEntry[]) {
    const conversationId = activeId;
    const token = ++requestRef.current;
    setMessages(base);
    setConversations((prev) => upsertConversation(prev, { id: conversationId, messages: base }));
    setError(null);
    setLoading(true);
    setLoadingMode(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: toApiMessages(base), webEnabled: settings.liveNews, stream: true }),
        signal: controller.signal,
      });

      let payload: ReplyPayload;

      if (response.body && response.headers.get('content-type')?.includes('application/x-ndjson')) {
        const outcome: { result: ReplyPayload | null; error: string | null } = { result: null, error: null };
        await readChatStream(response.body, (event) => {
          if (event.type === 'mode') {
            if (requestRef.current === token) setLoadingMode(event.mode);
          } else if (event.type === 'result') {
            outcome.result = event;
          } else {
            outcome.error = event.error;
          }
        });
        if (!outcome.result) {
          if (requestRef.current === token) setError(outcome.error ?? 'chat unavailable, try again');
          return;
        }
        payload = outcome.result;
      } else {
        const body = await response.json();
        if (!response.ok) {
          if (requestRef.current === token) setError(body.error ?? 'chat unavailable, try again');
          return;
        }
        payload = body;
      }

      const withReply: ChatEntry[] = [...base, entryFromPayload(payload)];
      setConversations((prev) =>
        upsertUnlessDeleted(prev, { id: conversationId, messages: withReply }, deletedIdsRef.current),
      );
      if (requestRef.current === token) setMessages(withReply);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        /* user-initiated stop: no error message */
      } else if (requestRef.current === token) {
        setError('chat unavailable, try again');
      }
    } finally {
      if (requestRef.current === token) {
        setLoading(false);
        setLoadingMode(null);
      }
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function send(override?: string) {
    const text = (override ?? input).trim();
    if (!text || loading) return;
    setInput('');
    void requestReply([...messages, { role: 'user', content: text }]);
  }

  function regenerate(index: number) {
    const base = truncateForRegenerate(messages, index);
    if (!base || loading) return;
    void requestReply(base);
  }

  function submitEdit(index: number, text: string) {
    const base = truncateForEdit(messages, index, text);
    if (!base || loading) return;
    setEditingIndex(null);
    void requestReply(base);
  }

  function startFreshChat() {
    requestRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setLoadingMode(null);
    setActiveId(createId());
    setMessages([]);
    setInput('');
    setError(null);
    setEditingIndex(null);
  }

  function selectConversation(id: string) {
    setHistoryOpen(false);
    if (id === activeId) return;
    const conversation = conversations.find((c) => c.id === id);
    if (!conversation) return;
    requestRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setLoadingMode(null);
    setActiveId(id);
    setMessages(conversation.messages);
    setError(null);
    setEditingIndex(null);
  }

  function stop() {
    abortRef.current?.abort();
  }

  function removeConversation(id: string) {
    deletedIdsRef.current.add(id);
    setConversations((prev) => deleteConversation(prev, id));
    if (id === activeId) startFreshChat();
  }

  async function copyMessage(index: number, content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex((i) => (i === index ? null : i)), 1500);
    } catch {
      /* clipboard unavailable, no-op */
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') send();
  }

  const headerButton =
    'flex h-10 w-10 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600';

  return (
    <>
      {open && <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />}

      <div
        id="radar-panel"
        role="dialog"
        aria-label="Radar"
        inert={!open}
        aria-hidden={!open}
        className={clsx(
          'fixed inset-y-3 right-3 z-50 flex w-[calc(100vw-1.5rem)] max-w-xl flex-col gap-3',
          'transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          open ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-[calc(100%+1.5rem)] opacity-0',
        )}
      >
        <div className="flex shrink-0 items-center justify-between rounded-2xl border border-slate-200 bg-white py-2.5 pl-5 pr-2 shadow-[0_8px_30px_rgba(15,23,42,0.12)]">
          <p className="text-base font-semibold text-slate-900">Radar</p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setSettingsOpen(true);
                setHistoryOpen(false);
              }}
              aria-label="Settings"
              title="Settings"
              className={headerButton}
            >
              <IconGear className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setHistoryOpen(true);
                setSettingsOpen(false);
              }}
              aria-label="History"
              title="History"
              className={headerButton}
            >
              <IconHistory className="h-5 w-5" />
            </button>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={startFreshChat}
                aria-label="New chat"
                title="New chat"
                className={headerButton}
              >
                <IconNewChat className="h-5 w-5" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Radar"
              title="Close Radar"
              className={`${headerButton} hover:bg-red-50 hover:text-red-600`}
            >
              <IconClose className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div
            ref={listRef}
            role="log"
            aria-live="polite"
            className="scrollbar-hidden h-full space-y-5 overflow-y-auto px-5 pb-32 pt-4"
          >
            {messages.length === 0 && (
              <ChatOpenScreen settings={settings} snapshot={snapshot} onPick={(q) => send(q)} disabled={loading} />
            )}
            {messages.map((m, i) => (
              <MessageRow
                key={`${activeId}-${i}`}
                message={m}
                conversation={messages}
                isLast={i === messages.length - 1}
                copied={copiedIndex === i}
                editing={editingIndex === i}
                busy={loading}
                onCopy={() => copyMessage(i, m.content)}
                onRegenerate={() => regenerate(i)}
                onStartEdit={() => setEditingIndex(i)}
                onCancelEdit={() => setEditingIndex(null)}
                onSubmitEdit={(text) => submitEdit(i, text)}
              />
            ))}
            {loading && <ThinkingIndicator mode={loadingMode} />}
            {error && <div className="text-sm text-red-600">{error}</div>}
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-white from-55% to-transparent px-4 pb-4 pt-12">
            <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1.5 pl-4 pr-1.5 shadow-[0_8px_30px_rgba(15,23,42,0.12)] transition focus-within:border-brand-500">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={loading}
                placeholder="Ask Radar about this dashboard"
                className="flex-1 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400 disabled:opacity-60"
              />
              {loading ? (
                <button
                  onClick={stop}
                  disabled={false}
                  aria-label="Stop"
                  title="Stop"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-700 text-white transition hover:bg-slate-800"
                >
                  <IconStop className="h-4 w-4" />
                </button>
              ) : (
                <button
                  onClick={() => send()}
                  disabled={!input.trim()}
                  aria-label="Send message"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-40"
                >
                  <IconSend className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {settingsOpen && (
            <RadarSettings settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />
          )}
        </div>

        <ChatHistoryPanel
          open={historyOpen}
          conversations={conversations}
          activeId={activeId}
          onSelect={selectConversation}
          onTogglePin={(id) => setConversations((prev) => togglePin(prev, id))}
          onDelete={removeConversation}
          onClose={() => setHistoryOpen(false)}
        />
      </div>
    </>
  );
}
