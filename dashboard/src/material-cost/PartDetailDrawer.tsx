import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import clsx from 'clsx';
import type { MaterialBridgeId, MaterialPartRow } from '../types';
import { formatAxisCurrency, formatCurrency, formatSigned } from '../lib/format';

const DRIVER_LABELS: Record<MaterialBridgeId, string> = {
  fx: 'Currency',
  commodity: 'Materials',
  freight: 'Shipping',
  vendorReprice: 'Vendor reprice',
  mix: 'Mix',
  seasonality: 'Seasonality',
  unexplained: 'Unexplained',
  other: 'Other',
};

const DRIVER_ORDER: MaterialBridgeId[] = [
  'fx',
  'commodity',
  'freight',
  'vendorReprice',
  'mix',
  'seasonality',
  'unexplained',
];

interface Props {
  part: MaterialPartRow;
  onClose: () => void;
}

/**
 * Part-level drill-down: Nomination→SOP→FC prices/spend, driver $, mini path chart.
 */
export function PartDetailDrawer({ part, onClose }: Props) {
  const bgSpend = Number(part.bgSpend ?? part.bgPrice) || 0;
  const sopSpend = Number(part.sopSpend ?? part.sopPrice) || 0;
  const fcSpend = Number(part.fcSpend ?? part.fcPrice) || 0;
  const volume = Number(part.volume) || 1;

  const chartData =
    part.pricePath && part.pricePath.length > 0
      ? part.pricePath.map((p) => ({
          label: p.label,
          actual: p.kind === 'actual' ? p.price : null,
          forecast: p.kind === 'forecast' ? p.price : null,
        }))
      : [
          { label: 'BG', actual: part.bgPrice, forecast: null },
          { label: 'SOP', actual: part.sopPrice, forecast: null },
          { label: 'FC', actual: null, forecast: part.fcPrice },
        ];

  const maxPrice = Math.max(
    ...chartData.map((d) => Math.max(d.actual ?? 0, d.forecast ?? 0)),
    1,
  );

  const bridges = part.bridges ?? {};

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Part detail ${part.partName}`}
      >
        <div className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-[16px] font-semibold text-slate-900">
              {part.partName}
            </h3>
            <p className="mt-0.5 text-[12px] text-slate-500">
              {part.partId} · {part.project} · {part.vendor}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {part.category} · {part.material}
              {part.baselineSource === 'file' ? ' · commercial baseline' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-50"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-3 gap-2">
            <Milestone label="Nomination / BG" unit={part.bgPrice} spend={bgSpend} />
            <Milestone label="SOP" unit={part.sopPrice} spend={sopSpend} />
            <Milestone label="Forecast" unit={part.fcPrice} spend={fcSpend} />
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            <span className="pill bg-slate-100 text-slate-700">
              Volume {volume.toLocaleString()}
              {part.volumeSource ? ` · ${part.volumeSource}` : ''}
            </span>
            <span
              className={clsx(
                'pill',
                part.changePct >= 0 ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700',
              )}
            >
              BG→FC {formatSigned(part.changePct, 2)} (
              {part.changeAbs >= 0 ? '+' : ''}
              {formatCurrency(part.changeAbs, false)})
            </span>
          </div>

          <div className="mt-5">
            <h4 className="text-[13px] font-semibold text-slate-800">Price path</h4>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Unit price — Nomination → SOP history, then forecast
            </p>
            <div className="mt-2 h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef2f7" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: '#64748b' }}
                    axisLine={{ stroke: '#e2e8f0' }}
                    tickLine={false}
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: '#64748b' }}
                    axisLine={false}
                    tickLine={false}
                    width={44}
                    tickFormatter={(v: number) => formatAxisCurrency(v, maxPrice)}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const row = payload[0].payload as {
                        label: string;
                        actual: number | null;
                        forecast: number | null;
                      };
                      return (
                        <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] shadow">
                          <div className="font-medium">{row.label}</div>
                          {row.actual != null ? (
                            <div>Actual {formatCurrency(row.actual, false)}</div>
                          ) : null}
                          {row.forecast != null ? (
                            <div className="text-brand-700">
                              Forecast {formatCurrency(row.forecast, false)}
                            </div>
                          ) : null}
                        </div>
                      );
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="actual"
                    stroke="none"
                    fill="#0f172a"
                    fillOpacity={0.06}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="actual"
                    stroke="#0f172a"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="forecast"
                    stroke="#2563eb"
                    strokeWidth={2}
                    strokeDasharray="5 3"
                    dot={{ r: 3, fill: '#2563eb' }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="mt-5">
            <h4 className="text-[13px] font-semibold text-slate-800">
              Driver breakdown (BG → FC spend)
            </h4>
            <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-100">
              {DRIVER_ORDER.map((id) => {
                const value = Number(bridges[id]) || 0;
                if (value === 0) return null;
                return (
                  <li
                    key={id}
                    className="flex items-center justify-between px-3 py-2 text-[12px]"
                  >
                    <span className="text-slate-700">{DRIVER_LABELS[id]}</span>
                    <span
                      className={clsx(
                        'font-semibold tabular-nums',
                        value >= 0 ? 'text-red-600' : 'text-emerald-600',
                      )}
                    >
                      {value >= 0 ? '+' : ''}
                      {formatCurrency(value, false)}
                    </span>
                  </li>
                );
              })}
            </ul>

            {(part.bridgesNomToSop || part.bridgesSopToFc) && (
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                <WalkMini
                  title="Nom → SOP"
                  bridges={part.bridgesNomToSop}
                />
                <WalkMini
                  title="SOP → FC"
                  bridges={part.bridgesSopToFc}
                />
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Milestone({
  label,
  unit,
  spend,
}: {
  label: string;
  unit: number;
  spend: number;
}) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-[15px] font-bold tabular-nums text-slate-900">
        {formatCurrency(spend, false)}
      </div>
      <div className="text-[10px] tabular-nums text-slate-400">
        unit {formatCurrency(unit, false)}
      </div>
    </div>
  );
}

function WalkMini({
  title,
  bridges,
}: {
  title: string;
  bridges?: Partial<Record<MaterialBridgeId, number>>;
}) {
  const total = DRIVER_ORDER.reduce((s, id) => s + (Number(bridges?.[id]) || 0), 0);
  return (
    <div className="rounded-lg border border-slate-100 px-2.5 py-2">
      <div className="font-medium text-slate-600">{title}</div>
      <div
        className={clsx(
          'mt-0.5 font-semibold tabular-nums',
          total >= 0 ? 'text-red-600' : 'text-emerald-600',
        )}
      >
        {total >= 0 ? '+' : ''}
        {formatCurrency(total, false)}
      </div>
    </div>
  );
}
