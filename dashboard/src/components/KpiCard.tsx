import clsx from 'clsx';
import type { Kpi } from '../types';
import { formatByType, formatSigned } from '../lib/format';
import { ICON_MAP, IconArrowDown, IconArrowUp, IconTrending } from './Icons';

const ICON_STYLES: Record<string, string> = {
  trending: 'bg-blue-50 text-blue-600',
  package: 'bg-emerald-50 text-emerald-600',
  target: 'bg-violet-50 text-violet-600',
  alert: 'bg-amber-50 text-amber-600',
};

export function KpiCard({ kpi }: { kpi: Kpi }) {
  const Icon = ICON_MAP[kpi.icon] ?? IconTrending;
  const positive = kpi.direction === 'up';

  return (
    <div className="card px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-slate-600">{kpi.label}</div>
          <div className="mt-1.5 text-[28px] font-bold leading-none tracking-tight text-slate-900">
            {formatByType(kpi.value, kpi.format)}
          </div>
        </div>
        <div
          className={clsx(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
            ICON_STYLES[kpi.icon] ?? ICON_STYLES.trending,
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5 text-xs">
        {kpi.change !== null && kpi.direction !== 'flat' && (
          <span
            className={clsx(
              'inline-flex items-center gap-0.5 font-semibold',
              positive ? 'text-emerald-600' : 'text-red-600',
            )}
          >
            {positive ? <IconArrowUp /> : <IconArrowDown />}
            {formatSigned(kpi.change)}
          </span>
        )}
        <span className="truncate text-slate-500">{kpi.changeLabel}</span>
      </div>

      {kpi.note && (
        <div className="mt-2 rounded-md bg-slate-50 px-2 py-1 text-[10px] leading-tight text-slate-500">
          {kpi.note}
        </div>
      )}
    </div>
  );
}
