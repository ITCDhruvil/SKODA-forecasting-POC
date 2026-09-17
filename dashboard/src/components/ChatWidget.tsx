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
