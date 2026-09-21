import { useId, useState } from 'react';
import clsx from 'clsx';
import type { ChatSource } from '../lib/chatHistory';
import { IconChevronRight, IconGlobe } from './Icons';

/** Collapsible "Searched the web" row with one chip per cited source. Renders nothing for non-web answers. */
export function SourceList({ sources, usedWeb }: { sources: ChatSource[]; usedWeb: boolean }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!usedWeb) return null;

  const count = sources.length;
  if (count === 0) {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
        <IconGlobe className="h-3.5 w-3.5 text-brand-600" />
        Searched the web
      </p>
    );
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className="-ml-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
      >
        <IconGlobe className="h-3.5 w-3.5 text-brand-600" />
        {`Searched the web · ${count} source${count === 1 ? '' : 's'}`}
        <IconChevronRight className={clsx('h-3 w-3 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <ul id={listId} className="mt-2 flex flex-wrap gap-1.5">
          {sources.map((s, i) => (
            <li key={s.url} className="max-w-full">
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                title={s.title}
                className="flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-500 transition hover:border-brand-500/40 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
              >
                <span className="font-semibold text-slate-400">{i + 1}</span>
                <span className="min-w-0 max-w-[9rem] truncate font-medium text-slate-700">{s.domain}</span>
                <span className="min-w-0 truncate">{s.title}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
