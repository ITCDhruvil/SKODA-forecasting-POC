import { useEffect, useRef, useState } from 'react';
import { IconChat, IconClose, IconCopy, IconSend } from './Icons';

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
}

function TypingIndicator() {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 h-7 w-7 shrink-0 rounded-full bg-brand-600" />
      <div className="flex flex-col gap-1 pt-1.5">
        <span className="text-xs font-semibold text-slate-500">Assistant</span>
        <div className="flex items-center gap-1 py-1">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300 [animation-delay:-0.3s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300 [animation-delay:-0.15s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300" />
        </div>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  onCopy,
  copied,
}: {
  message: ChatEntry;
  onCopy: () => void;
  copied: boolean;
}) {
  const isUser = message.role === 'user';
  return (
    <div className="flex items-start gap-3">
      <div
        className={
          isUser ? 'mt-0.5 h-7 w-7 shrink-0 rounded-full bg-slate-300' : 'mt-0.5 h-7 w-7 shrink-0 rounded-full bg-brand-600'
        }
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-xs font-semibold text-slate-500">{isUser ? 'You' : 'Assistant'}</span>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{message.content}</p>
        {!isUser && (
          <button
            type="button"
            onClick={onCopy}
            className="mt-1 flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-xs text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <IconCopy className="h-3.5 w-3.5" />
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
    </div>
  );
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open, loading]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

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

  function clearChat() {
    setMessages([]);
    setError(null);
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6 backdrop-blur-sm md:p-10"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <p className="text-sm font-semibold text-slate-900">Ask about this dashboard</p>
              <div className="flex items-center gap-1">
                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={clearChat}
                    className="rounded-md px-2 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                  >
                    Clear chat
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close chat"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                >
                  <IconClose className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div role="log" aria-live="polite" className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
              {messages.length === 0 && (
                <p className="text-sm text-slate-400">
                  Ask about forecasts, alerts, validation, scenarios, or how to use this tool.
                </p>
              )}
              {messages.map((m, i) => (
                <MessageRow
                  key={i}
                  message={m}
                  onCopy={() => copyMessage(i, m.content)}
                  copied={copiedIndex === i}
                />
              ))}
              {loading && <TypingIndicator />}
              {error && <div className="text-sm text-red-600">{error}</div>}
              <div ref={bottomRef} />
            </div>

            <div className="border-t border-slate-200 p-4">
              <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 py-1.5 pl-4 pr-1.5">
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={loading}
                  placeholder="Send a message about this dashboard"
                  className="flex-1 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400 disabled:opacity-60"
                />
                <button
                  onClick={send}
                  disabled={loading || !input.trim()}
                  aria-label="Send message"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-40"
                >
                  <IconSend className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
