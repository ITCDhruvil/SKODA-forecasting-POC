import clsx from 'clsx';
import type { PartRow } from '../types';
import { formatCurrency, formatSigned } from '../lib/format';
import { IconArrowDown, IconArrowUp } from './Icons';

/** Inline sparkline. Rendered directly as SVG - no charting library per row. */
function Sparkline({ values, positive }: { values: number[]; positive: boolean }) {
  if (values.length < 2) return <div className="h-6 w-[70px]" />;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = 70;
  const height = 24;

  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline
        points={points}
        fill="none"
        stroke={positive ? '#10b981' : '#ef4444'}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface Props {
  parts: PartRow[];
  limit?: number;
  onSelect?: (partId: string) => void;
}

export function TopPartsTable({ parts, limit, onSelect }: Props) {
  const rows = limit ? parts.slice(0, limit) : parts;

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <div>
          <h3 className="card-title">Largest Forecast Price Moves</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Ranked by absolute change over the forecast horizon
            {onSelect ? ' · click a row for the price path' : ''}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-y border-slate-200 bg-slate-50/60 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-5 py-2.5 font-semibold">Part</th>
              <th className="px-3 py-2.5 font-semibold">Part No.</th>
              <th className="px-3 py-2.5 font-semibold">Project</th>
              <th className="px-3 py-2.5 font-semibold">Vendor</th>
              <th className="px-3 py-2.5 font-semibold">Category</th>
              <th className="px-3 py-2.5 text-right font-semibold">Current</th>
              <th className="px-3 py-2.5 text-right font-semibold">Forecast</th>
              <th className="px-3 py-2.5 text-right font-semibold">Change</th>
              <th className="px-5 py-2.5 font-semibold">Trend</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((part) => {
              const positive = part.change >= 0;
              return (
                <tr
                  key={part.partId}
                  onClick={() => onSelect?.(part.partId)}
                  className={clsx(
                    'transition hover:bg-slate-50',
                    onSelect && 'cursor-pointer',
                  )}
                >
                  <td className="px-5 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-900">{part.component}</span>
                      {part.isAnomaly && (
                        <span
                          className="pill bg-red-50 text-red-700"
                          title={`Structural break: ${part.anomalyType.replace(/_/g, ' ')}`}
                        >
                          break
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-slate-500">
                      {part.partName}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-slate-600">
                    {part.partId}
                  </td>
                  <td className="px-3 py-2.5 text-slate-700">{part.project ?? '--'}</td>
                  <td className="px-3 py-2.5">
                    <span className="text-slate-700">{part.vendor ?? part.brand}</span>
                    {part.vendorOrigin === 'international' && (
                      <span
                        className="pill ml-1.5 bg-blue-50 text-blue-700"
                        title="International supplier - higher direct FX exposure"
                      >
                        intl
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-slate-600">{part.category}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                    {formatCurrency(part.currentPrice, false)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums text-slate-900">
                    {formatCurrency(part.forecastPrice, false)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span
                      className={clsx(
                        'inline-flex items-center gap-0.5 font-semibold tabular-nums',
                        positive ? 'text-emerald-600' : 'text-red-600',
                      )}
                    >
                      {positive ? <IconArrowUp /> : <IconArrowDown />}
                      {formatSigned(part.change)}
                    </span>
                  </td>
                  <td className="px-5 py-2.5">
                    <Sparkline values={part.sparkline} positive={positive} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
