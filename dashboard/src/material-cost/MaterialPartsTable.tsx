import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { MaterialBridgeId, MaterialPartRow } from '../types';
import { formatCurrency, formatSigned } from '../lib/format';
import { filterPartsByBridge } from './deriveMaterialCostView';

const BRIDGE_LABELS: Record<MaterialBridgeId, string> = {
  fx: 'Currency',
  commodity: 'Materials',
  freight: 'Shipping',
  vendorReprice: 'Vendor reprice',
  mix: 'Mix',
  seasonality: 'Seasonality',
  unexplained: 'Unexplained',
  other: 'Other',
};

interface Props {
  parts: MaterialPartRow[];
  bridgeFilter: string | null;
  onClearBridge: () => void;
  onSelectPart: (part: MaterialPartRow) => void;
}

/**
 * Drill-down table. Waterfall click filters material drivers; row click opens
 * the part detail drawer.
 */
export function MaterialPartsTable({
  parts,
  bridgeFilter,
  onClearBridge,
  onSelectPart,
}: Props) {
  const [limit, setLimit] = useState(12);

  const bridgeId =
    bridgeFilter && bridgeFilter in BRIDGE_LABELS
      ? (bridgeFilter as MaterialBridgeId)
      : null;

  const ranked = useMemo(() => {
    if (!bridgeId) return parts;
    return filterPartsByBridge(parts, bridgeId);
  }, [parts, bridgeId]);

  useEffect(() => {
    setLimit(12);
  }, [parts, bridgeId]);

  const shown = ranked.slice(0, limit);

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <div>
          <h3 className="card-title">Part drill-down</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {bridgeId
              ? `Parts where ${BRIDGE_LABELS[bridgeId]} is a material driver (${ranked.length} of ${parts.length}) — click a row for detail`
              : 'Spend-ranked BG → FC moves — click a row for Nomination→SOP→FC detail'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {bridgeId ? (
            <button
              type="button"
              onClick={onClearBridge}
              className="pill bg-blue-50 text-blue-700 hover:bg-blue-100"
            >
              Filter: {BRIDGE_LABELS[bridgeId]} ×
            </button>
          ) : null}
          <span className="text-[12px] text-slate-500">{ranked.length} parts</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[780px] text-left text-[13px]">
          <thead className="border-y border-slate-100 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-5 py-2.5 font-medium">Part</th>
              <th className="px-3 py-2.5 font-medium">Project</th>
              <th className="px-3 py-2.5 font-medium text-right">Vol</th>
              <th className="px-3 py-2.5 font-medium text-right">BG spend</th>
              <th className="px-3 py-2.5 font-medium text-right">SOP spend</th>
              <th className="px-3 py-2.5 font-medium text-right">FC spend</th>
              <th className="px-3 py-2.5 font-medium text-right">Δ</th>
              <th className="px-5 py-2.5 font-medium text-right">
                {bridgeId ? BRIDGE_LABELS[bridgeId] : 'Top bridge'}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-5 py-8 text-center text-[13px] text-slate-500"
                >
                  {bridgeId
                    ? `No parts have a material ${BRIDGE_LABELS[bridgeId]} contribution under the current filters.`
                    : 'No parts match the current hierarchy filters.'}
                </td>
              </tr>
            ) : (
              shown.map((part) => {
                const topBridge = bridgeId
                  ? bridgeId
                  : (Object.entries(part.bridges ?? {})
                      .filter(([k]) => k !== 'other')
                      .sort(
                        (a, b) =>
                          Math.abs(Number(b[1]) || 0) - Math.abs(Number(a[1]) || 0),
                      )[0]?.[0] as MaterialBridgeId | undefined);
                const bridgeVal = topBridge
                  ? Number(part.bridges?.[topBridge]) || 0
                  : 0;
                const bgSpend = Number(part.bgSpend ?? part.bgPrice) || 0;
                const sopSpend = Number(part.sopSpend ?? part.sopPrice) || 0;
                const fcSpend = Number(part.fcSpend ?? part.fcPrice) || 0;
                return (
                  <tr
                    key={part.partId}
                    className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-brand-50/40"
                    onClick={() => onSelectPart(part)}
                  >
                    <td className="px-5 py-2.5">
                      <div className="font-medium text-slate-900">{part.partName}</div>
                      <div className="text-[11px] text-slate-500">
                        {part.partId} · {part.category} · {part.vendor}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{part.project}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">
                      {(Number(part.volume) || 1).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                      {formatCurrency(bgSpend, false)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                      {formatCurrency(sopSpend, false)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                      {formatCurrency(fcSpend, false)}
                    </td>
                    <td
                      className={clsx(
                        'px-3 py-2.5 text-right tabular-nums font-medium',
                        part.changePct >= 0 ? 'text-red-600' : 'text-emerald-600',
                      )}
                    >
                      {formatSigned(part.changePct, 2)}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <div
                        className={clsx(
                          'tabular-nums font-medium',
                          bridgeVal >= 0 ? 'text-red-600' : 'text-emerald-600',
                        )}
                      >
                        {bridgeVal >= 0 ? '+' : ''}
                        {formatCurrency(bridgeVal, false)}
                      </div>
                      {!bridgeId && topBridge ? (
                        <div className="text-[10px] text-slate-400">
                          {BRIDGE_LABELS[topBridge]}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {ranked.length > limit ? (
        <div className="border-t border-slate-100 px-5 py-3">
          <button
            type="button"
            onClick={() => setLimit((n) => n + 12)}
            className="text-[13px] font-medium text-brand-600 hover:underline"
          >
            Show more ({ranked.length - limit} remaining)
          </button>
        </div>
      ) : null}
    </div>
  );
}
