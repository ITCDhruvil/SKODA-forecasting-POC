import { useEffect, useMemo, useRef, useState } from 'react';
import { IconCalendar } from './Icons';
import { ScheduleDate, type DateRange } from './ui/schedule-date';
import { monthLabel } from '@/lib/format';

/** Parse dashboard month key "YYYY-MM" to the first day of that month. */
export function monthKeyToDate(month: string): Date {
  const [year, m] = month.split('-').map(Number);
  return new Date(year, m - 1, 1);
}

/** Last day of the month for "YYYY-MM". */
export function monthKeyToEndDate(month: string): Date {
  const [year, m] = month.split('-').map(Number);
  return new Date(year, m, 0);
}

function formatRangeLabel(range: DateRange, fallback: string): string {
  if (!range.start || !range.end) return fallback;
  const from = `${range.start.getFullYear()}-${String(range.start.getMonth() + 1).padStart(2, '0')}`;
  const to = `${range.end.getFullYear()}-${String(range.end.getMonth() + 1).padStart(2, '0')}`;
  return `${monthLabel(from)} - ${monthLabel(to)}`;
}

interface DateRangeControlProps {
  historyRange: [string, string];
  onRangeChange?: (range: DateRange) => void;
}

export function DateRangeControl({ historyRange, onRangeChange }: DateRangeControlProps) {
  const defaultRange = useMemo<DateRange>(
    () => ({
      start: monthKeyToDate(historyRange[0]),
      end: monthKeyToEndDate(historyRange[1]),
    }),
    [historyRange],
  );
  const fallbackLabel = `${monthLabel(historyRange[0])} - ${monthLabel(historyRange[1])}`;

  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange>(defaultRange);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRange(defaultRange);
  }, [defaultRange]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
      >
        <IconCalendar className="h-4 w-4 text-slate-400" />
        {formatRangeLabel(range, fallbackLabel)}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[min(58rem,calc(100vw-2.5rem))] min-w-[min(52rem,calc(100vw-2.5rem))]">
          <ScheduleDate
            initialRange={range}
            yearBounds={{
              min: Number(historyRange[0].slice(0, 4)) - 1,
              max: Number(historyRange[1].slice(0, 4)) + 2,
            }}
            onCancel={() => setOpen(false)}
            onClear={() => {
              setRange(defaultRange);
              onRangeChange?.(defaultRange);
              setOpen(false);
            }}
            onApply={(next) => {
              if (!next.start || !next.end) return;
              setRange(next);
              onRangeChange?.(next);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
