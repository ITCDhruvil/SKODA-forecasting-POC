import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { GeoHitlBlock, GeoAlert } from '../types';
import { formatSigned } from '../lib/format';

type AlertStatus = 'pending' | 'confirmed' | 'dismissed';

type StoredState = Record<string, AlertStatus>;

function formatReportedAt(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

function AlertCard({
  alert,
  status,
  onConfirm,
  onDismiss,
}: {
  alert: GeoAlert;
  status: AlertStatus;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const showImpact = status === 'confirmed' && alert.impact?.available;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Signal · {alert.category.replace(/_/g, ' ')} · severity {alert.severity}/5
          </div>
          <h4 className="mt-1 text-[15px] font-semibold text-slate-900">{alert.headline}</h4>
          <p className="mt-1 text-[12px] text-slate-500">
            Reported {formatReportedAt(alert.reportedAt)} · {alert.regionScope}
          </p>
        </div>
        <span
          className={clsx(
            'pill text-[10px]',
            alert.allSourcesVerified
              ? 'bg-emerald-100 text-emerald-800'
              : 'bg-amber-100 text-amber-800',
          )}
        >
          {alert.allSourcesVerified ? 'sources verified' : 'verify sources'}
        </span>
      </div>

      {alert.narrative && (
        <p className="mt-3 text-sm text-slate-600">{alert.narrative}</p>
      )}

      {/* Source verification */}
      <div className="mt-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Source verification
        </div>
        <ul className="mt-2 space-y-2">
          {alert.sourceVerifications.map((v) => (
            <li
              key={v.channel}
              className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-[12px]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-slate-800">{v.channel}</span>
                <span
                  className={clsx(
                    'pill text-[10px]',
                    v.isVerified ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700',
                  )}
                >
                  {v.isVerified ? v.source : 'unverified'}
                </span>
              </div>
              <p className="mt-1 text-slate-600">{v.note}</p>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-slate-500">
          Event calendar: {alert.source} · curator confidence {Math.round(alert.confidence * 100)}%
        </p>
      </div>

      {/* Human gate */}
      {status === 'pending' && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-sm font-medium text-slate-800">{alert.prompt}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-lg bg-slate-900 px-4 py-2 text-[13px] font-medium text-white hover:bg-slate-800"
            >
              Yes, show price impact
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
            >
              No, dismiss
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Impact is not applied to forecasts unless you confirm. Dismissing hides this alert for
            this browser session.
          </p>
        </div>
      )}

      {status === 'dismissed' && (
        <p className="mt-3 text-[12px] italic text-slate-500">Dismissed — no impact shown.</p>
      )}

      {showImpact && (
        <div className="mt-4 rounded-lg border border-teal-200 bg-teal-50/50 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-teal-800">
            Estimated impact (you confirmed)
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-3">
            <span
              className={clsx(
                'text-[28px] font-bold',
                (alert.impact.overallPriceChangePct ?? 0) >= 0
                  ? 'text-red-600'
                  : 'text-emerald-600',
              )}
            >
              {formatSigned(alert.impact.overallPriceChangePct ?? 0)}%
            </span>
            <span className="text-sm text-slate-600">
              portfolio average · horizon {alert.impact.horizonMonths} month(s) · shock{' '}
              {alert.impact.shockPct}%
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-700">{alert.impact.explanation}</p>
          <p className="mt-1 text-[11px] text-slate-500">{alert.impact.causalityNote}</p>

          {(alert.impact.byCategory?.length ?? 0) > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-[12px]">
                <thead className="text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Category</th>
                    <th className="py-1 pr-3 font-medium">Parts</th>
                    <th className="py-1 font-medium">Price Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {alert.impact.byCategory!.slice(0, 8).map((row) => (
                    <tr key={row.name} className="border-t border-teal-100">
                      <td className="py-1.5 pr-3 text-slate-800">{row.name}</td>
                      <td className="py-1.5 pr-3 text-slate-600">{row.nParts}</td>
                      <td
                        className={clsx(
                          'py-1.5 font-medium',
                          row.priceChangePct >= 0 ? 'text-red-600' : 'text-emerald-600',
                        )}
                      >
                        {formatSigned(row.priceChangePct)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Human-in-the-loop geopolitical review: surface news, verify sources, and
 * only reveal price impact after explicit analyst confirmation.
 */
export function GeoHitlPanel({ hitl }: { hitl?: GeoHitlBlock }) {
  const [stored, setStored] = useState<StoredState>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/hitl-status')
      .then((r) => r.json().then((payload: { statuses?: StoredState }) => ({ r, payload })))
      .then(({ r, payload }) => {
        if (r.ok && payload.statuses) {
          setStored(payload.statuses);
          setSaveError(null);
        } else {
          setSaveError("Couldn't load alert status — showing may be out of date.");
        }
      })
      .catch(() => {
        setSaveError("Couldn't load alert status — showing may be out of date.");
      });
  }, []);

  const setStatus = useCallback((alertId: string, status: AlertStatus) => {
    const previous = stored;
    setStored((prev) => ({ ...prev, [alertId]: status }));
    setSaveError(null);
    fetch('/api/hitl-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertId, status }),
    })
      .then((r) => {
        if (!r.ok) throw new Error('save failed');
      })
      .catch(() => {
        setStored(previous);
        setSaveError("Couldn't save your decision — try again.");
      });
  }, [stored]);

  const alerts = hitl?.alerts ?? [];
  const drivers = hitl?.forecastDrivers;
  const visibleAlerts = useMemo(
    () => alerts.filter((a) => stored[a.alertId] !== 'dismissed'),
    [alerts, stored],
  );
  const pendingCount = alerts.filter((a) => (stored[a.alertId] ?? 'pending') === 'pending').length;

  if (!hitl?.available) {
    return null;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold text-slate-900">
            Analyst review queue
          </h3>
          {pendingCount > 0 && (
            <span className="pill bg-amber-100 text-[11px] text-amber-800">
              {pendingCount} awaiting your decision
            </span>
          )}
        </div>
        <p className="mt-2 text-sm text-slate-600">{hitl.policy}</p>
      </div>

      {saveError && (
        <div className="card border-red-200 bg-red-50 px-5 py-3 text-sm text-red-700">
          {saveError}
        </div>
      )}

      {/* Why the forecast moved */}
      {drivers?.available && drivers.drivers && drivers.drivers.length > 0 && (
        <div className="card px-5 py-4">
          <h3 className="text-[15px] font-semibold text-slate-900">
            Why prices moved — {drivers.periodLabel}
          </h3>
          {drivers.portfolioMomPct != null && (
            <p className="mt-1 text-sm text-slate-600">
              Portfolio average change:{' '}
              <span
                className={clsx(
                  'font-semibold',
                  drivers.portfolioMomPct >= 0 ? 'text-red-600' : 'text-emerald-600',
                )}
              >
                {formatSigned(drivers.portfolioMomPct)}%
              </span>
            </p>
          )}
          <p className="mt-2 text-sm text-slate-600">{drivers.summary}</p>
          <ul className="mt-4 space-y-3">
            {drivers.drivers.map((d) => (
              <li
                key={d.id}
                className="rounded-lg border border-slate-200 px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-slate-800">{d.label}</span>
                  <div className="flex items-center gap-2">
                    <span
                      className={clsx(
                        'text-[12px] font-semibold',
                        d.direction === 'up' ? 'text-red-600' : 'text-emerald-600',
                      )}
                    >
                      {d.direction === 'up' ? '↑ pressure' : '↓ pressure'}
                    </span>
                    <span
                      className={clsx(
                        'pill text-[10px]',
                        d.isReal ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700',
                      )}
                    >
                      {d.isReal ? d.source : 'offline'}
                    </span>
                  </div>
                </div>
                <p className="mt-1 text-[12px] text-slate-600">{d.explanation}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-slate-500">{drivers.note}</p>
        </div>
      )}

      {/* Pending alerts */}
      {visibleAlerts.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-[15px] font-semibold text-slate-900">Recent signals</h3>
          {visibleAlerts.map((alert) => (
            <AlertCard
              key={alert.alertId}
              alert={alert}
              status={stored[alert.alertId] ?? 'pending'}
              onConfirm={() => setStatus(alert.alertId, 'confirmed')}
              onDismiss={() => setStatus(alert.alertId, 'dismissed')}
            />
          ))}
        </div>
      ) : (
        <div className="card px-5 py-4 text-sm text-slate-600">
          No active signals — all alerts were dismissed or none were ingested.
        </div>
      )}
    </div>
  );
}
