import { useMemo, useState } from 'react';
import clsx from 'clsx';
import type {
  Confidence,
  MaterialPartRow,
  TreeMaterial,
  TreePart,
  TreeProject,
} from '../types';
import { formatCurrency, formatSigned } from '../lib/format';
import { marketFactorBrief } from '../lib/marketFactors';
import { friendlyPartName, realisticPrice, sampleMaterials } from '../lib/friendlyParts';
import { IconAlert } from './Icons';

type Level = 'project' | 'vendor' | 'category' | 'part' | 'material';
const DEFAULT_ORDER: Level[] = ['project', 'vendor', 'category', 'part', 'material'];
const LEVEL_META: Record<Level, { label: string; plural: string }> = {
  project: { label: 'Project', plural: 'projects' },
  vendor: { label: 'Vendor', plural: 'vendors' },
  category: { label: 'Category', plural: 'categories' },
  part: { label: 'Part', plural: 'parts' },
  material: { label: 'Material', plural: 'materials' },
};

/**
 * Finest-grain row: one material line of one part. Spend exists in the data only per
 * project + vendor + category, so it is allocated down to parts (by price share) and then to
 * materials (by cost share). The allocation is an estimate, but it adds up exactly, so any
 * level order rolls up to the same totals.
 */
interface Rec {
  project: string;
  vendor: string;
  origin: string;
  category: string;
  partId: string;
  part: TreePart;
  /** This part's material line, or null when the part has none. */
  material: TreeMaterial | null;
  materialName: string;
  current: number;
  forecast: number;
}
interface GroupNode {
  key: string;
  level: Level;
  label: string;
  origin?: string;
  currentSpend: number;
  forecastSpend: number;
  changePct: number;
  children: GroupNode[];
  recs: Rec[];
  /** A Part level sits above this node, so a material here is one part's own cost line. */
  partAbove: boolean;
}

/**
 * Replaces the single pipeline material with a sample bill of materials whose lines add up to
 * the part's budget and forecast price (so the forecast total sits inside the Interval).
 * Falls back to the original single row for categories without a template.
 */
function sampleBom(
  part: TreePart,
  category: string,
  k: number,
  s: (v: number | null | undefined) => number | null | undefined,
): TreeMaterial[] | undefined {
  const original = part.materials ?? [];
  const primary = original[0];
  const scaledOriginal = original.map((m) => ({
    ...m,
    currentPrice: m.currentPrice * k,
    forecastPrice: m.forecastPrice * k,
    changeAbs: m.changeAbs * k,
    sopPrice: s(m.sopPrice),
    bridges: m.bridges ? Object.fromEntries(Object.entries(m.bridges).map(([key, v]) => [key, s(v)])) : m.bridges,
  }));
  if (!primary) return scaledOriginal;
  const lines = sampleMaterials(category, part.partId, primary.name, part.currentPrice * k, part.forecastPrice * k);
  if (!lines) return scaledOriginal;
  const keep = scaledOriginal[0].bridges;
  return lines.map((l) => ({
    name: l.name,
    currentPrice: l.bg,
    forecastPrice: l.fc,
    changeAbs: l.fc - l.bg,
    changePct: l.bg ? ((l.fc - l.bg) / l.bg) * 100 : 0,
    // Only the real material keeps its pipeline bridges (Polycarbonate keeps its commodity figure).
    bridges: l.primary && keep ? { fx: keep.fx, commodity: keep.commodity, freight: keep.freight } : undefined,
    basis: 'bg_to_fc' as const,
    unit: l.unit,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    isSample: true,
  }));
}

function scalePart(part: TreePart, category: string, seedId: string, slot: number): TreePart {
  const price = realisticPrice(category, part.partId);
  const k = price && part.currentPrice > 0 ? price / part.currentPrice : 1;
  const s = (v: number | null | undefined) => (v == null ? v : v * k);
  return {
    ...part,
    partName: friendlyPartName(category, seedId, slot, part.partName),
    currentPrice: part.currentPrice * k,
    forecastPrice: part.forecastPrice * k,
    changeAbs: part.changeAbs * k,
    lower: part.lower === null ? null : part.lower * k,
    upper: part.upper === null ? null : part.upper * k,
    materials: sampleBom(part, category, k, s),
  };
}

