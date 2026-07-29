import { useState } from 'react';
import clsx from 'clsx';
import type { RiskConcentration } from '../types';
import { formatCurrency, formatSigned } from '../lib/format';
import { IconAlert } from './Icons';

const DIMENSION_LABEL: Record<string, string> = {
  vendor: 'Vendor',
  category: 'Category',
  project: 'Project',
};

/**
 * Exposure stated in money, and where it is concentrated.
 *
 * A count of at-risk parts is a technical metric. The number a procurement lead
 * carries out of the room is currency: how much spend is forecast to rise, and
 * which suppliers it sits with. Concentration matters as much as the total -
 * exposure spread evenly across forty vendors is a different problem from the
 * same amount sitting with four.
 */
export function RiskStrip({ risk }: { risk?: RiskConcentration }) {
  const dimensions = Object.keys(risk?.byDimension ?? {});
  const [dimension, setDimension] = useState(dimensions[0] ?? 'vendor');

  if (!risk?.available || !risk.byDimension) return null;

  const rows = (risk.byDimension[dimension] ?? []).slice(0, 6);
  const maxShare = Math.max(...rows.map((r) => r.shareOfRisk), 1);

  return (
    <div className="card overflow-hidden">
      <div className="card-header flex-wrap">
        <div className="min-w-0">
          <h3 className="card-title flex items-center gap-2">
            <IconAlert className="h-4 w-4 text-red-600" />
            Spend At Risk
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Forecast to rise more than {risk.thresholdPct}% over the horizon
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
          {dimensions.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDimension(d)}
              className={clsx(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition',
                d === dimension
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900',
              )}
            >
              {DIMENSION_LABEL[d] ?? d}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-8 px-5 pb-4">
        <div>
          <div className="text-[11px] text-slate-500">Exposed spend</div>
          <div className="mt-0.5 text-[30px] font-bold leading-none tracking-tight text-red-600">
            {formatCurrency(risk.totalSpendAtRisk ?? 0)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            across {risk.partsAtRisk} parts
          </div>
        </div>

        {risk.top4VendorSharePct != null && (
          <div>
            <div className="text-[11px] text-slate-500">Concentration</div>
            <div className="mt-0.5 text-[30px] font-bold leading-none tracking-tight text-slate-900">
              {risk.top4VendorSharePct.toFixed(0)}%
            </div>
            <div className="mt-1 text-[11px] text-slate-500">sits with 4 vendors</div>
          </div>
        )}
      </div>

      <div className="border-t border-slate-200">
        {rows.map((row) => (
          <div
            key={row.name}
            className="flex items-center gap-3 border-b border-slate-100 px-5 py-2 last:border-0"
          >
            <span className="w-44 shrink-0 truncate text-[13px] text-slate-800">
              {row.name}
            </span>
            <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-red-400"
                style={{ width: `${(row.shareOfRisk / maxShare) * 100}%` }}
              />
            </span>
            <span className="w-20 shrink-0 text-right text-[13px] font-medium tabular-nums text-slate-900">
              {formatCurrency(row.spendAtRisk)}
            </span>
            <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-slate-500">
              {row.shareOfRisk.toFixed(0)}%
            </span>
            <span className="w-16 shrink-0 text-right text-[12px] font-medium tabular-nums text-red-600">
              {formatSigned(row.avgIncreasePct, 1)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
