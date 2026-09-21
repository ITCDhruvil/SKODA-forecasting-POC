import type { ChatSource } from '../lib/chatHistory';
import { IconGlobe } from './Icons';

/** "Searched the web" badge plus one chip per cited source. Renders nothing for non-web answers. */
export function SourceList({ sources, usedWeb }: { sources: ChatSource[]; usedWeb: boolean }) {
  if (!usedWeb) return null;
  const count = sources.length;
  return (
    <div className="mt-1 flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
        <IconGlobe className="h-3.5 w-3.5 text-brand-600" />
        Searched the web{count > 0 ? ` · ${count} source${count === 1 ? '' : 's'}` : ''}
      </p>
      {count > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {sources.map((s, i) => (
            <li key={s.url} className="max-w-full">
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                title={s.title}
                className="flex max-w-full items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-500 transition hover:border-brand-500/40 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
              >
                <span className="font-semibold text-slate-400">{i + 1}</span>
                <span className="shrink-0 font-medium text-slate-700">{s.domain}</span>
                <span className="truncate">{s.title}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