function flattenTree(tree: TreeProject[]): Rec[] {
  const recs: Rec[] = [];
  for (const p of tree) {
    for (const v of p.vendors) {
      for (const c of v.categories) {
        const parts = c.parts.map((part, slot) => scalePart(part, c.name, c.parts[0].partId, slot));
        const curTotal = parts.reduce((s, x) => s + x.currentPrice, 0);
        const fcTotal = parts.reduce((s, x) => s + x.forecastPrice, 0);
        for (const part of parts) {
          // Part share of the category's spend, by price.
          const partCur = curTotal ? c.currentSpend * (part.currentPrice / curTotal) : 0;
          const partFc = fcTotal ? c.forecastSpend * (part.forecastPrice / fcTotal) : 0;
          const mats = part.materials && part.materials.length > 0 ? part.materials : [null];
          const matCur = mats.reduce((s, m) => s + (m ? m.currentPrice : 0), 0);
          const matFc = mats.reduce((s, m) => s + (m ? m.forecastPrice : 0), 0);
          for (const m of mats) {
            const curShare = m ? (matCur ? m.currentPrice / matCur : 0) : 1;
            const fcShare = m ? (matFc ? m.forecastPrice / matFc : 0) : 1;
            recs.push({
              project: p.name,
              vendor: v.name,
              origin: v.origin,
              category: c.name,
              partId: part.partId,
              part,
              material: m,
              materialName: m ? m.name : 'No material data',
              current: partCur * curShare,
              forecast: partFc * fcShare,
            });
          }
        }
      }
    }
  }
  return recs;
}

function recValue(rec: Rec, level: Level): string {
  return level === 'part' ? rec.partId : level === 'material' ? rec.materialName : rec[level];
}

