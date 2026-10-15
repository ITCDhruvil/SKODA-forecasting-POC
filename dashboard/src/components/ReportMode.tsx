import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { IconCheck, IconSend } from './Icons';

// POC: everything here is scripted. No request leaves the browser; the download is a pre-built deck.

type Format = 'ppt' | 'doc';

const FILES: Record<Format, { url: string; name: string; label: string; meta: string }> = {
  ppt: {
    url: '/reports/Auto_Parts_Price_Outlook.pptx',
    name: 'Auto_Parts_Price_Outlook.pptx',
    label: 'presentation',
    meta: '10 slides · 5 charts · 518 KB · 4 sources cited',
  },
  doc: {
    url: '/reports/Auto_Parts_Price_Outlook.docx',
    name: 'Auto_Parts_Price_Outlook.docx',
    label: 'document',
    meta: '6 sections · 4 figures · 110 KB · 4 sources cited',
  },
};

const EXAMPLES: Record<Format, string[]> = {
  ppt: [
    'Q4 price outlook for leadership, with vendor risks',
    'Category-wise cost movement for the next 6 months',
    'Supplier risk summary for the sourcing review',
  ],
  doc: [
    'Detailed price outlook report for the sourcing review',
    'Written summary of category cost movement with charts',
    'Supplier risk memo for the procurement head',
  ],
};

const SOURCES = ['Pricing Models', 'Category Cost Reports', 'Supplier Master', 'Market Intelligence'];

type Step = { label: string; detail: string; ms: number };

const COMMON_STEPS: Step[] = [
  { label: 'Understanding your request', detail: 'Audience: leadership. Scope: 6-month price outlook, vendor risk.', ms: 1200 },
  { label: 'Searching the knowledge base', detail: '14 documents matched across 4 connected sources.', ms: 1900 },
  { label: 'Reading and ranking passages', detail: '62 passages read, 23 kept as most relevant.', ms: 1800 },
  { label: 'Extracting figures and tables', detail: 'Basket forecast, category changes, vendor risk shares.', ms: 1700 },
];

const FORMAT_STEPS: Record<Format, Step[]> = {
  ppt: [
    { label: 'Drafting the slide outline', detail: '10 slides: summary, forecast, categories, spend mix, drivers, FX, vendors, next steps.', ms: 1600 },
    { label: 'Building slides and charts', detail: '5 charts, 1 table, 4 stat cards.', ms: 2200 },
    { label: 'Applying template and formatting', detail: 'Corporate theme, source notes on every slide.', ms: 1300 },
    { label: 'Final quality check', detail: 'Figures cross-checked against source documents.', ms: 1200 },
  ],
  doc: [
    { label: 'Drafting the document outline', detail: '6 sections: summary, forecast, categories, drivers, supplier risk, next steps.', ms: 1600 },
    { label: 'Writing sections and figures', detail: '4 charts, 1 table, 12 cited statements.', ms: 2200 },
    { label: 'Applying styles and page layout', detail: 'Headings, captions, page numbers, A4 layout.', ms: 1300 },
    { label: 'Final quality check', detail: 'Figures cross-checked against source documents.', ms: 1200 },
  ],
};

const stepsFor = (format: Format): Step[] => [...COMMON_STEPS, ...FORMAT_STEPS[format]];

type Phase = 'ask' | 'working' | 'done';

function Spinner() {
  return (
    <span
      className="block h-4 w-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent motion-reduce:animate-none"
      aria-hidden="true"
    />
  );
}

function DocThumb() {
  return (
    <div className="flex h-24 w-[72px] shrink-0 flex-col gap-1 rounded-sm bg-white p-2 shadow-md ring-1 ring-slate-200">
      <p className="font-serif text-[8px] font-bold leading-tight text-[#0B1F3A]">Auto Parts Price Outlook</p>
      <div className="h-1 w-full rounded bg-slate-200" />
      <div className="h-1 w-4/5 rounded bg-slate-200" />
      <div className="mt-1 h-6 w-full rounded-sm bg-brand-100" />
      <div className="h-1 w-full rounded bg-slate-200" />
    </div>
  );
}

function DeckThumb() {
  return (
    <div className="flex h-24 w-40 shrink-0 flex-col justify-center rounded-lg bg-[#0B1F3A] px-3 shadow-md">
      <p className="font-serif text-[13px] font-bold leading-tight text-white">Auto Parts Price Outlook</p>
      <p className="mt-1 text-[8px] leading-tight text-blue-200">Next 6 months: what moves, why, and who to call</p>
    </div>
  );
}

