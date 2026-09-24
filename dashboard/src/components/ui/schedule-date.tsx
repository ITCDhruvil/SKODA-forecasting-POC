import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DateRange {
  start: Date | null;
  end: Date | null;
}

interface ScheduleDateProps {
  initialRange?: DateRange;
  /** Inclusive year bounds for the year dropdown. Defaults to a wide window around today. */
  yearBounds?: { min: number; max: number };
  onApply?: (range: DateRange) => void;
  onCancel?: () => void;
  onClear?: () => void;
}

const PRESETS = [
  { label: 'Today', id: 'today' },
  { label: 'Yesterday', id: 'yesterday' },
  { label: 'Last 7 Days', id: '7d' },
  { label: 'Last 30 Days', id: '30d' },
  { label: 'Last 365 Days', id: '365d' },
  { label: 'Week to Date', id: 'wtd' },
  { label: 'Month to Date', id: 'mtd' },
  { label: 'Year to Date', id: 'ytd' },
  { label: 'Custom', id: 'custom' },
] as const;

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function rangeForPreset(id: string): DateRange | null {
  const today = startOfDay(new Date());
  if (id === 'today') return { start: today, end: today };
  if (id === 'yesterday') {
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    return { start: y, end: y };
  }
  if (id === '7d') {
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    return { start, end: today };
  }
  if (id === '30d') {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    return { start, end: today };
  }
  if (id === '365d') {
    const start = new Date(today);
    start.setDate(start.getDate() - 364);
    return { start, end: today };
  }
  if (id === 'wtd') {
    const day = (today.getDay() + 6) % 7;
    const start = new Date(today);
    start.setDate(start.getDate() - day);
    return { start, end: today };
  }
  if (id === 'mtd') {
    return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: today };
  }
  if (id === 'ytd') {
    return { start: new Date(today.getFullYear(), 0, 1), end: today };
  }
  return null;
}