/** Regroup the flat records by the chosen level order; spend rolls up from the records. */
function groupRecs(recs: Rec[], order: Level[], depth: number, parentKey: string): GroupNode[] {
  const level = order[depth];
  const groups = new Map<string, Rec[]>();
  for (const rec of recs) {
    const name = recValue(rec, level);
    const list = groups.get(name);
    if (list) list.push(rec);
    else groups.set(name, [rec]);
  }
  return [...groups.entries()].map(([name, members]) => {
    const key = `${parentKey}${level}:${name}|`;
    const currentSpend = members.reduce((s, r) => s + r.current, 0);
    const forecastSpend = members.reduce((s, r) => s + r.forecast, 0);
    return {
      key,
      level,
      label: level === 'part' ? members[0].part.partName : name,
      origin: members[0].origin,
      currentSpend,
      forecastSpend,
      changePct: currentSpend ? ((forecastSpend - currentSpend) / currentSpend) * 100 : 0,
      children: depth + 1 < order.length ? groupRecs(members, order, depth + 1, key) : [],
      recs: members,
      partAbove: order.slice(0, depth).includes('part'),
    };
  });
}

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
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [order, setOrder] = useState<Level[]>(DEFAULT_ORDER);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [minConfidence, setMinConfidence] = useState<'all' | 'medium' | 'high'>('all');

  const recs = useMemo(() => flattenTree(tree ?? []), [tree]);
  const groups = useMemo(() => groupRecs(recs, order, 0, ''), [recs, order]);

  const moveLevel = (from: number, to: number) => {
    if (from === to) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setOrder(next);
    setOpen(new Set());
  };

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

  const toggle = (key: string) => {
    const next = new Set(open);
    next.has(key) ? next.delete(key) : next.add(key);
    setOpen(next);
  };

  const passesFilter = (c: Confidence) =>
    minConfidence === 'all' ||
    (minConfidence === 'high' && c.level === 'high') ||
    (minConfidence === 'medium' && c.level !== 'low');

  const distinctParts = (node: GroupNode) => new Set(node.recs.map((r) => r.partId)).size;

  const renderNode = (node: GroupNode, depth: number): React.ReactNode => {
    const rec = node.recs[0];
    if (node.level === 'part' && !passesFilter(rec.part.confidence)) return null;
    const nodeOpen = open.has(node.key);
    const kids = node.children.map((child) => renderNode(child, depth + 1)).filter(Boolean);
    const hasChildren = node.children.length > 0;
    const est = `est. spend ${formatCurrency(node.currentSpend)} → ${formatCurrency(node.forecastSpend)}`;
    const body = nodeOpen && kids;

    if (node.level === 'part') {
      return (
        <div key={node.key}>
          <PartRow
            part={rec.part}
            depth={depth}
            open={nodeOpen}
            expandable={hasChildren}
            estSpend={est}
            onToggle={() => toggle(node.key)}
            onOpen={onOpenPart ? () => onOpenPart(rec.partId) : undefined}
            onAsk={onAsk}
            forecastRow={forecastByPart?.get(rec.partId)}
            whyContext={{ category: rec.category, vendor: rec.vendor, origin: rec.origin, project: rec.project }}
          />
          {body}
        </div>
      );
    }

    if (node.level === 'material' && node.partAbove && rec.material) {
      return (
        <div key={node.key}>
          <MaterialRow
            material={rec.material}
            depth={depth}
            open={nodeOpen}
            expandable={hasChildren}
            estSpend={est}
            onToggle={() => toggle(node.key)}
          />
          {body}
        </div>
      );
    }

    const count = hasChildren ? node.children.length : distinctParts(node);
    return (
      <div key={node.key}>
        <Row
          depth={depth}
          open={nodeOpen}
          expandable={hasChildren}
          label={node.label}
          badge={node.level === 'vendor' && node.origin === 'international' ? 'intl' : undefined}
          kind={node.level}
          count={count}
          countLabel={hasChildren ? undefined : 'parts'}
          title={`${LEVEL_META[node.level].label}: ${node.label}`}
          current={node.currentSpend}
          forecast={node.forecastSpend}
          changePct={node.changePct}
          onClick={() => toggle(node.key)}
        />
        {body}
      </div>
    );
  };

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
        <div className="px-5 pb-3 pt-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {order.map((level, i) => (
              <div key={level} className="flex items-center gap-1.5">
                {i > 0 && <IconCaret className="h-3.5 w-3.5 text-slate-400" />}
                <div
                  draggable
                  onDragStart={(e) => {
                    setDragFrom(i);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(i));
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(i);
                  }}
                  onDragLeave={() => setDragOver((v) => (v === i ? null : v))}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = Number(e.dataTransfer.getData('text/plain'));
                    if (Number.isInteger(from)) moveLevel(from, i);
                    setDragFrom(null);
                    setDragOver(null);
                  }}
                  onDragEnd={() => {
                    setDragFrom(null);
                    setDragOver(null);
                  }}
                  title="Drag the box to reorder, or use the arrow to pick a level"
                  className={clsx(
                    'relative flex h-10 min-w-[150px] cursor-grab items-center gap-2 rounded-lg border bg-white pl-3 pr-8 text-[13px] font-medium text-slate-800 shadow-sm focus-within:ring-2 focus-within:ring-blue-200 active:cursor-grabbing',
                    dragOver === i && dragFrom !== i ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200',
                    dragFrom === i && 'opacity-40',
                  )}
                >
                  <span aria-hidden className="select-none text-slate-300">&#8942;&#8942;</span>
                  <LevelIcon kind={level} className="h-4 w-4 text-blue-600" />
                  {LEVEL_META[level].label}
                  <select
                    aria-label={`Level ${i + 1}`}
                    value={level}
                    onChange={(e) => {
                      const to = order.indexOf(e.target.value as Level);
                      moveLevel(to, i);
                    }}
                    className="absolute inset-y-0 right-0 w-9 cursor-pointer opacity-0"
                  >
                    {DEFAULT_ORDER.map((l) => (
                      <option key={l} value={l}>
                        {LEVEL_META[l].label}
                      </option>
                    ))}
                  </select>
                  <IconCaretDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-slate-400" />
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                setOrder(DEFAULT_ORDER);
                setOpen(new Set());
              }}
              className="ml-auto flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50"
            >
              <IconReset className="h-4 w-4 text-blue-600" />
              Reset
            </button>
          </div>
          <p className="mt-3 text-[13px] text-slate-500">
            Explore procurement spend across your hierarchy. Drag any level box, or use its
            menu, to regroup the tree. Spend below the project, vendor and category level is
            estimated by price share. Click a part name for its price path and forecast drivers.
          </p>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[1080px]">
        <div className={clsx(GRID, 'border-y border-slate-200 bg-slate-50/70 px-5 py-3 text-[13px] font-medium text-slate-600')}>
          <span>Name</span>
          <span className="text-right">Current Spend</span>
          <span className="text-right">Forecast Spend</span>
          <span className="text-right">Variance</span>
          <span>Confidence / Drivers</span>
        </div>

        <div className="divide-y divide-slate-100">{groups.map((node) => renderNode(node, 0))}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const GRID = 'grid grid-cols-[minmax(0,1fr)_120px_120px_100px_220px] items-center gap-x-4';
