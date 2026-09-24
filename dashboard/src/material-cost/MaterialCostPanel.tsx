import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { MaterialCost, MaterialPartRow, MaterialWalkId } from '../types';
import { formatSigned, formatSpend } from '../lib/format';
import { IconInfo } from '../components/Icons';
import { CostWalkWaterfall } from './CostWalkWaterfall';
import { PriceMovementTracker } from './PriceMovementTracker';
import { MaterialPartsTable } from './MaterialPartsTable';
import { HierarchyFilterBar } from './HierarchyFilterBar';
import { PartDetailDrawer } from './PartDetailDrawer';
import {
  EMPTY_HIERARCHY_FILTERS,
  deriveMaterialCostView,
  type HierarchyFilterState,
} from './deriveMaterialCostView';

interface Props {
  materialCost?: MaterialCost;
  /** When set from the main forecast chart, open this walk and driver. */
  focus?: { walk: MaterialWalkId; bridge: string | null } | null;
}

const KPI_HELP = {
  budget:
    'Sum of nomination-month unit prices across parts — same unit-price basis as the main dashboard basket / hierarchy.',
  sop: 'Sum of SOP-month unit prices across parts (start of production / current).',
  forecast:
    'Sum of primary-model horizon unit prices — matches the main Forecast basket total.',
  variance:
    'How much total cost moved from Budget to Forecast. Red means cost up; green means cost down.',
} as const;

const WALK_META: Record<
  MaterialWalkId,
  { title: string; subtitle: string; label: string }
> = {
  bg_to_fc: {
    label: 'Full period',
    title: 'Why cost changed',
    subtitle: 'Budget to forecast — click a reason to see those parts',
  },
  nom_to_sop: {
    label: 'History',
    title: 'Why cost changed (history)',
    subtitle: 'From nomination to today’s production price',
  },
  sop_to_fc: {
    label: 'Forecast',
    title: 'Why cost may change next',
    subtitle: 'From today to the forecast horizon',
  },
};

/**
 * Material Cost Dashboard — price tracker, aligned cost walks, part drill-down.
 */
export function MaterialCostPanel({ materialCost, focus }: Props) {
  const [bridgeFilter, setBridgeFilter] = useState<string | null>(focus?.bridge ?? null);
  const [filters, setFilters] = useState<HierarchyFilterState>(EMPTY_HIERARCHY_FILTERS);
  const [walk, setWalk] = useState<MaterialWalkId>(focus?.walk ?? 'bg_to_fc');
  const [selectedPart, setSelectedPart] = useState<MaterialPartRow | null>(null);

  useEffect(() => {
    if (!focus) return;
    setWalk(focus.walk);
    setBridgeFilter(focus.bridge);
  }, [focus]);

  const view = useMemo(() => {
    if (!materialCost?.available) return null;
    return deriveMaterialCostView(materialCost, filters, walk);
  }, [materialCost, filters, walk]);

  if (!materialCost?.available || !view) {
    return (
      <div className="card p-6">
        <h3 className="text-[15px] font-semibold text-slate-900">
          Material Cost data not available
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          {materialCost?.reason ??
            'Regenerate the dashboard payload to include the materialCost block.'}
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-[12px] text-slate-100">
          python -m price_forecasting.pipeline --stage export
        </pre>
      </div>
    );
  }

  const allParts = materialCost.parts ?? [];
  const { summary, waterfall, priceSeries, parts, isScoped, nPartsTotal } = view;
  const walkMeta = WALK_META[walk];

  return (
    <div className="flex flex-col gap-4">
      <HierarchyFilterBar
        parts={allParts}
        filters={filters}
        onChange={(next) => {
          setFilters(next);
          setBridgeFilter(null);
        }}
        matchingCount={parts.length}
        totalCount={nPartsTotal}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Budget (BG) spend"
          tip={KPI_HELP.budget}
          value={formatSpend(summary.budgetSpend)}
          hint={
            isScoped
              ? `${summary.nParts} parts · ${materialCost.milestones?.nomination.label ?? ''}`
              : materialCost.milestones?.nomination.label
          }
        />
        <Kpi
          label="SOP / current spend"
          tip={KPI_HELP.sop}
          value={formatSpend(summary.sopSpend)}
          hint={
            isScoped
              ? `${summary.nParts} parts · ${materialCost.milestones?.sop.label ?? ''}`
              : materialCost.milestones?.sop.label
          }
        />
        <Kpi
          label="Forecast (FC) spend"
          tip={KPI_HELP.forecast}
          value={formatSpend(summary.forecastSpend)}
          hint={
            isScoped
              ? `${summary.nParts} parts · ${materialCost.milestones?.forecast.label ?? ''}`
              : materialCost.milestones?.forecast.label
          }
        />
        <Kpi
          label="BG → FC variance"
          tip={KPI_HELP.variance}
          value={formatSigned(summary.variancePct, 2)}
          hint={`${formatSpend(summary.varianceAbs, true)}${
            materialCost.spendBasis ? ` · ${materialCost.spendBasis}` : ''
          }`}
          tone={summary.variancePct >= 0 ? 'up' : 'down'}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <PriceMovementTracker
          series={priceSeries}
          milestones={materialCost.milestones}
          scoped={isScoped}
        />
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Period
            </span>
            {(Object.keys(WALK_META) as MaterialWalkId[]).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setWalk(id);
                  setBridgeFilter(null);
                }}
                className={clsx(
                  'rounded-lg px-2.5 py-1 text-[12px] font-medium transition',
                  walk === id
                    ? 'bg-slate-900 text-white'
                    : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                )}
              >
                {WALK_META[id].label}
              </button>
            ))}
          </div>
          <CostWalkWaterfall
            steps={waterfall}
            activeId={bridgeFilter}
            onSelect={setBridgeFilter}
            title={walkMeta.title}
            subtitle={walkMeta.subtitle}
          />
        </div>
      </div>

      <MaterialPartsTable
        parts={parts}
        bridgeFilter={bridgeFilter}
        onClearBridge={() => setBridgeFilter(null)}
        onSelectPart={setSelectedPart}
      />

      {selectedPart ? (
        <PartDetailDrawer part={selectedPart} onClose={() => setSelectedPart(null)} />
      ) : null}
    </div>
  );
}

function Kpi({
  label,
  tip,
  value,
  hint,
  tone,
}: {
  label: string;
  tip: string;
  value: string;
  hint?: string;
  tone?: 'up' | 'down';
}) {
  return (
    <div className="card px-5 py-4">
      <div className="group relative inline-flex max-w-full items-center gap-1">
        <span className="cursor-help text-[12px] font-medium text-slate-500 underline decoration-slate-300 decoration-dotted underline-offset-2">
          {label}
        </span>
        <IconInfo className="h-3.5 w-3.5 text-slate-300 transition group-hover:text-slate-500" />
        <div
          role="tooltip"
          className="pointer-events-none absolute left-0 top-full z-20 mt-2 hidden w-56 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-slate-600 shadow-lg group-hover:block"
        >
          {tip}
        </div>
      </div>
      <div
        className={clsx(
          'mt-1.5 text-[22px] font-bold tabular-nums',
          tone === 'up'
            ? 'text-red-600'
            : tone === 'down'
              ? 'text-emerald-600'
              : 'text-slate-900',
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-1 text-[11px] text-slate-500">{hint}</div> : null}
    </div>
  );
}
