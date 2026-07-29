import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { CategoryRow } from '../types';
import { formatCurrency, formatSigned } from '../lib/format';

const COLORS = [
  '#3b82f6',
  '#10b981',
  '#8b5cf6',
  '#f59e0b',
  '#06b6d4',
  '#ef4444',
  '#ec4899',
  '#94a3b8',
];

const LABELS: Record<string, string> = {
  filters: 'Filters',
  brakes: 'Brake System',
  electrical: 'Electrical',
  sensors: 'Sensors',
  belts_hoses: 'Belts & Hoses',
  cooling: 'Cooling',
  suspension: 'Suspension',
  wipers_lighting: 'Wipers & Lighting',
};

export function CategoryDonut({ categories }: { categories: CategoryRow[] }) {
  const total = categories.reduce((sum, c) => sum + c.value, 0);

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">Basket Value by Category</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Share of total &middot; forecast movement over horizon
          </p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-4 px-5 pb-5 lg:flex-row">
        <div className="relative h-[192px] w-[192px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={categories}
                dataKey="value"
                nameKey="category"
                innerRadius={58}
                outerRadius={90}
                paddingAngle={2}
                stroke="none"
              >
                {categories.map((entry, index) => (
                  <Cell key={entry.category} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  borderRadius: 10,
                  border: '1px solid #e2e8f0',
                  fontSize: 12,
                }}
                formatter={(value, name) => [
                  formatCurrency(value == null ? null : Number(value)),
                  LABELS[String(name)] ?? String(name),
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-[19px] font-bold leading-none text-slate-900">
              {formatCurrency(total)}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">Total</div>
          </div>
        </div>

        <div className="flex w-full flex-col gap-1.5">
          {categories.map((row, index) => (
            <div key={row.category} className="flex items-center gap-2 text-[13px]">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: COLORS[index % COLORS.length] }}
              />
              <span className="flex-1 truncate text-slate-700">
                {LABELS[row.category] ?? row.category}
              </span>
              <span
                className={
                  row.forecastChange >= 0
                    ? 'text-[11px] font-medium text-emerald-600'
                    : 'text-[11px] font-medium text-red-600'
                }
              >
                {formatSigned(row.forecastChange)}
              </span>
              <span className="w-11 text-right font-semibold tabular-nums text-slate-900">
                {row.share.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
