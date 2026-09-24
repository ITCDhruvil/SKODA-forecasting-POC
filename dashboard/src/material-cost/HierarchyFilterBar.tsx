import clsx from 'clsx';
import type { MaterialPartRow } from '../types';
import { IconChevronDown, IconSearch } from '../components/Icons';
import {
  EMPTY_HIERARCHY_FILTERS,
  hierarchyOptions,
  type HierarchyFilterState,
} from './deriveMaterialCostView';

interface Props {
  parts: MaterialPartRow[];
  filters: HierarchyFilterState;
  onChange: (next: HierarchyFilterState) => void;
  matchingCount: number;
  totalCount: number;
}

/**
 * Cascading Project → Vendor → Category → Material filters for Material Cost.
 * Styled like the dashboard header chrome (chips / white bordered controls).
 */
export function HierarchyFilterBar({
  parts,
  filters,
  onChange,
  matchingCount,
  totalCount,
}: Props) {
  const options = hierarchyOptions(parts, filters);
  const active =
    filters.project !== 'all' ||
    filters.vendor !== 'all' ||
    filters.category !== 'all' ||
    filters.material !== 'all' ||
    filters.partQuery.trim().length > 0;

  const set = <K extends keyof HierarchyFilterState>(
    key: K,
    value: HierarchyFilterState[K],
  ) => {
    const next: HierarchyFilterState = { ...filters, [key]: value };

    if (key === 'project') {
      next.vendor = 'all';
      next.category = 'all';
      next.material = 'all';
    } else if (key === 'vendor') {
      next.category = 'all';
      next.material = 'all';
    } else if (key === 'category') {
      next.material = 'all';
    }

    onChange(next);
  };

  return (
    <div className="card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="card-title">Hierarchy filters</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Project → Vendor → Category → Material — KPIs and charts update live
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={clsx(
              'pill',
              active ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600',
            )}
          >
            {matchingCount === totalCount
              ? `${totalCount} parts`
              : `${matchingCount} of ${totalCount} parts`}
          </span>
          {active ? (
            <button
              type="button"
              onClick={() => onChange({ ...EMPTY_HIERARCHY_FILTERS })}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
            >
              Clear all
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-5">
        <FilterSelect
          label="Project"
          value={filters.project}
          options={options.projects}
          onChange={(v) => set('project', v)}
          allLabel="All projects"
        />
        <FilterSelect
          label="Vendor"
          value={filters.vendor}
          options={options.vendors}
          onChange={(v) => set('vendor', v)}
          disabled={options.vendors.length === 0}
          allLabel="All vendors"
        />
        <FilterSelect
          label="Category"
          value={filters.category}
          options={options.categories}
          onChange={(v) => set('category', v)}
          disabled={options.categories.length === 0}
          allLabel="All categories"
        />
        <FilterSelect
          label="Material"
          value={filters.material}
          options={options.materials}
          onChange={(v) => set('material', v)}
          disabled={options.materials.length === 0}
          allLabel="All materials"
        />
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Part search
          </span>
          <span className="relative">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={filters.partQuery}
              onChange={(e) => set('partQuery', e.target.value)}
              placeholder="ID or name…"
              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-8 pr-3 text-[13px] text-slate-800 shadow-sm placeholder:text-slate-400 transition hover:border-slate-300 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </span>
        </label>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
  disabled,
  allLabel,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  allLabel: string;
}) {
  const isActive = value !== 'all';
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <span className="relative">
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={clsx(
            'w-full appearance-none rounded-lg border bg-white py-2 pl-3 pr-8 text-[13px] shadow-sm transition',
            'focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20',
            'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 disabled:shadow-none',
            isActive
              ? 'border-brand-500 text-slate-900 font-medium'
              : 'border-slate-200 text-slate-700 hover:border-slate-300',
          )}
        >
          <option value="all">{allLabel}</option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <IconChevronDown
          className={clsx(
            'pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2',
            disabled ? 'text-slate-300' : 'text-slate-400',
          )}
        />
      </span>
    </label>
  );
}