const INDENT = 28;

const ICON_PATHS: Record<Level | 'part' | 'material', string> = {
  project: 'M4 4h16v16H4zM8 16v-4M12 16V8M16 16v-6',
  category: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  vendor: 'M5 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17M15 9h3a1 1 0 0 1 1 1v11M3 21h18M9 7h2M9 11h2M9 15h2',
  part: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  material: 'm21 16-9 5-9-5V8l9-5 9 5zM3 8l9 5 9-5M12 13v8',
};

function LevelIcon({ kind, className }: { kind: Level | 'part' | 'material'; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICON_PATHS[kind]} />
    </svg>
  );
}

const svgProps = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const IconCaret = ({ className }: { className?: string }) => (
  <svg className={className} {...svgProps}><path d="m9 6 6 6-6 6" /></svg>
);
const IconCaretDown = ({ className }: { className?: string }) => (
  <svg className={className} {...svgProps}><path d="m6 9 6 6 6-6" /></svg>
);
const IconReset = ({ className }: { className?: string }) => (
  <svg className={className} {...svgProps}><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" /></svg>
);
const IconShield = ({ className }: { className?: string }) => (
  <svg className={className} {...svgProps}><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6zM9 12l2 2 4-4" /></svg>
);
const IconArrow = ({ up, className }: { up: boolean; className?: string }) => (
  <svg className={className} {...svgProps}><path d={up ? 'M12 19V5M6 11l6-6 6 6' : 'M12 5v14M6 13l6 6 6-6'} /></svg>
);

const LEVEL_TILE: Record<Level | 'part' | 'material', string> = {
  project: 'bg-blue-50 text-blue-600',
  category: 'bg-blue-50 text-blue-500',
  vendor: 'bg-indigo-50 text-indigo-600',
  part: 'bg-slate-100 text-slate-500',
  material: 'bg-amber-50 text-amber-600',
};

function Variance({ pct }: { pct: number }) {
  const up = pct >= 0;
  return (
    <span className={clsx('flex items-center justify-end gap-1 text-[13px] font-semibold tabular-nums', up ? 'text-red-600' : 'text-emerald-600')}>
      <IconArrow up={up} className="h-3.5 w-3.5" />
      {Math.abs(pct).toFixed(2)}%
    </span>
  );
}

