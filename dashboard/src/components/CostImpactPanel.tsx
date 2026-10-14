import { Fragment, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DashboardData } from '../types';
import { formatSpend } from '../lib/format';
import {
  ALL,
  buildTrend,
  computeImpact,
  MATERIAL_ASSUMPTIONS,
  vehicleImpactPct,
  type CurrencyChoice,
} from '../lib/costImpact';

interface Props {
  data: DashboardData;
  onOpenPart: (partId: string) => void;
}

const PRESETS: Array<{ label: string; material?: string; commodityPct: number; fxPct: number }> = [
  { label: 'Copper +10%', material: 'Copper', commodityPct: 10, fxPct: 0 },
  { label: 'Rupee 5% weaker', commodityPct: 0, fxPct: 5 },
  { label: 'Aluminium +15% and rupee 8% weaker', material: 'Aluminium', commodityPct: 15, fxPct: 8 },
];

const CURRENCIES: Array<{ id: CurrencyChoice; label: string }> = [
  { id: 'both', label: 'USD/INR + EUR/INR' },
  { id: 'USDINR', label: 'USD/INR' },
  { id: 'EURINR', label: 'EUR/INR' },
];

const selectClass =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-brand-500';

const signedPct = (v: number, digits = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}%`;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        <span className="text-sm font-semibold text-slate-900">{signedPct(value, 0)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="w-full accent-brand-600"
      />
      <div className="flex justify-between text-[10px] text-slate-400">
        <span>{signedPct(min, 0)}</span>
        <span>{signedPct(max, 0)}</span>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'up' | 'down' }) {
  return (
    <div className="card px-5 py-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p
        className={clsx(
          'mt-1 text-2xl font-semibold',
          tone === 'up' && 'text-red-600',
          tone === 'down' && 'text-emerald-600',
          !tone && 'text-slate-900',
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

export function CostImpactPanel({ data, onOpenPart }: Props) {
  const parts = data.materialCost?.parts ?? [];
  const scenarios = data.fxAnalysis?.scenarios ?? [];
  const cars = useMemo(() => [...new Set(parts.map((p) => p.project))].sort(), [parts]);
  const materials = useMemo(() => [...new Set(parts.map((p) => p.material))].sort(), [parts]);

  const [car, setCar] = useState(ALL);
  const [material, setMaterial] = useState('Copper');
  const [currency, setCurrency] = useState<CurrencyChoice>('both');
  const [commodityPct, setCommodityPct] = useState(10);
  const [fxPct, setFxPct] = useState(5);
  const [materialShare, setMaterialShare] = useState(55);
  const [openCategory, setOpenCategory] = useState<string | null>(null);

  const impact = useMemo(
    () => computeImpact({ parts, scenarios, car, material, currency, commodityPct, fxPct }),
    [parts, scenarios, car, material, currency, commodityPct, fxPct],
  );
  const trend = useMemo(
    () => buildTrend(data.horizon ?? [], impact.base, impact.delta),
    [data.horizon, impact.base, impact.delta],
  );
  const vehiclePct = vehicleImpactPct(impact.base, impact.delta, materialShare / 100);

  const waterfall = useMemo(() => {
    const { base, fx, commodity, scenario, delta } = impact;
    const lo = Math.min(base, scenario) - Math.max(Math.abs(delta) * 3, base * 0.02);
    const effect = (name: string, start: number, v: number) => ({
      name,
      offset: Math.min(start, start + v),
      value: Math.abs(v),
      kind: v >= 0 ? 'up' : 'down',
      raw: v,
    });
    return {
      lo,
      rows: [
        { name: 'Base forecast', offset: lo, value: base - lo, kind: 'total', raw: base },
        effect('FX effect', base, fx),
        effect('Commodity effect', base + fx, commodity),
        { name: 'Scenario', offset: lo, value: scenario - lo, kind: 'total', raw: scenario },
      ],
    };
  }, [impact]);

  function applyPreset(p: (typeof PRESETS)[number]) {
    if (p.material) setMaterial(p.material);
    setCommodityPct(p.commodityPct);
    setFxPct(p.fxPct);
  }

  if (parts.length === 0) {
    return <p className="text-sm text-slate-500">Cost impact needs the material cost data, which isn't in this export.</p>;
  }

  const tone = impact.delta > 0 ? 'up' : impact.delta < 0 ? 'down' : undefined;
  const assumption = material === ALL ? null : MATERIAL_ASSUMPTIONS[material];

  return (
    <div className="flex flex-col gap-6">
      {/* Controls */}
      <div className="card p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Car / model">
            <select className={selectClass} value={car} onChange={(e) => setCar(e.target.value)}>
              <option value={ALL}>All cars</option>
              {cars.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Material / commodity">
            <select className={selectClass} value={material} onChange={(e) => setMaterial(e.target.value)}>
              <option value={ALL}>All materials</option>
              {materials.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Currency">
            <select
              className={selectClass}
              value={currency}
              onChange={(e) => setCurrency(e.target.value as CurrencyChoice)}
            >
              {CURRENCIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-6 md:grid-cols-2">
          <Slider label={`${material === ALL ? 'Commodity' : material} price move`} value={commodityPct} min={-20} max={30} onChange={setCommodityPct} />
          <Slider label="Rupee move (positive = weaker rupee)" value={fxPct} min={-10} max={10} onChange={setFxPct} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-500">Quick scenarios</span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p)}
              className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-700 transition hover:border-brand-500 hover:bg-brand-50"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Headline */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Base forecast cost (+6 months)" value={formatSpend(impact.base)} sub={car === ALL ? 'All cars' : car} />
        <Stat label="Scenario cost" value={formatSpend(impact.scenario)} sub="After the moves above" />
        <Stat
          label="Impact on material cost"
          value={formatSpend(impact.delta, true)}
          sub={signedPct(impact.deltaPct)}
          tone={tone}
        />
        <Stat
          label="Impact on overall vehicle cost"
          value={signedPct(vehiclePct)}
          sub={`If material is ${materialShare}% of vehicle cost`}
          tone={tone}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* Trend */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Forecast trend: base vs scenario</h3>
          </div>
          <div className="h-72 px-3 pb-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  tickLine={false}
                  axisLine={false}
                  width={64}
                  domain={['auto', 'auto']}
                  tickFormatter={(v: number) => formatSpend(v)}
                />
                <Tooltip formatter={(v) => formatSpend(Number(v))} />
                <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="base" name="Base forecast" stroke="#94a3b8" strokeWidth={2.5} dot={false} />
                <Line
                  type="monotone"
                  dataKey="scenario"
                  name="Scenario"
                  stroke={impact.delta > 0 ? '#dc2626' : '#16a34a'}
                  strokeWidth={2.5}
                  strokeDasharray="6 4"
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="px-5 pb-4 text-[11px] text-slate-400">
            The scenario impact is assumed to phase in evenly over the 6 months.
          </p>
        </div>

        {/* Bridge */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Impact bridge: base to scenario</h3>
          </div>
          <div className="h-72 px-3 pb-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={waterfall.rows} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  tickLine={false}
                  axisLine={false}
                  width={64}
                  domain={[waterfall.lo, 'auto']}
                  allowDataOverflow
                  tickFormatter={(v: number) => formatSpend(v)}
                />
                <Tooltip
                  cursor={false}
                  formatter={(_v, _n, item) => formatSpend((item.payload as { raw: number }).raw)}
                />
                <Bar dataKey="offset" stackId="w" fill="transparent" isAnimationActive={false} />
                <Bar dataKey="value" stackId="w" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                  {waterfall.rows.map((r) => (
                    <Cell key={r.name} fill={r.kind === 'total' ? '#1e3a8a' : r.kind === 'up' ? '#dc2626' : '#16a34a'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="px-5 pb-4 text-[11px] text-slate-400">
            FX {formatSpend(impact.fx, true)} · Commodity {formatSpend(impact.commodity, true)}. Axis starts above zero so
            the effects are visible.
          </p>
        </div>
      </div>

      {/* Exposure drill-down */}
      <div className="card overflow-hidden">
        <div className="card-header">
          <h3 className="card-title">Exposure by vertical, then part</h3>
          <span className="text-xs text-slate-400">Click a category to see its parts</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-slate-100 text-left text-xs text-slate-500">
                <th className="px-5 py-2 font-medium">Category</th>
                <th className="px-3 py-2 text-right font-medium">Base</th>
                <th className="px-3 py-2 text-right font-medium">FX</th>
                <th className="px-3 py-2 text-right font-medium">Commodity</th>
                <th className="px-3 py-2 text-right font-medium">Impact</th>
                <th className="px-5 py-2 text-right font-medium">Impact %</th>
              </tr>
            </thead>
            <tbody>
              {impact.categories.map((c) => {
                const open = openCategory === c.name;
                return (
                  <Fragment key={c.name}>
                    <tr
                      onClick={() => setOpenCategory(open ? null : c.name)}
                      className="cursor-pointer border-b border-slate-50 hover:bg-slate-50"
                    >
                      <td className="px-5 py-2.5 font-medium text-slate-800">
                        <span className="mr-2 inline-block w-3 text-slate-400">{open ? '▾' : '▸'}</span>
                        {c.name}
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{formatSpend(c.base)}</td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{formatSpend(c.fx, true)}</td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{formatSpend(c.commodity, true)}</td>
                      <td className="px-3 py-2.5 text-right font-medium text-slate-900">{formatSpend(c.delta, true)}</td>
                      <td
                        className={clsx(
                          'px-5 py-2.5 text-right font-medium',
                          c.deltaPct > 0 ? 'text-red-600' : c.deltaPct < 0 ? 'text-emerald-600' : 'text-slate-500',
                        )}
                      >
                        {signedPct(c.deltaPct)}
                      </td>
                    </tr>
                    {open &&
                      c.parts.slice(0, 8).map((p) => (
                        <tr
                          key={p.partId}
                          onClick={() => onOpenPart(p.partId)}
                          className="cursor-pointer border-b border-slate-50 bg-slate-50/60 text-xs hover:bg-brand-50"
                        >
                          <td className="py-2 pl-12 pr-3 text-slate-700">
                            {p.partName} <span className="text-slate-400">· {p.material}</span>
                          </td>
                          <td className="px-3 py-2 text-right text-slate-500">{formatSpend(p.base)}</td>
                          <td className="px-3 py-2 text-right text-slate-500">{formatSpend(p.fx, true)}</td>
                          <td className="px-3 py-2 text-right text-slate-500">{formatSpend(p.commodity, true)}</td>
                          <td className="px-3 py-2 text-right font-medium text-slate-700">{formatSpend(p.delta, true)}</td>
                          <td className="px-5 py-2 text-right text-slate-400">open</td>
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Assumptions */}
      <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-5 py-4 text-xs leading-relaxed text-slate-700">
        <p className="mb-1 font-semibold text-slate-900">How these numbers are built</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            <span className="font-medium">FX effect</span> comes from the model's own FX scenarios, per category. A single
            currency pair is assumed to carry half of the combined effect.
          </li>
          <li>
            <span className="font-medium">Commodity effect is illustrative.</span> The data has no commodity
            sensitivity, so each material uses an assumed share of part cost and supplier pass-through
            {assumption
              ? ` (${material}: ${Math.round(assumption.share * 100)}% share, ${Math.round(assumption.passThrough * 100)}% passed on)`
              : ''}
            . Replace with contract-indexed values when available.
          </li>
          <li>
            <span className="font-medium">Overall vehicle cost</span> assumes material is
            <input
              type="number"
              min={10}
              max={90}
              value={materialShare}
              onChange={(e) => setMaterialShare(Math.min(90, Math.max(10, Number(e.target.value) || 55)))}
              aria-label="Material share of vehicle cost, percent"
              className="mx-1 w-14 rounded border border-slate-300 bg-white px-1 py-0.5 text-center"
            />
            % of vehicle cost.
          </li>
        </ul>
      </div>
    </div>
  );
}