export function ScheduleDate({
  initialRange,
  yearBounds,
  onApply,
  onCancel,
  onClear,
}: ScheduleDateProps) {
  const today = useMemo(() => startOfDay(new Date()), []);
  const [selectedPreset, setSelectedPreset] = useState('custom');
  const [range, setRange] = useState<DateRange>(
    () =>
      initialRange ?? {
        start: new Date(2025, 9, 15),
        end: new Date(2025, 9, 25),
      },
  );
  const [viewDate, setViewDate] = useState(() => {
    const seed = initialRange?.start ?? today;
    return new Date(seed.getFullYear(), seed.getMonth(), 1);
  });

  const years = useMemo(() => {
    const now = new Date().getFullYear();
    const min = yearBounds?.min ?? now - 8;
    const max = yearBounds?.max ?? now + 4;
    const list: number[] = [];
    for (let y = min; y <= max; y += 1) list.push(y);
    return list;
  }, [yearBounds]);

  useEffect(() => {
    if (!initialRange?.start && !initialRange?.end) return;
    setRange(initialRange);
    if (initialRange.start) {
      setViewDate(new Date(initialRange.start.getFullYear(), initialRange.start.getMonth(), 1));
    }
  }, [initialRange]);

  const applyPreset = (id: string) => {
    setSelectedPreset(id);
    if (id === 'custom') return;
    const next = rangeForPreset(id);
    if (!next?.start) return;
    setRange(next);
    setViewDate(new Date(next.start.getFullYear(), next.start.getMonth(), 1));
  };

  const handleDateClick = (date: Date) => {
    if (!range.start || (range.start && range.end)) {
      setRange({ start: date, end: null });
      setSelectedPreset('custom');
    } else if (date < range.start) {
      setRange({ start: date, end: range.start });
    } else {
      setRange({ ...range, end: date });
    }
  };

  const setViewMonth = (month: number) => {
    setViewDate(new Date(viewDate.getFullYear(), month, 1));
  };

  const setViewYear = (year: number) => {
    setViewDate(new Date(year, viewDate.getMonth(), 1));
  };

  const renderMonthGrid = (monthDate: Date, showLeftNav = false, showRightNav = false) => {
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    return (
      <div className="w-[17.5rem] shrink-0">
        <div className="mb-4 flex items-center justify-between gap-1 px-1">
          {showLeftNav ? (
            <button
              type="button"
              title="Previous month"
              onClick={() => setViewDate(new Date(year, month - 1, 1))}
              className="shrink-0 rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
            >
              <ChevronLeft size={18} strokeWidth={2.5} />
            </button>
          ) : (
            <div className="w-7 shrink-0" />
          )}

          <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5">
            {showLeftNav ? (
              <>
                <label className="sr-only" htmlFor="schedule-month">
                  Month
                </label>
                <select
                  id="schedule-month"
                  value={month}
                  onChange={(e) => setViewMonth(Number(e.target.value))}
                  className="max-w-[7.5rem] cursor-pointer truncate rounded-md border border-neutral-200 bg-white px-1.5 py-1 text-[12px] font-semibold text-neutral-800 outline-none hover:border-neutral-300 focus:border-neutral-400"
                >
                  {MONTHS.map((name, idx) => (
                    <option key={name} value={idx}>
                      {name}
                    </option>
                  ))}
                </select>
                <label className="sr-only" htmlFor="schedule-year">
                  Year
                </label>
                <select
                  id="schedule-year"
                  value={year}
                  onChange={(e) => setViewYear(Number(e.target.value))}
                  className="cursor-pointer rounded-md border border-neutral-200 bg-white px-1.5 py-1 text-[12px] font-semibold text-neutral-800 outline-none hover:border-neutral-300 focus:border-neutral-400"
                >
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <span className="text-[13px] font-semibold tracking-tight text-neutral-800">
                {MONTHS[month]} {year}
              </span>
            )}
          </div>

          {showRightNav ? (
            <button
              type="button"
              title="Next month"
              onClick={() => setViewDate(new Date(year, month + 1, 1))}
              className="shrink-0 rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
            >
              <ChevronRight size={18} strokeWidth={2.5} />
            </button>
          ) : (
            <div className="w-7 shrink-0" />
          )}
        </div>

        <div className="relative grid grid-cols-7 gap-y-1 text-center">
          {DAYS.map((d) => (
            <span
              key={d}
              className={cn(
                'mb-2 text-[11px] font-medium',
                d === 'Su' ? 'text-red-500' : 'text-neutral-400',
              )}
            >
              {d}
            </span>
          ))}
          {Array.from({ length: firstDay }).map((_, i) => (
            <div key={`empty-${i}`} className="h-9" />
          ))}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const currentDayDate = new Date(year, month, day);
            const isSunday = currentDayDate.getDay() === 0;
            const isToday = currentDayDate.toDateString() === today.toDateString();
            const isStart = range.start?.toDateString() === currentDayDate.toDateString();
            const isEnd = range.end?.toDateString() === currentDayDate.toDateString();
            const isInRange =
              range.start &&
              range.end &&
              currentDayDate > range.start &&
              currentDayDate < range.end;

            return (
              <div
                key={day}
                role="button"
                tabIndex={0}
                title={isToday ? 'Today' : undefined}
                onClick={() => handleDateClick(currentDayDate)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleDateClick(currentDayDate);
                  }
                }}
                className="group relative flex h-9 cursor-pointer items-center justify-center"
              >
                {(isInRange || isStart || isEnd) && (
                  <div
                    className={cn(
                      'absolute z-0 h-9 border-y border-neutral-200 bg-neutral-100',
                      isStart ? 'left-1/2 rounded-l-lg border-l' : 'left-0',
                      isEnd ? 'right-1/2 rounded-r-lg border-r' : 'right-0',
                      isInRange && !isStart && !isEnd ? 'w-full' : '',
                    )}
                  />
                )}
                {isStart || isEnd ? (
                  <div
                    className={cn(
                      'absolute z-10 flex h-9 w-9 flex-col items-center justify-center rounded-lg border bg-gradient-to-b from-neutral-700 to-neutral-900 shadow-xl',
                      isToday ? 'border-sky-400 ring-2 ring-sky-400/60' : 'border-neutral-600',
                    )}
                  >
                    <span className="text-xs font-bold text-white">{day}</span>
                    <motion.div
                      layoutId="activeThumb"
                      className="absolute bottom-1 h-[1.5px] w-2 rounded-full bg-blue-400 shadow-[0_0_8px_#6366f1]"
                    />
                  </div>
                ) : (
                  <span
                    className={cn(
                      'relative z-10 flex h-9 w-9 items-center justify-center rounded-lg text-[13px] font-normal transition-colors',
                      isToday &&
                        'bg-sky-50 font-semibold ring-2 ring-inset ring-sky-500',
                      isInRange
                        ? isSunday
                          ? 'text-red-600'
                          : 'text-neutral-900'
                        : isSunday
                          ? 'text-red-500 group-hover:text-red-600'
                          : 'text-neutral-600 group-hover:text-neutral-900',
                      isToday && isSunday && 'text-red-600',
                    )}
                  >
                    {day}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="flex w-full min-w-[52rem] max-w-[58rem] flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white font-sans text-neutral-600 shadow-2xl">
      <div className="flex min-h-0 w-full flex-col md:min-h-[28rem] md:flex-row">
        <aside className="scrollbar-hidden flex w-full shrink-0 flex-row gap-1 overflow-x-auto border-b border-neutral-200 bg-neutral-50/50 py-3 md:w-48 md:flex-col md:border-r md:border-b-0">
          {PRESETS.map((preset, idx) => (
            <React.Fragment key={preset.id}>
              {[2, 5, 8].includes(idx) && (
                <div className="mx-3 my-1 hidden h-px bg-neutral-200 md:block" />
              )}
              <button
                type="button"
                onClick={() => applyPreset(preset.id)}
                className={cn(
                  'group mx-2 flex items-center justify-between rounded-lg px-3 py-1.5 text-xs whitespace-nowrap transition-all duration-200 md:mx-3 md:text-[13px]',
                  selectedPreset === preset.id
                    ? preset.id === 'custom'
                      ? 'border border-neutral-300 bg-gradient-to-b from-neutral-100 to-neutral-200 font-medium text-neutral-900'
                      : 'bg-neutral-200 text-neutral-900'
                    : 'hover:bg-neutral-100 hover:text-neutral-900',
                )}
              >
                <span>{preset.label}</span>
                {selectedPreset === preset.id && preset.id === 'custom' && (
                  <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="ml-2">
                    <Check size={12} />
                  </motion.div>
                )}
              </button>
            </React.Fragment>
          ))}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-5 bg-white p-5">
          <div className="grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2">
            <DateInput label="Start date" date={range.start} />
            <DateInput label="End date" date={range.end} />
          </div>

          <div className="flex flex-row flex-wrap items-start justify-center gap-8 lg:gap-12">
            {renderMonthGrid(viewDate, true, false)}
            <div className="hidden h-44 w-px shrink-0 self-center bg-neutral-200 opacity-50 lg:block" />
            {renderMonthGrid(
              new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1),
              false,
              true,
            )}
          </div>
        </main>
      </div>

      <footer className="flex h-16 shrink-0 items-center justify-between gap-3 border-t border-neutral-200 bg-neutral-50/50 px-6">
        <button
          type="button"
          onClick={() => {
            setRange({ start: null, end: null });
            setSelectedPreset('custom');
            onClear?.();
          }}
          className="rounded-full px-4 py-1.5 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
        >
          Clear
        </button>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-neutral-200 px-4 py-1.5 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onApply?.(range)}
            className="rounded-full bg-neutral-900 px-5 py-1.5 text-xs font-semibold text-white shadow-lg transition-all hover:opacity-90 active:scale-95"
          >
            Apply
          </button>
        </div>
      </footer>
    </div>
  );
}

const DateInput = ({ label, date }: { label: string; date: Date | null }) => (
  <div className="flex flex-1 flex-col gap-1.5">
    <label className="ml-1 text-[12px] font-normal text-neutral-400">{label}</label>
    <div className="flex cursor-default items-center justify-between rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600 md:text-[13px]">
      <span>
        {date
          ? date.toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
          : 'Select Date'}
      </span>
      <ChevronDown size={14} className="text-neutral-400" />
    </div>
  </div>
);
