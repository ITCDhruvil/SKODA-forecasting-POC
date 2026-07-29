import {
  ComposedChart,
  CartesianGrid,
  Legend,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MacroPoint } from '../types';

/**
 * The real BLS index, with back-extrapolated months shaded.
 *
 * Those shaded months were reconstructed by the pipeline because the BLS
 * public API caps history at ~3 years. Marking them keeps the distinction
 * between measured and reconstructed visible.
 */
export function MacroChart({ series, seriesId }: { series: MacroPoint[]; seriesId: string }) {
  const firstReal = series.find((p) => p.isReal);
  const extrapolated = series.filter((p) => !p.isReal);

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">Macro Anchor &mdash; Real BLS Index</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            <span className="font-mono">{seriesId}</span> &middot; CPI, Motor Vehicle Parts &amp;
            Equipment, US city average, NSA
          </p>
        </div>
        <div className="flex items-center gap-3">
          {extrapolated.length > 0 && (
            <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <span className="h-2.5 w-4 rounded-sm bg-[#fed7aa]" />
              back-extrapolated ({extrapolated.length} mo, not measured)
            </span>
          )}
          <span className="pill bg-blue-100 text-blue-700">real data</span>
        </div>
      </div>

      <div className="px-2 pb-4">
        <ResponsiveContainer width="100%" height={244}>
          <ComposedChart data={series} margin={{ top: 6, right: 18, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: '#64748b' }}
              tickLine={false}
              axisLine={{ stroke: '#e2e8f0' }}
              interval="preserveStartEnd"
              minTickGap={30}
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#64748b' }}
              tickLine={false}
              axisLine={false}
              width={50}
              domain={['auto', 'auto']}
            />
            <Tooltip
              contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }}
              formatter={(value) => [value == null ? '--' : Number(value).toFixed(3), 'Index']}
            />
            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 6 }} iconType="line" />

            {extrapolated.length > 0 && firstReal && (
              <ReferenceArea
                x1={series[0].label}
                x2={firstReal.label}
                fill="#fed7aa"
                fillOpacity={0.5}
                stroke="none"
              />
            )}

            <Line
              type="monotone"
              dataKey="value"
              name="BLS index"
              stroke="#d1495b"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