/** Vertical nesting guides drawn at each ancestor depth. */
function Guides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, d) => (
        <span key={d} className="pointer-events-none absolute bottom-0 top-0 w-px bg-slate-200" style={{ left: 33 + d * INDENT }} />
      ))}
    </>
  );
}

function Row({
  depth,
  kind,
  open,
  expandable,
  label,
  count,
  countLabel,
  badge,
  title,
  current,
  forecast,
  changePct,
  onClick,
}: {
  depth: number;
  kind: Level;
  open: boolean;
  expandable: boolean;
  label: string;
  count?: number;
  countLabel?: string;
  badge?: string;
  title?: string;
  current: number;
  forecast: number;
  changePct: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={expandable ? onClick : undefined}
      title={title}
      className={clsx(GRID, 'relative w-full bg-white py-3 pr-5 text-left transition', expandable && 'hover:bg-slate-50')}
      style={{ paddingLeft: 20 + depth * INDENT }}
    >
      <Guides depth={depth} />
      <span className="flex min-w-0 items-center gap-2.5">
        <IconCaretDown
          className={clsx('h-4 w-4 shrink-0 text-slate-500 transition-transform', !open && '-rotate-90', !expandable && 'invisible')}
        />
        <span className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', LEVEL_TILE[kind])}>
          <LevelIcon kind={kind} className="h-4 w-4" />
        </span>
        <span className={clsx('truncate text-[14px]', depth === 0 ? 'font-semibold text-slate-900' : 'font-medium text-slate-800')}>
          {label}
        </span>
        <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{LEVEL_META[kind].label}</span>
        {badge && <span className="pill shrink-0 bg-blue-50 text-blue-700" title="International supplier">{badge}</span>}
        {count != null && <span className="shrink-0 text-[12px] text-slate-400">({count}{countLabel ? ` ${countLabel}` : ''})</span>}
      </span>
      <span className="text-right text-[13px] tabular-nums text-slate-700">{formatCurrency(current)}</span>
      <span className="text-right text-[13px] tabular-nums text-slate-900">{formatCurrency(forecast)}</span>
      <Variance pct={changePct} />
      <span className="text-slate-400">&ndash;</span>
    </button>
  );
}

const CONFIDENCE_STYLE: Record<Confidence['level'], string> = {
  high: 'bg-emerald-100 text-emerald-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-slate-100 text-slate-500',
};

const BRIDGE_LABELS: Array<[string, string]> = [
  ['commodity', 'Commodity (raw material)'],
  ['fx', 'Currency'],
  ['freight', 'Freight'],
  ['vendorReprice', 'Supplier repricing'],
  ['mix', 'Mix'],
  ['seasonality', 'Seasonality'],
];

/** Share of the budget-to-forecast move that the model attributes to each cost bridge. Scale-free. */
function bridgeShares(row: MaterialPartRow | undefined): string[] {
  const bridges: Record<string, number | null | undefined> = row?.bridges ?? {};
  const items = BRIDGE_LABELS.map(([key, name]) => [name, Number(bridges[key] ?? 0)] as const).filter(([, v]) => v !== 0);
  const total = items.reduce((s, [, v]) => s + Math.abs(v), 0);
  if (total === 0) return [];
  return items
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([name, v]) => `  - ${name}: ${Math.round((Math.abs(v) / total) * 100)}% of the move, ${v >= 0 ? 'pushing the price up' : 'pulling the price down'}`);
}

/** Bill-of-materials lines (sample illustration), biggest cost movers first. */
function materialMoveLines(part: TreePart): string[] {
  const mats = (part.materials ?? []).filter((m) => m.currentPrice > 0);
  if (mats.length === 0) return [];
  const ranked = [...mats].sort((a, b) => Math.abs(b.changeAbs) - Math.abs(a.changeAbs));
  return [
    `Cost build-up by material (SAMPLE illustration, per part, budget to forecast), biggest movers first:`,
    ...ranked.map(
      (m) =>
        `  - ${m.name}: ${formatCurrency(m.currentPrice, false)} to ${formatCurrency(m.forecastPrice, false)} (${formatSigned(m.changePct, 1)})`,
    ),
  ];
}

