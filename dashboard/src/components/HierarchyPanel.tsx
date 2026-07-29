import { useState } from 'react';
import clsx from 'clsx';
import {
  Bar,
  BarChart,
  Cell,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { HierarchyRollup, RollupRow } from '../types';
import { formatCurrency, formatSigned } from '../lib/format';

const LEVELS: { id: string; label: string; blurb: string }[] = [
  {
    id: 'project',
    label: 'Project',
    blurb: 'Programme cost trajectory — what a vehicle line is heading toward.',
  },
  {
    id: 'vendor',
    label: 'Vendor',
    blurb: 'Negotiation priority — which suppliers are driving the increase.',
  },
  {
    id: 'category',
    label: 'Category',
    blurb: 'Hedging priority — which commodity exposures to cover.',
  },
];

/**
 * The part-level model, read at the level a decision is actually made.
 *
 * A per-part forecast is not directly actionable: nobody negotiates one
 * fastener. Aggregating up each dimension turns the same predictions into three
 * different decisions — programme budgeting, supplier negotiation, and
 * commodity hedging.
 */
export function HierarchyPanel({
  hierarchy,
  horizonMonths,
}: {
  hierarchy?: HierarchyRollup;
  horizonMonths: number;
}) {
  const available = LEVELS.filter((l) => (hierarchy?.[l.id]?.length ?? 0) > 0);
  const [active, setActive] = useState(available[0]?.id ?? 'project');

  if (!hierarchy || available.length === 0) {
    return (
      <div className="card p-6">
        <h3 className="text-[15px] font-semibold text-slate-900">
          Hierarchy roll-up unavailable
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          This payload has no hierarchy data. Regenerate with{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">
            --stage export
          </code>
          .
        </p>
      </div>
    );
  }

  const level = available.find((l) => l.id === active) ?? available[0];
  const rows = hierarchy[level.id] ?? [];
  const totalCurrent = rows.reduce((sum, r) => sum + r.currentSpend, 0);
  const totalForecast = rows.reduce((sum, r) => sum + r.forecastSpend, 0);
  const totalChange =
    totalCurrent > 0 ? ((totalForecast - totalCurrent) / totalCurrent) * 100 : 0;

  const chartData = rows.map((r) => ({ name: r.name, changePct: r.changePct }));

  return (
    <div className="flex flex-col gap-4">
      <div className="card">
        <div className="card-header flex-wrap">
          <div>
            <h3 className="card-title">Forecast Spend by {level.label}</h3>
            <p className="mt-0.5 text-xs text-slate-500">{level.blurb}</p>
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
            {available.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setActive(l.id)}
                className={clsx(
                  'rounded-md px-3 py-1.5 text-[13px] font-medium transition',
                  l.id === level.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900',
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-6 px-5 pb-3">
          <Metric label="Current monthly spend" value={formatCurrency(totalCurrent)} />
          <Metric
            label={`Forecast (+${horizonMonths} mo)`}
            value={formatCurrency(totalForecast)}
          />
          <Metric
            label="Change"
            value={formatSigned(totalChange, 2)}
            tone={totalChange >= 0 ? 'up' : 'down'}
          />
          <Metric label={`${level.label}s`} value={String(rows.length)} />
        </div>

        <div className="px-2 pb-4">
          <ResponsiveContainer width="100%" height={Math.max(220, rows.length * 30)}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 6, right: 40, left: 8, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: '#64748b' }}
                tickLine={false}
                axisLine={{ stroke: '#e2e8f0' }}
                tickFormatter={(v: number) => `${v.toFixed(1)}%`}
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fontSize: 11, fill: '#475569' }}
                tickLine={false}
                axisLine={false}
                width={150}
              />
              <Tooltip
                cursor={{ fill: '#f8fafc' }}
                contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }}
                formatter={(value) => [
                  value == null ? '--' : `${Number(value).toFixed(2)}%`,
                  'Forecast change',
                ]}
              />
              <ReferenceLine x={0} stroke="#94a3b8" />
              <Bar dataKey="changePct" radius={[0, 5, 5, 0]} maxBarSize={22}>
                {chartData.map((entry) => (
                  <Cell
                    key={entry.name}
                    fill={entry.changePct >= 0 ? '#dc2626' : '#059669'}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="px-4 text-[11px] text-slate-500">
            Red is a cost increase — bad for a buyer. Green is a decrease.
          </p>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="card-header">
          <h3 className="card-title">{level.label} Detail</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-y border-slate-200 bg-slate-50/60 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-5 py-2.5 font-semibold">{level.label}</th>
                <th className="px-3 py-2.5 text-right font-semibold">Parts</th>
                <th className="px-3 py-2.5 text-right font-semibold">Current</th>
                <th className="px-3 py-2.5 text-right font-semibold">Forecast</th>
                <th className="px-3 py-2.5 text-right font-semibold">Change</th>
                <th className="px-5 py-2.5 text-right font-semibold">Abs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row: RollupRow) => (
                <tr key={row.name} className="hover:bg-slate-50">
                  <td className="px-5 py-2.5 font-medium text-slate-900">{row.name}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                    {row.parts}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                    {formatCurrency(row.currentSpend)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-900">
                    {formatCurrency(row.forecastSpend)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span
                      className={clsx(
                        'font-semibold tabular-nums',
                        row.changePct >= 0 ? 'text-red-600' : 'text-emerald-600',
                      )}
                    >
                      {formatSigned(row.changePct, 2)}
                    </span>
                  </td>
                  <td className="px-5 py-2.5 text-right tabular-nums text-slate-500">
                    {formatCurrency(row.changeAbs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down';
}) {
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div
        className={clsx(
          'mt-0.5 text-[19px] font-bold leading-none',
          tone === 'up' ? 'text-red-600' : tone === 'down' ? 'text-emerald-600' : 'text-slate-900',
        )}
      >
        {value}
      </div>
    </div>
  );
}
