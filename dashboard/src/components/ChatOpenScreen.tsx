import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  isFresh,
  loadCachedBriefing,
  parseBriefingResponse,
  saveCachedBriefing,
  type Briefing,
  type Impact,
} from '../lib/briefing';
import type { RadarSettings } from '../lib/radarSettings';
import type { SnapshotTile } from '../lib/snapshot';
import { SITUATIONS } from '../lib/situations';

function getStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** A cached briefing for today or yesterday (server day-boundary slack) that is still fresh, or null. */
function readFreshCachedBriefing(storage: Storage): Briefing | null {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 3_600_000);
  const candidate = loadCachedBriefing(storage, localDateKey(now)) ?? loadCachedBriefing(storage, localDateKey(yesterday));
  return candidate && isFresh(candidate, now) ? candidate : null;
}

function todayLabel(): string {
  const now = new Date();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'short' });
  const month = now.toLocaleDateString('en-US', { month: 'short' });
  return `Today · ${weekday} ${now.getDate()} ${month}`;
}

function formatUpdatedTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
}

function formatItemDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return dateStr;
  try {
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

const MAX_POLLS = 8;
const POLL_INTERVAL_MS = 4_000;

type BriefingUiState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'pending' }
  | { kind: 'pending-exhausted' }
  | { kind: 'error' }
  | { kind: 'disabled' }
  | { kind: 'ready'; briefing: Briefing };

/**
 * Loads today's impact briefing once per mount when `enabled`: a fresh cache hit skips the network entirely (this
 * is what keeps a browser with the toggle off, or one that already has today's brief, from triggering generation);
 * otherwise it fetches once, polling on `pending` up to `MAX_POLLS` times. Never fetches while `enabled` is false.
 */
function useDailyBriefing(enabled: boolean): BriefingUiState {
  const [state, setState] = useState<BriefingUiState>({ kind: 'idle' });

  useEffect(() => {
    if (!enabled) {
      setState({ kind: 'idle' });
      return;
    }

    const storage = getStorage();
    if (storage) {
      const cached = readFreshCachedBriefing(storage);
      if (cached) {
        setState({ kind: 'ready', briefing: cached });
        return;
      }
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let attempts = 0;

    async function poll() {
      attempts += 1;
      try {
        const response = await fetch('/api/briefing', { signal: controller.signal });
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        if (cancelled) return;

        const result = parseBriefingResponse(response.status, body);
        if (result.kind === 'ready') {
          setState({ kind: 'ready', briefing: result.briefing });
          if (storage) saveCachedBriefing(storage, result.briefing);
        } else if (result.kind === 'disabled') {
          setState({ kind: 'disabled' });
        } else if (result.kind === 'pending') {
          if (attempts >= MAX_POLLS) {
            setState({ kind: 'pending-exhausted' });
          } else {
            setState({ kind: 'pending' });
            pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
          }
        } else {
          setState({ kind: 'error' });
        }
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    }

    setState({ kind: 'loading' });
    void poll();

    return () => {
      cancelled = true;
      controller.abort();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [enabled]);

  return state;
}

const IMPACT_META: Record<Impact, { dot: string; label: string }> = {
  cost_up: { dot: 'bg-rose-600', label: 'Cost up' },
  watch: { dot: 'bg-amber-500', label: 'Watch' },
  cost_down: { dot: 'bg-emerald-600', label: 'Cost down' },
};

function ImpactDot({ impact }: { impact: Impact }) {
  const meta = IMPACT_META[impact];
  return (
    <span className="mt-1.5 inline-flex shrink-0 items-center">
      <span className={clsx('block h-[7px] w-[7px] rounded-full', meta.dot)} />
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}

function NewsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex animate-pulse flex-col gap-1.5 motion-reduce:animate-none">
          <div className="h-3 w-4/5 rounded bg-slate-100" />
          <div className="h-2.5 w-2/5 rounded bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

function NewsBody({ state }: { state: BriefingUiState }) {
  if (state.kind === 'loading' || state.kind === 'pending') return <NewsSkeleton />;
  if (state.kind === 'pending-exhausted') {
    return <p className="text-[11px] text-slate-400">Today's impact news is still being prepared.</p>;
  }
  if (state.kind === 'error') {
    return <p className="text-[11px] text-slate-400">Today's impact news isn't available right now.</p>;
  }
  if (state.kind !== 'ready') return null;

  return (
    <ul className="flex flex-col gap-3">
      {state.briefing.items.map((item, i) => (
        <li key={`${i}-${item.url}`} className="flex items-start gap-2">
          <ImpactDot impact={item.impact} />
          <div className="min-w-0 flex-1">
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] leading-snug text-slate-800 hover:underline"
            >
              {item.headline}
            </a>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {item.why} · {item.outlet} · {formatItemDate(item.date)}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function SnapshotTileCard({ tile }: { tile: SnapshotTile }) {
  const toneClass = tile.tone === 'up' ? 'text-emerald-600' : tile.tone === 'down' ? 'text-rose-600' : 'text-slate-500';
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-[11px] text-slate-500">{tile.label}</p>
      <p className="text-[17px] font-medium text-slate-900">{tile.value}</p>
      {tile.note && <p className={clsx('text-[11px]', toneClass)}>{tile.note}</p>}
    </div>
  );
}

interface ChatOpenScreenProps {
  settings: RadarSettings;
  snapshot: SnapshotTile[];
  onPick: (q: string) => void;
  disabled?: boolean;
}

/** Minimal open screen shown before the first message: today's snapshot, impact news, and situations to try. */
export function ChatOpenScreen({ settings, snapshot, onPick, disabled }: ChatOpenScreenProps) {
  const briefingState = useDailyBriefing(settings.news);
  const showSnapshot = settings.snapshot && snapshot.length > 0;
  const showNews = settings.news && briefingState.kind !== 'disabled';
  const showSituations = settings.situations;
  const allOff = !settings.snapshot && !settings.news && !settings.situations;

  if (allOff) {
    return (
      <section aria-label="Ask Radar" className="px-1 py-6 text-sm text-slate-400">
        Ask Radar about your forecast, alerts or the news.
      </section>
    );
  }

  return (
    <section aria-label="Open screen" className="flex flex-col gap-6">
      {showSnapshot && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-400">{todayLabel()}</p>
          <div className="grid grid-cols-2 gap-2">
            {snapshot.map((tile) => (
              <SnapshotTileCard key={tile.id} tile={tile} />
            ))}
          </div>
        </div>
      )}

      {showNews && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-400">
            Impact news
            {briefingState.kind === 'ready' && ` · Updated ${formatUpdatedTime(briefingState.briefing.generatedAt)}`}
          </p>
          <NewsBody state={briefingState} />
        </div>
      )}

      {showSituations && (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] uppercase tracking-wide text-slate-400">Try a situation</p>
          <div className="flex flex-col divide-y divide-slate-100">
            {SITUATIONS.map((s) => (
              <button
                key={s.label}
                type="button"
                disabled={disabled}
                onClick={() => onPick(s.question)}
                className="w-full rounded-sm py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:opacity-50"
              >
                <span className="block text-[11px] text-brand-600">{s.label}</span>
                <span className="block text-[13px] leading-snug text-slate-800">{s.question}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
