import type { MaterialBridgeId, MaterialPartRow } from '../types';
import { formatSpend } from '../lib/format';

const DRIVER: Record<MaterialBridgeId, string> = {
  fx: 'currency',
  commodity: 'materials',
  freight: 'shipping',
  vendorReprice: 'a supplier price change',
  mix: 'part mix',
  seasonality: 'seasonality',
  unexplained: 'other cost movement',
  other: 'other cost movement',
};

interface Call {
  vendor: string;
  part: MaterialPartRow;
  rise: number;
  driver: string;
}

function forwardRise(part: MaterialPartRow): number | null {
  const sop = part.sopSpend ?? part.sopPrice;
  const forecast = part.fcSpend ?? part.fcPrice;
  if (sop == null || forecast == null) return null;
  return Number(forecast) - Number(sop);
}

function mainDriver(part: MaterialPartRow): string {
  const entries = Object.entries(part.bridgesSopToFc ?? {}) as [MaterialBridgeId, number][];
  const top = entries
    .filter(([, value]) => Number(value) > 0.5)
    .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  if (!top) return 'the forecast itself';
  return DRIVER[top[0]] ?? 'the forecast itself';
}

function callsFor(parts: MaterialPartRow[]): Call[] {
  const byVendor = new Map<string, Call>();
  for (const part of parts) {
    const rise = forwardRise(part);
    if (rise == null || rise <= 0) continue;
    const current = byVendor.get(part.vendor);
    if (!current || rise > current.rise) {
      byVendor.set(part.vendor, {
        vendor: part.vendor,
        part,
        rise,
        driver: mainDriver(part),
      });
    }
  }
  return [...byVendor.values()].sort((a, b) => b.rise - a.rise).slice(0, 3);
}

interface Props {
  parts: MaterialPartRow[];
  forecastLabel: string;
  sopSpend?: number;
  forecastSpend?: number;
  onOpenPart: (partId: string) => void;
}

/**
 * Three supplier calls a buyer can take into a meeting, from the SOP → forecast move.
 */
export function BuyerBrief({
  parts,
  forecastLabel,
  sopSpend,
  forecastSpend,
  onOpenPart,
}: Props) {
  const calls = callsFor(parts);
  const gap =
    sopSpend != null && forecastSpend != null ? forecastSpend - sopSpend : null;

  if (calls.length === 0) return null;

  return (
    <section className="card px-5 py-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="card-title">Calls to make before {forecastLabel}</h3>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-slate-500">
            {gap != null && gap > 0
              ? `Doing nothing adds ${formatSpend(gap)} of spend between SOP and ${forecastLabel}. These three suppliers hold the largest single-part increases.`
              : `These three suppliers hold the largest single-part increases into ${forecastLabel}.`}
          </p>
        </div>
      </div>

      <ol className="mt-4 grid gap-3 lg:grid-cols-3">
        {calls.map((call, index) => (
          <li key={call.vendor}>
            <button
              type="button"
              onClick={() => onOpenPart(call.part.partId)}
              className="flex h-full w-full flex-col rounded-xl bg-slate-50 px-4 py-3 text-left transition hover:bg-slate-100"
            >
              <span className="text-[12px] text-slate-400">Call {index + 1}</span>
              <span className="mt-1 text-[15px] font-medium text-slate-900">{call.vendor}</span>
              <span className="mt-2 text-[13px] leading-relaxed text-slate-600">
                {call.part.partName} is up{' '}
                <span className="font-medium tabular-nums text-red-600">
                  {formatSpend(call.rise)}
                </span>{' '}
                by {forecastLabel}, mainly from {call.driver}. Ask them to hold the SOP price.
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
