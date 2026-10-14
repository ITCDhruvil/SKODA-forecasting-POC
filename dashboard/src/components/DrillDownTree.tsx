import { useMemo, useState } from 'react';
import clsx from 'clsx';
import type {
  Confidence,
  MaterialPartRow,
  TreeCategory,
  TreeMaterial,
  TreePart,
  TreeProject,
  TreeVendor,
} from '../types';
import { formatCurrency, formatSigned } from '../lib/format';
import { IconChevronRight, IconAlert } from './Icons';

/**
 * Project → vendor → category → part → material, expandable.
 *
 * Roll-up bar charts answer "which programme is getting more expensive". They
 * cannot answer "which vendor, on which programme, across which categories" —
 * and that is the question a buyer walks into a negotiation with. One vendor
 * typically supplies several categories on one programme, so the tree keeps
 * that relationship visible instead of flattening it away.
 */
export function DrillDownTree({
  tree,
  horizonMonths,
  onOpenPart,
  onAsk,
  forecastByPart,
}: {
  tree?: TreeProject[];
  horizonMonths: number;
  onOpenPart?: (partId: string) => void;
  onAsk?: (question: string, prompt?: string) => void;
  forecastByPart?: Map<string, MaterialPartRow>;
}) {
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());
  const [openVendors, setOpenVendors] = useState<Set<string>>(new Set());
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());
  const [openParts, setOpenParts] = useState<Set<string>>(new Set());
  const [minConfidence, setMinConfidence] = useState<'all' | 'medium' | 'high'>('all');

  const totals = useMemo(() => {
    const current = (tree ?? []).reduce((s, p) => s + p.currentSpend, 0);
    const forecast = (tree ?? []).reduce((s, p) => s + p.forecastSpend, 0);
    return { current, forecast, changePct: current ? ((forecast - current) / current) * 100 : 0 };
  }, [tree]);

  if (!tree || tree.length === 0) {
    return (
      <div className="card p-6">
        <h3 className="text-[15px] font-semibold text-slate-900">Drill-down unavailable</h3>
        <p className="mt-1 text-sm text-slate-600">
          Regenerate with{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">
            --stage export
          </code>
          .
        </p>
      </div>
    );
  }

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    apply(next);
  };

  const passesFilter = (c: Confidence) =>
    minConfidence === 'all' ||
    (minConfidence === 'high' && c.level === 'high') ||
    (minConfidence === 'medium' && c.level !== 'low');

  return (
    <div className="flex flex-col gap-4">
      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap gap-6">
            <Stat label="Current monthly spend" value={formatCurrency(totals.current)} />
            <Stat
              label={`Forecast (+${horizonMonths} mo)`}
              value={formatCurrency(totals.forecast)}
            />
            <Stat
              label="Projected change"
              value={formatSigned(totals.changePct, 2)}
              tone={totals.changePct >= 0 ? 'bad' : 'good'}
            />
            <Stat label="Projects" value={String(tree.length)} />
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-600">
            Show parts with confidence
            <select
              value={minConfidence}
              onChange={(e) => setMinConfidence(e.target.value as typeof minConfidence)}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
            >
              <option value="all">All</option>
              <option value="medium">Medium and above</option>
              <option value="high">High only</option>
            </select>
          </label>
        </div>

        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
          <strong>Confidence is a signal-to-error ratio, not a probability.</strong> It compares
          the size of the predicted move against the model's typical error at this horizon.{' '}
          <span className="font-medium text-emerald-700">High</span> means the move is at least
          2&times; that error and the direction is worth acting on;{' '}
          <span className="font-medium text-slate-500">low</span> means it sits inside the noise
          and the sign should not be trusted.
        </p>
      </div>

      <div className="card overflow-hidden">
        <div className="card-header">
          <div>
            <h3 className="card-title">
              Project &rarr; Vendor &rarr; Category &rarr; Part &rarr; Material
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Click a row to expand. Click a part name for its price path and forecast
              spend drivers.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-4 border-y border-slate-200 bg-slate-50/60 px-5 py-2 text-[11px] uppercase tracking-wide text-slate-500">
          <span className="font-semibold">Name</span>
          <span className="w-24 text-right font-semibold">Current</span>
          <span className="w-24 text-right font-semibold">Forecast</span>
          <span className="w-20 text-right font-semibold">Change</span>
          <span className="w-40 text-right font-semibold">Confidence / Why</span>
        </div>

        <div className="divide-y divide-slate-100">
          {tree.map((project) => {
            const projectOpen = openProjects.has(project.name);
            return (
              <div key={project.name}>
                <Row
                  depth={0}
                  open={projectOpen}
                  expandable
                  label={project.name}
                  sublabel={`${project.vendorCount} vendors`}
                  current={project.currentSpend}
                  forecast={project.forecastSpend}
                  changePct={project.changePct}
                  onClick={() => toggle(openProjects, project.name, setOpenProjects)}
                />

                {projectOpen &&
                  project.vendors.map((vendor: TreeVendor) => {
                    const vendorKey = `${project.name}|${vendor.name}`;
                    const vendorOpen = openVendors.has(vendorKey);
                    return (
                      <div key={vendorKey}>
                        <Row
                          depth={1}
                          open={vendorOpen}
                          expandable
                          label={vendor.name}
                          badge={vendor.origin === 'international' ? 'intl' : undefined}
                          sublabel={`supplies ${vendor.categoryCount} ${
                            vendor.categoryCount === 1 ? 'category' : 'categories'
                          }`}
                          current={vendor.currentSpend}
                          forecast={vendor.forecastSpend}
                          changePct={vendor.changePct}
                          onClick={() => toggle(openVendors, vendorKey, setOpenVendors)}
                        />

                        {vendorOpen &&
                          vendor.categories.map((category: TreeCategory) => {
                            const catKey = `${vendorKey}|${category.name}`;
                            const catOpen = openCategories.has(catKey);
                            const visibleParts = category.parts.filter((p) =>
                              passesFilter(p.confidence),
                            );
                            return (
                              <div key={catKey}>
                                <Row
                                  depth={2}
                                  open={catOpen}
                                  expandable={visibleParts.length > 0}
                                  label={category.name}
                                  sublabel={`${category.partCount} parts`}
                                  current={category.currentSpend}
                                  forecast={category.forecastSpend}
                                  changePct={category.changePct}
                                  onClick={() =>
                                    toggle(openCategories, catKey, setOpenCategories)
                                  }
                                />

                                {catOpen &&
                                  (visibleParts.length === 0 ? (
                                    <div className="bg-slate-50/40 py-2 pl-20 pr-5 text-[12px] text-slate-500">
                                      No parts meet the selected confidence filter.
                                    </div>
                                  ) : (
                                    visibleParts.map((part: TreePart) => {
                                      const partKey = `${catKey}|${part.partId}`;
                                      const partOpen = openParts.has(partKey);
                                      return (
                                        <PartRow
                                          key={part.partId}
                                          part={part}
                                          open={partOpen}
                                          onToggle={() =>
                                            toggle(openParts, partKey, setOpenParts)
                                          }
                                          onOpen={
                                            onOpenPart
                                              ? () => onOpenPart(part.partId)
                                              : undefined
                                          }
                                          onAsk={onAsk}
                                          forecastRow={forecastByPart?.get(part.partId)}
                                        />
                                      );
                                    })
                                  ))}
                              </div>
                            );
                          })}
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Row({
  depth,
  open,
  expandable,
  label,
  sublabel,
  badge,
  current,
  forecast,
  changePct,
  onClick,
}: {
  depth: number;
  open: boolean;
  expandable: boolean;
  label: string;
  sublabel?: string;
  badge?: string;
  current: number;
  forecast: number;
  changePct: number;
  onClick: () => void;
}) {
  const bg = ['bg-white', 'bg-slate-50/40', 'bg-slate-50/70'][depth] ?? 'bg-white';
  return (
    <button
      type="button"
      onClick={expandable ? onClick : undefined}
      className={clsx(
        'grid w-full grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-4 px-5 py-2.5 text-left transition',
        bg,
        expandable && 'hover:bg-slate-100',
      )}
      style={{ paddingLeft: 20 + depth * 22 }}
    >
      <span className="flex min-w-0 items-center gap-2">
        {expandable ? (
          <IconChevronRight
            className={clsx(
              'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform',
              open && 'rotate-90',
            )}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <span
          className={clsx(
            'truncate',
            depth === 0
              ? 'text-[14px] font-semibold text-slate-900'
              : depth === 1
                ? 'text-[13px] font-medium text-slate-800'
                : 'text-[13px] text-slate-700',
          )}
        >
          {label}
        </span>
        {badge && (
          <span className="pill shrink-0 bg-blue-50 text-blue-700" title="International supplier">
            {badge}
          </span>
        )}
        {sublabel && (
          <span className="shrink-0 text-[11px] text-slate-400">{sublabel}</span>
        )}
      </span>
      <span className="w-24 text-right text-[13px] tabular-nums text-slate-600">
        {formatCurrency(current)}
      </span>
      <span className="w-24 text-right text-[13px] tabular-nums text-slate-900">
        {formatCurrency(forecast)}
      </span>
      <span
        className={clsx(
          'w-20 text-right text-[13px] font-semibold tabular-nums',
          changePct >= 0 ? 'text-red-600' : 'text-emerald-600',
        )}
      >
        {formatSigned(changePct, 2)}
      </span>
      <span className="w-40" />
    </button>
  );
}

const CONFIDENCE_STYLE: Record<Confidence['level'], string> = {
  high: 'bg-emerald-100 text-emerald-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-slate-100 text-slate-500',
};

const FORECAST_INPUTS = [
  ['fx', 'Currency'],
  ['commodity', 'Materials'],
  ['freight', 'Shipping'],
] as const;

function whyQuestion(part: TreePart, row?: MaterialPartRow): { text: string; prompt: string } {
  const fwd = row?.bridgesSopToFc ?? {};
  const lines = FORECAST_INPUTS.map(([key, name]) => {
    const amount = Number(fwd[key] ?? 0);
    return `${name}: ${amount >= 0 ? '+' : ''}${formatCurrency(amount, false)}`;
  });
  const explained = FORECAST_INPUTS.reduce((sum, [key]) => sum + Number(fwd[key] ?? 0), 0);
  const move = part.forecastPrice - part.currentPrice;
  const rest = move - explained;
  const material = row?.material ?? part.materials?.[0]?.name;
  return {
    text: `Why is ${part.partName} forecast ${part.changePct >= 0 ? 'up' : 'down'} ${Math.abs(part.changePct).toFixed(1)}%?`,
    prompt: [
      `Explain in simple language why ${part.partName} (${part.partId}) is forecast to change.`,
      `Call predictPartPrice with partId ${part.partId}. Use its prediction and only its relevantParameters.`,
      `Current price ${formatCurrency(part.currentPrice, false)}. Forecast price ${formatCurrency(part.forecastPrice, false)}. Change ${formatSigned(part.changePct, 2)}.`,
      material ? `Part material: ${material}.` : '',
      `Measured inputs on the forecast window for this part only:`,
      ...lines,
      `Amount not assigned to currency, materials, or shipping: ${rest >= 0 ? '+' : ''}${formatCurrency(rest, false)}.`,
      'These are the only figures for this part. A zero means that input did not move this forecast.',
      'Do not mention geopolitics, world risk, freight stories, or a supplier action unless that input has a non-zero amount above.',
      'A few short sentences: the price change, which of the listed inputs moved it, and what to do.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function PartRow({
  part,
  open,
  onToggle,
  onOpen,
  onAsk,
  forecastRow,
}: {
  part: TreePart;
  open: boolean;
  onToggle: () => void;
  onOpen?: () => void;
  onAsk?: (question: string, prompt?: string) => void;
  forecastRow?: MaterialPartRow;
}) {
  const band =
    part.lower !== null && part.upper !== null
      ? `${formatCurrency(part.lower, false)} – ${formatCurrency(part.upper, false)}`
      : null;

  const materials = part.materials ?? [];
  const expandable = materials.length > 0;

  return (
    <>
      <div
        className={clsx(
          'grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-4 border-l-2 border-slate-200 bg-white py-2 pr-5 text-[12px]',
          expandable && 'hover:bg-slate-50',
        )}
        style={{ paddingLeft: 88 }}
      >
        <div className="flex min-w-0 flex-col text-left">
          <span className="flex items-center gap-2">
            {expandable ? (
              <button
                type="button"
                onClick={onToggle}
                aria-label={open ? 'Collapse part' : 'Expand part'}
                className="shrink-0 text-slate-400"
              >
                <IconChevronRight
                  className={clsx('h-3.5 w-3.5 transition-transform', open && 'rotate-90')}
                />
              </button>
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            <span className="font-mono text-[11px] text-slate-500">{part.partId}</span>
            {part.isAnomaly && (
              <span
                className="pill bg-red-50 text-red-700"
                title={`Structural break: ${part.anomalyType.replace(/_/g, ' ')}`}
              >
                <IconAlert className="h-2.5 w-2.5" />
                break
              </span>
            )}
            {expandable && (
              <span className="shrink-0 text-[11px] text-slate-400">
                {materials.length === 1
                  ? materials[0].name
                  : `${materials.length} materials`}
              </span>
            )}
          </span>
          {onOpen ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpen();
              }}
              className="truncate pl-[22px] text-left text-slate-700 underline-offset-2 hover:text-slate-900 hover:underline"
            >
              {part.partName}
            </button>
          ) : (
            <span className="truncate pl-[22px] text-slate-600">{part.partName}</span>
          )}
          {band && (
            <span className="pl-[22px] text-[10px] text-slate-400">80% interval: {band}</span>
          )}
        </div>
        <span className="w-24 text-right tabular-nums text-slate-600">
          {formatCurrency(part.currentPrice, false)}
        </span>
        <span className="w-24 text-right font-medium tabular-nums text-slate-900">
          {formatCurrency(part.forecastPrice, false)}
        </span>
        <span
          className={clsx(
            'w-20 text-right font-semibold tabular-nums',
            part.changePct >= 0 ? 'text-red-600' : 'text-emerald-600',
          )}
        >
          {formatSigned(part.changePct, 2)}
        </span>
        <span className="flex w-40 justify-end items-center gap-2">
          <span
            className={clsx('pill', CONFIDENCE_STYLE[part.confidence.level])}
            title={`Predicted move is ${part.confidence.signalToErrorRatio}x the model's typical ${part.confidence.expectedErrorPct}% error at this horizon`}
          >
            {part.confidence.level}
          </span>
          <button
            type="button"
            onClick={() => {
              const question = whyQuestion(part, forecastRow);
              onAsk?.(question.text, question.prompt);
            }}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!onAsk}
            title="Explain this part's forecast drivers"
          >
            Why?
          </button>
        </span>
      </div>

      {open &&
        materials.map((material: TreeMaterial) => (
          <MaterialRow key={material.name} material={material} />
        ))}
    </>
  );
}

function MaterialRow({ material }: { material: TreeMaterial }) {
  const commodity = material.bridges?.commodity;
  return (
    <div
      className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-4 border-l-2 border-amber-200 bg-amber-50/30 py-2 pr-5 text-[12px]"
      style={{ paddingLeft: 110 }}
    >
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-2">
          <span className="w-3.5 shrink-0" />
          <span className="truncate text-[13px] font-medium text-slate-800">
            {material.name}
          </span>
          <span className="shrink-0 text-[11px] text-slate-400">material · BG → FC</span>
        </span>
        {commodity != null && (
          <span className="pl-[22px] text-[10px] text-slate-400">
            Commodity bridge {formatCurrency(commodity, false)}
          </span>
        )}
      </span>
      <span
        className="w-24 text-right tabular-nums text-slate-600"
        title="Budget (BG) — Material Cost baseline"
      >
        {formatCurrency(material.currentPrice, false)}
      </span>
      <span
        className="w-24 text-right font-medium tabular-nums text-slate-900"
        title="Forecast (FC) — Material Cost"
      >
        {formatCurrency(material.forecastPrice, false)}
      </span>
      <span
        className={clsx(
          'w-20 text-right font-semibold tabular-nums',
          material.changePct >= 0 ? 'text-red-600' : 'text-emerald-600',
        )}
        title="BG → FC variance"
      >
        {formatSigned(material.changePct, 2)}
      </span>
      <span className="w-40" />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div
        className={clsx(
          'mt-0.5 text-[19px] font-bold leading-none',
          tone === 'bad' ? 'text-red-600' : tone === 'good' ? 'text-emerald-600' : 'text-slate-900',
        )}
      >
        {value}
      </div>
    </div>
  );
}
