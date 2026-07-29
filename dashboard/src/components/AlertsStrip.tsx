import clsx from 'clsx';
import type { AlertRow } from '../types';
import { IconAlert, IconInfo } from './Icons';

const SEVERITY: Record<AlertRow['severity'], string> = {
  high: 'bg-red-50 text-red-600',
  medium: 'bg-orange-50 text-orange-500',
  low: 'bg-amber-50 text-amber-500',
};

const PREVIEW_COUNT = 3;

export function AlertsStrip({ alerts, onSeeAll }: { alerts: AlertRow[]; onSeeAll?: () => void }) {
  const isPreview = Boolean(onSeeAll);
  const visible = isPreview ? alerts.slice(0, PREVIEW_COUNT) : alerts;
  const remaining = Math.max(0, alerts.length - PREVIEW_COUNT);

  return (
    <div className="card overflow-hidden">
      <div className="px-5 pt-5 pb-3">
        <h3 className="card-title">Alerts &amp; Notifications</h3>
      </div>

      {alerts.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-slate-500">
          No parts exceed the movement threshold this cycle.
        </p>
      ) : isPreview ? (
        <div className="flex flex-col border-t border-slate-200 sm:flex-row sm:divide-x sm:divide-y-0 divide-y divide-slate-200">
          {visible.map((alert) => (
            <AlertCell
              key={`${alert.partId}-${alert.message}`}
              alert={alert}
              onView={onSeeAll}
              className="sm:flex-1"
            />
          ))}
          {remaining > 0 && (
            <div className="flex flex-1 items-center gap-3 px-5 py-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                <IconInfo className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-slate-900">
                  {remaining} more alert{remaining === 1 ? '' : 's'}
                </div>
                <button
                  type="button"
                  onClick={onSeeAll}
                  className="mt-0.5 text-[12px] font-medium text-brand-600 hover:underline"
                >
                  View all alerts &rarr;
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="divide-y divide-slate-200 border-t border-slate-200">
          {visible.map((alert) => (
            <AlertCell key={`${alert.partId}-${alert.message}`} alert={alert} />
          ))}
        </div>
      )}
    </div>
  );
}

function AlertCell({
  alert,
  onView,
  className,
}: {
  alert: AlertRow;
  onView?: () => void;
  className?: string;
}) {
  return (
    <div className={clsx('flex items-center gap-3 px-5 py-4', className)}>
      <div
        className={clsx(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
          SEVERITY[alert.severity],
        )}
      >
        <IconAlert className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-slate-900">{alert.title}</div>
        <p className="mt-0.5 truncate text-[12px] text-slate-500">{alert.message}</p>
      </div>
      {onView && (
        <button
          type="button"
          onClick={onView}
          className="shrink-0 text-[12px] font-medium text-brand-600 hover:underline"
        >
          View
        </button>
      )}
    </div>
  );
}
