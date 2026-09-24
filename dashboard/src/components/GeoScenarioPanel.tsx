import { useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
} from 'recharts';
import type { GeoAnalysis } from '../types';
import { formatSigned } from '../lib/format';
import { GeoHitlPanel } from './GeoHitlPanel';

const LEVELS = [
  { id: 'category', label: 'Category' },
  { id: 'vendor', label: 'Vendor' },
  { id: 'project', label: 'Project' },
];

const FAMILIES = [
  { id: 'all', label: 'All' },
  { id: 'freight', label: 'Freight' },
  { id: 'gpr', label: 'GPR' },
  { id: 'duty', label: 'Duty' },
];

/**
 * Geopolitical mechanism panel: event → channel → exposure → price.
 *
 * Shows curated event studies, mediation diagnostics (does GPR fade when
 * mediators are held?), and counterfactual shocks rolled up the hierarchy.
 */
export function GeoScenarioPanel({ geo }: { geo?: GeoAnalysis }) {
  const scenarios = geo?.scenarios ?? [];
  const studies = geo?.eventStudies ?? [];
  const [level, setLevel] = useState('category');
  const [family, setFamily] = useState('all');
  const [studyId, setStudyId] = useState(studies[0]?.eventId ?? '');

  const filtered = useMemo(
    () =>
      family === 'all' ? scenarios : scenarios.filter((s) => s.family === family),
    [scenarios, family],
  );

  const activeStudy = studies.find((s) => s.eventId === studyId) ?? studies[0];
  const mediation = geo?.mediation;
  const framework = geo?.provenance?.framework;

  if (!geo || (!scenarios.length && !studies.length && !geo.hitl?.available)) {
    return (
      <div className="card p-6">
        <h3 className="text-[15px] font-semibold text-slate-900">
          Geo scenario analysis not run
        </h3>
        <p className="mt-1 text-sm text-slate-600">Generate it with:</p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-[12px] text-slate-100">
          python -m price_forecasting.pipeline --stage geoscenario{'\n'}
          python -m price_forecasting.pipeline --stage export
        </pre>
      </div>
    );
  }

  const largest = [...filtered].sort(
    (a, b) => Math.abs(b.overallPriceChangePct) - Math.abs(a.overallPriceChangePct),
  )[0];
  const levelRows = largest?.byLevel?.[level] ?? [];

  return (
    <div className="flex flex-col gap-4">
      <GeoHitlPanel hitl={geo.hitl} />

      {/* Mechanism claim */}
      {framework && (
        <div className="card px-5 py-4">
          <h3 className="text-[15px] font-semibold text-slate-900">
            Event → channel → exposure → price
          </h3>
          <p className="mt-2 text-sm text-slate-600">{framework.claim}</p>
          <p className="mt-2 text-xs text-slate-500">{framework.causalityNote}</p>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {framework.layers.map((layer) => (
              <div key={layer.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {layer.name}
                </div>
                <div className="mt-1 text-[12px] text-slate-700">
                  {layer.items.slice(0, 4).join(' · ')}
                  {layer.items.length > 4 ? '…' : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mediation */}
      {mediation?.available && (
        <div className="card px-5 py-4">
          <h3 className="text-[15px] font-semibold text-slate-900">
            Mediation diagnostic
          </h3>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 px-4 py-3">
              <div className="text-[12px] text-slate-500">Total corr (GPR ↔ price MoM)</div>
              <div className="mt-1 text-[22px] font-bold text-slate-900">
                {mediation.totalCorrGprPrice?.toFixed(3)}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 px-4 py-3">
              <div className="text-[12px] text-slate-500">
                Partial corr (mediators held)
              </div>
              <div className="mt-1 text-[22px] font-bold text-slate-900">
                {mediation.partialCorrGprPriceGivenMediators?.toFixed(3)}
              </div>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">{mediation.interpretation}</p>
        </div>
      )}

      {/* Event studies */}
      {studies.length > 0 && (
        <div className="card px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold text-slate-900">Event studies</h3>
            <select
              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[12px]"
              value={activeStudy?.eventId ?? ''}
              onChange={(e) => setStudyId(e.target.value)}
            >
              {studies.map((s) => (
                <option key={s.eventId} value={s.eventId}>
                  {s.eventId} ({s.category})
                </option>
              ))}
            </select>
          </div>
          {activeStudy && (
            <>
              <p className="mt-2 text-sm text-slate-600">{activeStudy.narrative}</p>
              <p className="mt-1 text-xs text-slate-500">
                Anchor {activeStudy.anchorMonth} · severity {activeStudy.severity} ·{' '}
                {activeStudy.regionScope}
              </p>
              <div className="mt-3 h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={activeStudy.path}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="offset" tick={{ fontSize: 11 }} />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v) => `${v}%`}
                      width={40}
                    />
                    <Tooltip
                      formatter={(v) =>
                        typeof v === 'number' ? `${v.toFixed(2)}%` : String(v ?? '')
                      }
                      labelFormatter={(l) => `t${Number(l) >= 0 ? '+' : ''}${l}`}
                    />
                    <ReferenceLine x={0} stroke="#94a3b8" strokeDasharray="4 4" />
                    <ReferenceLine y={0} stroke="#cbd5e1" />
                    <Line
                      type="monotone"
                      dataKey="pctDelta"
                      stroke="#0f766e"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </div>
      )}

      {/* Counterfactuals */}
      {filtered.length > 0 && (
        <div className="card px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold text-slate-900">
              Counterfactual shocks
            </h3>
            <div className="flex flex-wrap gap-1">
              {FAMILIES.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFamily(f.id)}
                  className={clsx(
                    'rounded-md px-2.5 py-1 text-[12px] font-medium',
                    family === f.id
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-3 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={filtered}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} width={40} />
                <Tooltip
                  formatter={(v) =>
                    typeof v === 'number' ? formatSigned(v) + '%' : String(v ?? '')
                  }
                />
                <ReferenceLine y={0} stroke="#cbd5e1" />
                <Bar dataKey="overallPriceChangePct" fill="#0f766e" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {largest && levelRows.length > 0 && (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-slate-600">
                  Roll-up for <span className="font-semibold text-slate-900">{largest.name}</span>
                </div>
                <div className="flex gap-1">
                  {LEVELS.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => setLevel(l.id)}
                      className={clsx(
                        'rounded-md px-2.5 py-1 text-[12px] font-medium',
                        level === l.id
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                      )}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Name</th>
                      <th className="py-2 pr-3 font-medium">Parts</th>
                      <th className="py-2 font-medium">Price Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {levelRows.slice(0, 10).map((row) => (
                      <tr key={row.name} className="border-t border-slate-100">
                        <td className="py-2 pr-3 text-slate-800">{row.name}</td>
                        <td className="py-2 pr-3 text-slate-600">{row.nParts}</td>
                        <td
                          className={clsx(
                            'py-2 font-medium',
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
            </>
          )}
        </div>
      )}

      {/* Mediator provenance */}
      {geo.provenance?.mediators?.length ? (
        <div className="card px-5 py-4">
          <h3 className="text-[15px] font-semibold text-slate-900">Mediator provenance</h3>
          {(geo.provenance.commoditiesReal != null ||
            geo.provenance.freightReal != null ||
            geo.provenance.gprReal != null) && (
            <p className="mt-1 text-[12px] text-slate-600">
              Commodities{' '}
              <span
                className={
                  geo.provenance.commoditiesReal ? 'font-medium text-emerald-700' : 'font-medium text-amber-700'
                }
              >
                {geo.provenance.commoditiesReal ? 'live' : 'offline'}
              </span>
              {' · '}Freight{' '}
              <span
                className={
                  geo.provenance.freightReal ? 'font-medium text-emerald-700' : 'font-medium text-amber-700'
                }
              >
                {geo.provenance.freightReal ? 'live' : 'offline'}
              </span>
              {' · '}GPR{' '}
              <span
                className={
                  geo.provenance.gprReal ? 'font-medium text-emerald-700' : 'font-medium text-amber-700'
                }
              >
                {geo.provenance.gprReal ? 'live' : 'offline'}
              </span>
            </p>
          )}
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {geo.provenance.mediators.map((m) => (
              <div key={m.name} className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-slate-800">{m.name}</span>
                  <span
                    className={clsx(
                      'pill text-[10px]',
                      m.isReal ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700',
                    )}
                  >
                    {m.isReal ? 'real/cache' : 'offline'}
                  </span>
                </div>
                <div className="mt-1 text-[12px] text-slate-500">
                  {formatSigned(m.totalMovePct)}% over window · {m.source}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
