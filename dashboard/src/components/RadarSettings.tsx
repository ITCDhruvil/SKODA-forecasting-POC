import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { IconClose } from './Icons';
import type { RadarSettings as Settings } from '../lib/radarSettings';
import { tokenLabelFor, type UsageStats } from '../lib/tokenLabels';

const ROWS: { key: keyof Settings; name: string; description: string }[] = [
  { key: 'snapshot', name: "Today's snapshot", description: 'Four key numbers from your dashboard data.' },
  {
    key: 'news',
    name: 'Impact news of the day',
    description: 'Fetched once a day on first open and stored, so everyone reads the same brief.',
  },
  { key: 'situations', name: 'Situation questions', description: 'Real business scenarios to start a chat.' },
  {
    key: 'liveNews',
    name: 'Live news in answers',
    description: 'Searches trusted sources only when a question needs current information.',
  },
];

/** True when `value` has the shape of `UsageStats` (loosely: an object, three optional/null-able fields). */
function isUsageStats(value: unknown): value is UsageStats {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return 'briefing' in v && 'webAnswer' in v && 'dataAnswer' in v;
}

function SettingSwitch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={clsx(
        'relative h-5 w-[34px] shrink-0 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600',
        checked ? 'bg-brand-600' : 'bg-slate-300',
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform',
          checked ? 'translate-x-[14px]' : 'translate-x-0',
        )}
      />
    </button>
  );
}

interface RadarSettingsProps {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
}

/** Settings overlay: one switch per Radar feature, with an approximate token cost pulled from real usage. */
export function RadarSettings({ settings, onChange, onClose }: RadarSettingsProps) {
  const [usage, setUsage] = useState<UsageStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/usage')
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        if (!cancelled && isUsageStats(body)) setUsage(body);
      })
      .catch(() => {
        /* usage unavailable: labels fall back to "not measured yet" */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(key: keyof Settings) {
    onChange({ ...settings, [key]: !settings[key] });
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <p className="text-sm font-semibold text-slate-900">Radar settings</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          title="Close settings"
          className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      <div className="scrollbar-hidden flex-1 overflow-y-auto px-5">
        <div className="flex flex-col divide-y divide-slate-100">
          {ROWS.map((row) => (
            <div key={row.key} className="flex items-start justify-between gap-3 py-3.5">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-slate-900">{row.name}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{row.description}</p>
                <span className="mt-1.5 inline-block rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                  {tokenLabelFor(row.key, usage)}
                </span>
              </div>
              <SettingSwitch checked={settings[row.key]} onChange={() => toggle(row.key)} label={row.name} />
            </div>
          ))}
        </div>
      </div>

      <p className="border-t border-slate-100 px-5 py-3 text-[11px] leading-relaxed text-slate-400">
        Token figures are approximate and come from real usage. Settings are saved in this browser.
      </p>
    </div>
  );
}
