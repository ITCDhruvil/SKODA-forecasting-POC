import { useMemo } from 'react';
import clsx from 'clsx';
import type { MaterialWaterfallStep } from '../types';
import { formatSigned, formatSpend } from '../lib/format';

/** Short plain-language labels — no finance jargon in the primary UI. */
const DRIVER_SHORT: Record<string, string> = {
  fx: 'Currency',
  commodity: 'Materials',
  freight: 'Shipping',
  vendorReprice: 'Vendor price changes',
  mix: 'Part mix',
  seasonality: 'Seasonality',
  unexplained: 'Other changes',
  other: 'Other changes',
};

const DRIVER_HELP: Record<string, string> = {
  fx: 'FX rate moves passed into piece price',
  commodity: 'Steel / aluminium / copper / energy',
  freight: 'Shipping cost vs import-heavy suppliers',
  vendorReprice: 'Supplier reprice not explained by FX / materials / shipping',
  mix: 'Some parts moved differently from the average',
  seasonality: 'Normal ups and downs through the year',
  unexplained: 'Everything else that closes the walk',
  other: 'Everything else that closes the walk',
};

interface Props {
  steps: MaterialWaterfallStep[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  title?: string;
  subtitle?: string;
}

/**
 * Simple cost story for normal users: Start → why it moved → End.
 * Hides zero drivers; no dense floating-bar chart.
 */
export function CostWalkWaterfall({
  steps,
  activeId,
  onSelect,
  title = 'Why cost changed',
  subtitle = 'Click a row to see the parts behind it',
}: Props) {
  const { startValue, endValue, delta, deltaPct, startLabel, endLabel, active, hiddenZero } =
    useMemo(() => {
      const totals = steps.filter((s) => s.kind === 'total');
      const startStep = totals[0];
      const endStep = totals[totals.length - 1];
      const bridges = steps.filter((s) => s.kind === 'bridge');

      const start = Number(startStep?.value) || 0;
      const end = Number(endStep?.value) || 0;
      const d = end - start;

      const withValue = bridges.filter((s) => Math.abs(Number(s.value) || 0) > 0.5);
      // Largest movers first — easier to scan than walk order for casual users.
      withValue.sort(
        (a, b) => Math.abs(Number(b.value) || 0) - Math.abs(Number(a.value) || 0),
      );
      const zeros = bridges.length - withValue.length;

      return {
        startValue: start,
        endValue: end,
        delta: d,
        deltaPct: start ? (d / start) * 100 : 0,
        startLabel: startStep?.label ?? 'Start',
        endLabel: endStep?.label ?? 'End',
        active: withValue,
        hiddenZero: zeros,
      };
    }, [steps]);

  const deltaAbs = Math.abs(delta) || 1;

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">{title}</h3>
          <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
        </div>
        {activeId ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-600 transition hover:bg-slate-50"
          >
            Clear
          </button>
        ) : null}
      </div>

      <div className="px-5 pb-5">
        {/* One-glance story */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-xl bg-slate-50 px-4 py-3.5">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              {startLabel}
            </div>
            <div className="mt-0.5 text-[22px] font-bold tabular-nums text-slate-900">
              {formatSpend(startValue)}
            </div>
          </div>
          <div className="flex flex-col items-center gap-0.5 px-1">
            <span
              className={clsx(
                'pill text-[11px]',
                delta >= 0 ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700',
              )}
            >
              {formatSigned(deltaPct, 1)}
            </span>
            <span className="text-[11px] text-slate-400">to</span>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              {endLabel}
            </div>
            <div className="mt-0.5 text-[22px] font-bold tabular-nums text-slate-900">
              {formatSpend(endValue)}
            </div>
          </div>
        </div>

        <p className="mt-3 text-[13px] text-slate-600">
          {delta >= 0 ? 'Went up by ' : 'Came down by '}
          <span
            className={clsx(
              'font-semibold',
              delta >= 0 ? 'text-red-600' : 'text-emerald-600',
            )}
          >
            {formatSpend(Math.abs(delta), false)}
          </span>
          . Main reasons:
        </p>

        {active.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-[13px] text-slate-500">
            No cost drivers in this window.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {active.map((step) => {
              const value = Number(step.value) || 0;
              const selected = activeId === step.id;
              const up = value > 0;
              const share = Math.round((Math.abs(value) / deltaAbs) * 100);
              const widthPct = Math.max(8, Math.min(100, share));
              const label = DRIVER_SHORT[step.id] ?? step.label;

              return (
                <li key={step.id}>
                  <button
                    type="button"
                    title={DRIVER_HELP[step.id] ?? step.note ?? label}
                    onClick={() => onSelect(selected ? null : step.id)}
                    className={clsx(
                      'w-full rounded-xl border px-3.5 py-3 text-left transition',
                      selected
                        ? 'border-brand-500 bg-brand-50'
                        : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50',
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[14px] font-semibold text-slate-900">
                          {label}
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {share}% of the change
                        </div>
                      </div>
                      <div
                        className={clsx(
                          'shrink-0 text-[15px] font-bold tabular-nums',
                          up ? 'text-red-600' : 'text-emerald-600',
                        )}
                      >
                        {formatSpend(value, true)}
                      </div>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={clsx(
                          'h-1.5 rounded-full',
                          up ? 'bg-red-400' : 'bg-emerald-500',
                        )}
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
          <span>
            <span className="font-medium text-red-500">Red</span> = cost up
          </span>
          <span>
            <span className="font-medium text-emerald-600">Green</span> = cost down
          </span>
          {hiddenZero > 0 ? (
            <span>{hiddenZero} other drivers had no change (hidden)</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