export function ReportMode({ onBack }: { onBack: () => void }) {
  const [phase, setPhase] = useState<Phase>('ask');
  const [format, setFormat] = useState<Format>('ppt');
  const steps = useMemo(() => stepsFor(format), [format]);
  const file = FILES[format];
  const totalMs = steps.reduce((n, st) => n + st.ms, 0);
  const [prompt, setPrompt] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [current, setCurrent] = useState(0);
  const [downloaded, setDownloaded] = useState(false);

  useEffect(() => {
    if (phase !== 'working') return;
    if (current >= steps.length) {
      setPhase('done');
      return;
    }
    const t = window.setTimeout(() => setCurrent((c) => c + 1), steps[current].ms);
    return () => window.clearTimeout(t);
  }, [phase, current, steps]);

  function start(text: string) {
    const value = text.trim();
    if (!value) return;
    setSubmitted(value);
    setCurrent(0);
    setDownloaded(false);
    setPhase('working');
  }

  function reset() {
    setPrompt('');
    setPhase('ask');
  }

  const doneMs = steps.slice(0, current).reduce((n, st) => n + st.ms, 0);
  const progress = phase === 'done' ? 100 : Math.round((doneMs / totalMs) * 100);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-white">
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-full px-3 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
        >
          ← Back to chat
        </button>
        <span className="ml-auto rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700">Report mode</span>
      </div>

      <div className="scrollbar-hidden flex-1 overflow-y-auto px-6 py-6">
        {phase === 'ask' && (
          <div className="flex flex-col gap-5">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">What report do you need?</h2>
              <p className="mt-1 text-sm text-slate-500">
                Ask in plain language. Radar builds a ready presentation or document from your connected knowledge base.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-200 p-3 transition focus-within:border-brand-500">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    start(prompt);
                  }
                }}
                rows={3}
                placeholder={format === 'ppt' ? 'e.g. Make a PPT on the next 6 months price outlook for leadership' : 'e.g. Write a report on the next 6 months price outlook with charts'}
                className="w-full resize-none bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
              />
              <div className="flex items-center justify-between">
                <div className="flex gap-1 rounded-full bg-slate-100 p-0.5 text-xs font-medium" role="group" aria-label="Report format">
                  {(['ppt', 'doc'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFormat(f)}
                      aria-pressed={format === f}
                      className={clsx(
                        'rounded-full px-3 py-1 transition',
                        format === f ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800',
                      )}
                    >
                      {f === 'ppt' ? 'PPT' : 'Document'}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => start(prompt)}
                  disabled={!prompt.trim()}
                  aria-label="Create report"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-40"
                >
                  <IconSend className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Try one of these</p>
              <div className="flex flex-col gap-2">
                {EXAMPLES[format].map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => setPrompt(ex)}
                    className="rounded-xl border border-slate-200 px-3 py-2 text-left text-sm text-slate-700 transition hover:border-brand-500 hover:bg-brand-50"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Connected knowledge base</p>
              <div className="flex flex-wrap gap-1.5">
                {SOURCES.map((s) => (
                  <span key={s} className="flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    {s}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {phase !== 'ask' && (
          <div className="flex flex-col gap-5">
            <div className="rounded-2xl bg-slate-100 px-4 py-2.5 text-sm text-slate-800">{submitted}</div>

            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs text-slate-500">
                <span>{phase === 'done' ? 'Report ready' : 'Creating your report'}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand-600 transition-[width] duration-700 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            <ol className="flex flex-col gap-3">
              {steps.map((step, i) => {
                const state = i < current ? 'done' : i === current ? 'active' : 'todo';
                return (
                  <li
                    key={step.label}
                    className={clsx(
                      'flex items-start gap-3 transition-opacity duration-300',
                      state === 'todo' && 'opacity-35',
                    )}
                  >
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                      {state === 'done' && <IconCheck className="h-5 w-5 text-emerald-500" />}
                      {state === 'active' && <Spinner />}
                      {state === 'todo' && <span className="h-2 w-2 rounded-full bg-slate-300" />}
                    </span>
                    <div className="min-w-0">
                      <p className={clsx('text-sm', state === 'active' ? 'font-medium text-slate-900' : 'text-slate-700')}>
                        {step.label}
                      </p>
                      {state !== 'todo' && <p className="mt-0.5 text-xs text-slate-500">{step.detail}</p>}
                      {i === 1 && state !== 'todo' && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {SOURCES.map((s) => (
                            <span key={s} className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] text-brand-700">
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

            {phase === 'done' && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4">
                <p className="text-sm font-semibold text-slate-900">Your {file.label} is ready</p>
                <div className="mt-3 flex items-center gap-4">
                  {format === 'ppt' ? <DeckThumb /> : <DocThumb />}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">{file.name}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{file.meta}</p>
                    <a
                      href={file.url}
                      download={file.name}
                      onClick={() => setDownloaded(true)}
                      className="mt-3 inline-flex items-center gap-2 rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700"
                    >
                      {format === 'ppt' ? 'Download PPT' : 'Download Word document'}
                    </a>
                  </div>
                </div>
                {downloaded && (
                  <p className="mt-3 text-xs text-emerald-700">Downloaded. Check your Downloads folder.</p>
                )}
                <button type="button" onClick={reset} className="mt-3 text-xs text-slate-500 underline hover:text-slate-800">
                  Create another report
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