function whyQuestion(
  part: TreePart,
  row: MaterialPartRow | undefined,
  ctx: { category: string; vendor: string; origin: string; project: string },
): { text: string; prompt: string } {
  const direction = part.changePct >= 0 ? 'up' : 'down';
  const shares = bridgeShares(row);
  const band =
    part.lower !== null && part.upper !== null
      ? ` Forecast interval ${formatCurrency(part.lower, false)} to ${formatCurrency(part.upper, false)}.`
      : '';
  return {
    text: `Why is ${part.partName} forecast ${direction} ${Math.abs(part.changePct).toFixed(1)}%?`,
    prompt: [
      `Explain in simple language why ${part.partName} (${part.partId}) is forecast to go ${direction}, the way a procurement analyst briefs a buyer.`,
      `Call predictPartPrice with partId ${part.partId} only to read its relevantParameters. Quote every price from THIS message, not from the tool, because this is what the buyer sees on screen.`,
      `Current price ${formatCurrency(part.currentPrice, false)}. Forecast price ${formatCurrency(part.forecastPrice, false)}. Change ${formatSigned(part.changePct, 2)}.${band}`,
      shares.length > 0 ? 'What the forecast model attributes the move to (shares of the move):' : '',
      ...shares,
      ...materialMoveLines(part),
      ...marketFactorBrief({
        ...ctx,
        materials: (part.materials ?? []).map((m) => m.name),
        direction,
      }),
      'Answer in four short parts with these headings.',
      '"Why the price moves": size of the move and the model\'s biggest driver, two sentences.',
      '"Real-world reasons": 3 to 5 bullets from the brief that best fit this direction, category and supplier. Say how each reaches this part and name the material it hits. Call them likely market reasons, not model-measured. No new numbers.',
      '"Material cost impact": which materials moved most and why (the cost build-up is a sample illustration).',
      '"What to do": one action for the buyer. Under 14 short sentences, no jargon.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function PartRow({
  part,
  depth,
  open,
  expandable,
  estSpend,
  onToggle,
  onOpen,
  onAsk,
  forecastRow,
  whyContext,
}: {
  part: TreePart;
  depth: number;
  open: boolean;
  expandable: boolean;
  estSpend: string;
  onToggle: () => void;
  onOpen?: () => void;
  onAsk?: (question: string, prompt?: string) => void;
  forecastRow?: MaterialPartRow;
  whyContext: { category: string; vendor: string; origin: string; project: string };
}) {
  const band =
    part.lower !== null && part.upper !== null
      ? `${formatCurrency(part.lower, false)} – ${formatCurrency(part.upper, false)}`
      : null;
  const materials = part.materials ?? [];

  return (
    <>
      <div
        className={clsx(GRID, 'relative bg-white py-3 pr-5 text-[13px] hover:bg-slate-50')}
        style={{ paddingLeft: 20 + depth * INDENT }}
      >
        <Guides depth={depth} />
        <div className="flex min-w-0 items-start gap-2.5">
          <button
            type="button"
            onClick={onToggle}
            aria-label={open ? 'Collapse materials' : 'Expand materials'}
            className={clsx('mt-1.5 shrink-0 text-slate-500', !expandable && 'invisible')}
          >
            <IconCaretDown className={clsx('h-4 w-4 transition-transform', !open && '-rotate-90')} />
          </button>
          <span className={clsx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md', LEVEL_TILE.part)}>
            <LevelIcon kind="part" className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[13px] font-semibold text-slate-900">{part.partId}</span>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">Part</span>
              <span
                onClick={onOpen}
                className={clsx('truncate text-[13px] text-slate-600', onOpen && 'cursor-pointer underline-offset-2 hover:text-slate-900 hover:underline')}
              >
                {part.partName}
              </span>
              {part.isAnomaly && (
                <span className="pill bg-red-50 text-red-700" title={`Structural break: ${part.anomalyType.replace(/_/g, ' ')}`}>
                  <IconAlert className="h-2.5 w-2.5" />
                  break
                </span>
              )}
              {expandable && (
                <span className="text-[11px] text-slate-400">
                  {materials.length === 1 ? materials[0].name : `${materials.length} materials`}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[12px] text-slate-400">
              {band ? `Interval: ${band} \u00b7 ` : ''}
              {estSpend}
            </div>
          </div>
        </div>
        <span className="text-right tabular-nums text-slate-700">{formatCurrency(part.currentPrice, false)}</span>
        <span className="text-right font-medium tabular-nums text-slate-900">{formatCurrency(part.forecastPrice, false)}</span>
        <Variance pct={part.changePct} />
        <span className="flex items-center gap-2">
          <span
            className={clsx('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium capitalize', CONFIDENCE_STYLE[part.confidence.level])}
            title={`Predicted move is ${part.confidence.signalToErrorRatio}x the model's typical ${part.confidence.expectedErrorPct}% error at this horizon`}
          >
            <IconShield className="h-3.5 w-3.5" />
            {part.confidence.level}
          </span>
          <button
            type="button"
            onClick={() => {
              const question = whyQuestion(part, forecastRow, whyContext);
              onAsk?.(question.text, question.prompt);
            }}
            className="rounded-md bg-blue-50 px-3 py-1 text-[12px] font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!onAsk}
            title="Explain this part's forecast drivers"
          >
            Why?
          </button>
          {expandable && (
            <button type="button" onClick={onToggle} aria-label="Toggle materials" className="text-slate-400 hover:text-slate-600">
              <IconCaret className={clsx('h-4 w-4 transition-transform', open && 'rotate-90')} />
            </button>
          )}
        </span>
      </div>

    </>
  );
}

function MaterialRow({
  material,
  depth,
  open,
  expandable,
  estSpend,
  onToggle,
}: {
  material: TreeMaterial;
  depth: number;
  open: boolean;
  expandable: boolean;
  estSpend: string;
  onToggle: () => void;
}) {
  const commodity = material.bridges?.commodity;
  return (
    <div className={clsx(GRID, 'relative bg-amber-50/30 py-2.5 pr-5 text-[13px]')} style={{ paddingLeft: 20 + depth * INDENT }}>
      <Guides depth={depth} />
      <span className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-label={open ? 'Collapse' : 'Expand'}
          className={clsx('shrink-0 text-slate-500', !expandable && 'invisible')}
        >
          <IconCaretDown className={clsx('h-4 w-4 transition-transform', !open && '-rotate-90')} />
        </button>
        <span className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', LEVEL_TILE.material)}>
          <LevelIcon kind="material" className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium text-slate-800">{material.name}</span>
            <span className="rounded-md bg-amber-100/70 px-2 py-0.5 text-[11px] text-amber-700">Material</span>
            <span className="text-[11px] text-slate-400">BG &rarr; FC</span>
          </span>
          {material.isSample && material.quantity != null && material.unitPrice != null && (
            <span className="block text-[12px] text-slate-400">
              {material.quantity} {material.unit} &times; {formatCurrency(material.unitPrice, false)}
              {material.unit === 'kg' ? '/kg' : ''} &middot; {estSpend}
            </span>
          )}
          {commodity != null && (
            <span className="block text-[12px] text-slate-400">Commodity bridge {formatCurrency(commodity, false)}</span>
          )}
        </span>
      </span>
      <span className="text-right tabular-nums text-slate-700" title="Budget (BG) — Material Cost baseline">
        {formatCurrency(material.currentPrice, false)}
      </span>
      <span className="text-right font-medium tabular-nums text-slate-900" title="Forecast (FC) — Material Cost">
        {formatCurrency(material.forecastPrice, false)}
      </span>
      <Variance pct={material.changePct} />
      <span className="text-slate-400">&ndash;</span>
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
