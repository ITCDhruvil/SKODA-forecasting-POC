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
import { IconClose } from '../components/Icons';
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

  const drivers = DRIVER_ORDER.map((id) => ({
    id,
    label: DRIVER_LABELS[id],
    value: Number(bridges[id]) || 0,
  })).filter((d) => d.value !== 0);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/25 p-2" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-[640px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Part detail ${part.partName}`}
      >
        <div className="flex items-start gap-4 px-6 pb-2 pt-6">
          <div className="min-w-0 flex-1">
            <h3 className="text-[18px] font-medium leading-snug tracking-tight text-slate-900">
              {part.partName}
            </h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">
              {part.partId}
              <span className="text-slate-300"> · </span>
              {part.project}
              <span className="text-slate-300"> · </span>
              {part.vendor}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-8">
          <div className="mt-5 flex flex-wrap gap-1.5">
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] text-slate-600">
              {part.category}
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] text-slate-600">
              {part.material}
            </span>
            {part.baselineSource === 'file' ? (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] text-slate-600">
                Commercial baseline
              </span>
            ) : null}
          </div>

          <div className="mt-7 grid grid-cols-3 gap-6">
            <Milestone label="Nomination" unit={part.bgPrice} spend={bgSpend} />
            <Milestone label="SOP" unit={part.sopPrice} spend={sopSpend} />
            <Milestone label="Forecast" unit={part.fcPrice} spend={fcSpend} />
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-50 px-2.5 py-1 text-[12px] text-slate-600">
              Volume {volume.toLocaleString('en-IN')}
              {part.volumeSource ? ` · ${part.volumeSource}` : ''}
            </span>
            <span
              className={clsx(
                'rounded-full px-2.5 py-1 text-[12px] font-medium tabular-nums',
                part.changePct >= 0 ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800',
              )}
            >
              {formatSigned(part.changePct, 2)}
              <span className="font-normal">
                {' '}
                {part.changeAbs >= 0 ? '+' : ''}
                {formatCurrency(part.changeAbs, false)}
              </span>
            </span>
          </div>

          <div className="mt-8 flex min-h-[260px] flex-1 flex-col">
            <div className="flex items-baseline justify-between gap-3">
              <h4 className="text-[14px] font-medium text-slate-900">Price path</h4>
              <p className="text-[12px] text-slate-400">Unit price</p>
            </div>
            <div className="mt-3 flex items-center gap-4 text-[12px] text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-slate-900" />
                History
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-blue-600" />
                Forecast
              </span>
            </div>
            <div className="mt-2 min-h-[220px] flex-1">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 12, right: 8, left: 4, bottom: 0 }}>
                  <CartesianGrid stroke="#f1f5f9" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                    minTickGap={28}
                    dy={8}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#94a3b8' }}
                    axisLine={false}
                    tickLine={false}
                    width={58}
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
                        <div className="rounded-lg bg-slate-900 px-2.5 py-1.5 text-[12px] text-white shadow">
                          <div>{row.label}</div>
                          {row.actual != null ? (
                            <div className="mt-0.5 tabular-nums">
                              {formatCurrency(row.actual, false)}
                            </div>
                          ) : null}
                          {row.forecast != null ? (
                            <div className="mt-0.5 tabular-nums text-blue-200">
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
                    fillOpacity={0.05}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="actual"
                    stroke="#0f172a"
                    strokeWidth={1.75}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="forecast"
                    stroke="#2563eb"
                    strokeWidth={1.75}
                    dot={{ r: 3.5, fill: '#2563eb', strokeWidth: 0 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="mt-8">
            <h4 className="text-[14px] font-medium text-slate-900">Spend change</h4>
            <p className="mt-1 text-[12px] text-slate-400">Nomination to forecast</p>
            {drivers.length > 0 ? (
              <ul className="mt-3">
                {drivers.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-baseline justify-between gap-6 border-t border-slate-100 py-3 text-[13px]"
                  >
                    <span className="text-slate-600">{d.label}</span>
                    <span
                      className={clsx(
                        'tabular-nums',
                        d.value >= 0 ? 'text-red-600' : 'text-emerald-700',
                      )}
                    >
                      {d.value >= 0 ? '+' : ''}
                      {formatCurrency(d.value, false)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[13px] text-slate-400">No driver movement on this part.</p>
            )}

            {(part.bridgesNomToSop || part.bridgesSopToFc) && (
              <div className="mt-6 grid grid-cols-2 gap-8">
                <WalkMini title="Nomination to SOP" bridges={part.bridgesNomToSop} />
                <WalkMini title="SOP to forecast" bridges={part.bridgesSopToFc} />
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
    <div>
      <div className="text-[12px] text-slate-500">{label}</div>
      <div className="mt-1.5 text-[18px] font-medium tabular-nums tracking-tight text-slate-900">
        {formatCurrency(spend, false)}
      </div>
      <div className="mt-1 text-[12px] tabular-nums text-slate-400">
        {formatCurrency(unit, false)} unit
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
    <div>
      <div className="text-[12px] text-slate-500">{title}</div>
      <div
        className={clsx(
          'mt-1 text-[15px] font-medium tabular-nums',
          total >= 0 ? 'text-red-600' : 'text-emerald-700',
        )}
      >
        {total >= 0 ? '+' : ''}
        {formatCurrency(total, false)}
      </div>
    </div>
  );
}
