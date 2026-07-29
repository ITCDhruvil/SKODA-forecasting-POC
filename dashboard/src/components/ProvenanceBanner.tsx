import type { DashboardData } from '../types';
import { IconDatabase } from './Icons';

/**
 * Always-visible statement of what is real and what is simulated.
 *
 * The macro trend comes from live BLS data; the per-part panel is synthetic.
 * Presenting simulated per-part accuracy without saying so would be the single
 * most misleading thing this dashboard could do, so the disclaimer is part of
 * the layout rather than buried in a docs page.
 */
export function ProvenanceBanner({ data }: { data: DashboardData }) {
  const { provenance, meta } = data;

  return (
    <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-3">
      <IconDatabase className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
      <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-slate-700">
        <span className="font-semibold text-slate-900">Data provenance:</span>{' '}
        macro price trend is{' '}
        <span className="font-semibold text-blue-700">
          real BLS data ({provenance.macroSeriesId})
        </span>{' '}
        fetched via <span className="font-mono text-[11px]">{provenance.macroSource}</span>. The
        per-part price panel ({meta.nParts} SKUs across {meta.nCategories} categories) is{' '}
        <span className="font-semibold text-amber-700">synthetic</span> &mdash; no public source
        provides monthly prices per automotive SKU. Model rankings transfer; absolute error
        figures on the synthetic panel do not.
        {provenance.extrapolatedMonths > 0 && (
          <>
            {' '}
            <span className="text-slate-500">
              ({provenance.extrapolatedMonths} months back-extrapolated and excluded from
              real-data validation.)
            </span>
          </>
        )}
      </div>
    </div>
  );
}
