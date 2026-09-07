import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { Driver, DriverStatus, ParameterCatalogue } from '../types';
import { IconChevronRight, IconLayers } from './Icons';

const STATUS_DOT: Record<DriverStatus, string> = {
  implemented: 'bg-emerald-500',
  available: 'bg-blue-500',
  roadmap: 'bg-slate-300',
};

const STATUS_LABEL: Record<DriverStatus, string> = {
  implemented: 'Live',
  available: 'Available',
  roadmap: 'Roadmap',
};

const EFFORT_TEXT: Record<string, string> = {
  low: 'text-emerald-600',
  medium: 'text-amber-600',
  high: 'text-red-600',
};

/**
 * Catalogue of drivers that could feed component price forecasting.
 *
 * Kept deliberately dense: this is a reference list of ~40 items, so every row
 * is one line until opened. Detail lives behind the row rather than in front of
 * it, otherwise the list becomes unscannable and the reader loses the shape of
 * the space — which is the whole point of showing it.
 *
 * Scope is stated once, compactly: most of these are not built. The `Live` flag
 * is verified against the model's real feature list on the Python side.
 */
export function ParametersModal({
  catalogue,
  onClose,
}: {
  catalogue?: ParameterCatalogue;
  onClose: () => void;
}) {
  const [group, setGroup] = useState('All');
  const [status, setStatus] = useState<DriverStatus | 'all'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  // Groups start collapsed so the whole ~40-item space fits on one screen as
  // ten headings. Expanding is cheap; scrolling past forty rows to find the
  // group you wanted is not.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const drivers = catalogue?.drivers ?? [];

  const visible = useMemo(
    () =>
      drivers.filter(
        (d) =>
          (group === 'All' || d.group === group) &&
          (status === 'all' || d.status === status),
      ),
    [drivers, group, status],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, Driver[]>();
    for (const d of visible) {
      if (!map.has(d.group)) map.set(d.group, []);
      map.get(d.group)!.push(d);
    }
    return map;
  }, [visible]);

  const counts = catalogue?.counts;

  return (
    // Overlay is a non-scrolling flex container; the panel owns its own height
    // and scrolls internally. Letting the overlay scroll pushes the header off
    // screen, which is what made this unusable.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Forecasting parameters"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ---- Header (fixed) -------------------------------------------- */}
        <div className="shrink-0 border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
              <IconLayers className="h-4 w-4 text-brand-600" />
              Forecasting Parameters
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              aria-label="Close"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
            <span className="font-medium text-slate-700">{catalogue?.total ?? 0} drivers</span>{' '}
            catalogued. Monthly relevance gate keeps{' '}
            <span className="font-medium text-emerald-700">
              {catalogue?.selection?.nSelected ?? counts?.implemented ?? 0} in this month&apos;s
              model
            </span>
            {catalogue?.selection?.nRejected != null && catalogue.selection.nRejected > 0 && (
              <>
                {' '}
                (rejected {catalogue.selection.nRejected} engineered columns)
              </>
            )}
            . The rest define the extension path.
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <select
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-700"
            >
              <option value="All">All groups</option>
              {catalogue?.groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-0.5 rounded-md bg-slate-100 p-0.5">
              {(['all', 'implemented', 'available', 'roadmap'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={clsx(
                    'flex items-center gap-1.5 rounded px-2 py-1 text-[12px] transition',
                    status === s
                      ? 'bg-white font-medium text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900',
                  )}
                >
                  {s !== 'all' && (
                    <span className={clsx('h-1.5 w-1.5 rounded-full', STATUS_DOT[s])} />
                  )}
                  {s === 'all' ? 'All' : STATUS_LABEL[s]}
                  <span className="text-slate-400">
                    {s === 'all' ? drivers.length : (counts?.[s] ?? 0)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ---- Body (scrolls) -------------------------------------------- */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 && (
            <p className="py-10 text-center text-[13px] text-slate-500">
              Nothing matches this filter.
            </p>
          )}

          {[...grouped.entries()].map(([groupName, items]) => {
            // Applying a filter is an explicit request to see results, so
            // narrowed views expand by default rather than leaving the reader
            // staring at collapsed headings.
            const filtering = status !== 'all' || group !== 'All';
            const groupOpen = filtering || openGroups.has(groupName);
            const liveCount = items.filter((d) => d.status === 'implemented').length;
            return (
            <div key={groupName}>
              <button
                type="button"
                onClick={() => {
                  const next = new Set(openGroups);
                  next.has(groupName) ? next.delete(groupName) : next.add(groupName);
                  setOpenGroups(next);
                }}
                className="flex w-full items-center gap-2 border-b border-slate-100 bg-slate-50 px-5 py-2 text-left transition hover:bg-slate-100"
              >
                <IconChevronRight
                  className={clsx(
                    'h-3 w-3 shrink-0 text-slate-400 transition-transform',
                    groupOpen && 'rotate-90',
                  )}
                />
                <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                  {groupName}
                </span>
                {liveCount > 0 && (
                  <span className="flex items-center gap-1 text-[10px] text-emerald-600">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    {liveCount} live
                  </span>
                )}
                <span className="w-6 text-right text-[11px] text-slate-400">{items.length}</span>
              </button>

              {groupOpen && items.map((driver) => {
                const isOpen = openId === driver.id;
                return (
                  <div key={driver.id} className="border-b border-slate-100 last:border-0">
                    <button
                      type="button"
                      onClick={() => setOpenId(isOpen ? null : driver.id)}
                      className="flex w-full items-center gap-2.5 px-5 py-2 text-left transition hover:bg-slate-50"
                    >
                      <span
                        className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[driver.status])}
                        title={STATUS_LABEL[driver.status]}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-slate-800">
                        {driver.name}
                      </span>
                      <span
                        className={clsx('shrink-0 text-[11px]', EFFORT_TEXT[driver.effort])}
                        title="Integration effort"
                      >
                        {driver.effort}
                      </span>
                      <span className="w-14 shrink-0 text-right text-[11px] text-slate-400">
                        {STATUS_LABEL[driver.status]}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="space-y-2 bg-slate-50/70 px-5 py-3 pl-10 text-[12px] leading-relaxed">
                        <p className="text-slate-700">{driver.description}</p>

                        <p className="text-slate-600">
                          <span className="font-semibold text-slate-700">Reaches price via:</span>{' '}
                          {driver.impact_channel}
                        </p>

                        <p className="text-slate-500">
                          <span className="font-semibold text-slate-700">Example:</span>{' '}
                          {driver.example}
                        </p>

                        {driver.matchedFeatures?.length ? (
                          <p className="text-slate-600">
                            <span className="font-semibold text-slate-700">In model:</span>{' '}
                            <span className="font-mono text-[11px] text-emerald-700">
                              {driver.matchedFeatureCount} features
                            </span>
                          </p>
                        ) : null}

                        {driver.selectionNote ? (
                          <p className="text-slate-600">
                            <span className="font-semibold text-slate-700">This month:</span>{' '}
                            {driver.selectionNote}
                          </p>
                        ) : null}

                        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
                          {driver.sources.map((s) => (
                            <span key={s.provider} className="text-[11px] text-slate-500">
                              <span className="text-slate-700">{s.provider}</span>
                              <span
                                className={clsx(
                                  'ml-1',
                                  s.access === 'free'
                                    ? 'text-emerald-600'
                                    : s.access === 'paid'
                                      ? 'text-amber-600'
                                      : 'text-violet-600',
                                )}
                              >
                                {s.access}
                              </span>
                              <span className="ml-1 text-slate-400">
                                · {s.frequency}, {s.latency}
                              </span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Header button that opens the catalogue. */
export function ParametersButton({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 transition hover:border-brand-600 hover:text-brand-600"
    >
      <IconLayers className="h-4 w-4 text-slate-400" />
      Parameters
      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
        {count}
      </span>
    </button>
  );
}
