import clsx from 'clsx';
import type { DashboardData, DataSource } from '../types';
import { MacroChart } from './MacroChart';
import { IconDatabase, IconCheck, IconAlert } from './Icons';

const STATUS_STYLE: Record<DataSource['status'], { pill: string; label: string }> = {
  real: { pill: 'bg-blue-100 text-blue-700', label: 'Real data' },
  synthetic: { pill: 'bg-amber-100 text-amber-700', label: 'Synthetic' },
  fallback: { pill: 'bg-red-100 text-red-700', label: 'Fallback' },
};

/**
 * Every input the model consumes, with provenance.
 *
 * The first question in any technical review is "where did this data come
 * from". Answering it inside the product keeps the answer attached to the
 * numbers rather than living in a slide deck that drifts out of date.
 */
export function DataSourcePanel({ data }: { data: DashboardData }) {
  const sources = data.dataSources ?? [];
  const real = sources.filter((s) => s.isReal);
  const synthetic = sources.filter((s) => !s.isReal);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard
          icon={<IconCheck className="h-4 w-4 text-blue-600" />}
          label="Real data sources"
          value={String(real.length)}
          detail="BLS price index + ECB reference rates"
        />
        <SummaryCard
          icon={<IconAlert className="h-4 w-4 text-amber-600" />}
          label="Synthetic layers"
          value={String(synthetic.length)}
          detail="Part-level panel only"
        />
        <SummaryCard
          icon={<IconDatabase className="h-4 w-4 text-slate-600" />}
          label="API keys required"
          value="0"
          detail="Both providers are open access"
        />
      </div>

      {sources.map((source) => {
        const style = STATUS_STYLE[source.status];
        return (
          <div key={source.id} className="card overflow-hidden">
            <div className="card-header flex-wrap">
              <div className="min-w-0">
                <h3 className="card-title">{source.name}</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {source.kind} &middot; {source.provider}
                </p>
              </div>
              <span className={clsx('pill', style.pill)}>{style.label}</span>
            </div>

            <div className="grid grid-cols-2 gap-x-8 gap-y-2 px-5 pb-3 text-[13px] lg:grid-cols-3">
              <Field label="Identifier" value={source.identifier} mono />
              <Field label="Frequency" value={source.frequency} />
              <Field label="Coverage" value={source.coverage} />
              <Field label="Observations" value={source.observations.toLocaleString()} />
              <Field label="Authentication" value={source.auth} />
              {source.endpoint && <Field label="Endpoint" value={source.endpoint} mono />}
            </div>

            <div className="border-t border-slate-200 px-5 py-2.5 text-[12px] leading-relaxed text-slate-600">
              <span className="font-semibold text-slate-800">Used for:</span> {source.usedFor}
            </div>
            <div
              className={clsx(
                'px-5 py-2.5 text-[11px] leading-relaxed',
                source.isReal ? 'bg-slate-50 text-slate-600' : 'bg-amber-50 text-amber-800',
              )}
            >
              <span className="font-semibold">Caveat:</span> {source.caveat}
            </div>
          </div>
        );
      })}

      <MacroChart series={data.macroSeries} seriesId={data.provenance.macroSeriesId} />

      <div className="card p-5">
        <h3 className="card-title mb-3">Run Environment</h3>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[13px] sm:grid-cols-3">
          <Meta label="Generated" value={data.meta.generatedAt.replace('T', ' ')} />
          <Meta label="Random seed" value={String(data.meta.randomSeed)} />
          <Meta label="History" value={`${data.meta.historyMonths} months`} />
          <Meta label="Forecast horizon" value={`${data.meta.forecastHorizon} months`} />
          <Meta label="Parts" value={String(data.meta.nParts)} />
          <Meta label="Projects" value={String(data.meta.nProjects ?? '--')} />
          <Meta label="Vendors" value={String(data.meta.nVendors ?? '--')} />
          <Meta label="Categories" value={String(data.meta.nCategories)} />
          <Meta label="Pricing currency" value={data.meta.currency ?? '--'} />
          {Object.entries(data.meta.versions).map(([name, version]) => (
            <Meta key={name} label={name} value={version} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="card px-5 py-4">
      <div className="flex items-center gap-2 text-[13px] font-medium text-slate-600">
        {icon}
        {label}
      </div>
      <div className="mt-1.5 text-[26px] font-bold leading-none text-slate-900">{value}</div>
      <div className="mt-1.5 text-[11px] text-slate-500">{detail}</div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div
        className={clsx(
          'truncate text-slate-800',
          mono && 'font-mono text-[11px]',
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-slate-100 py-1">
      <span className="text-slate-500">{label}</span>
      <span className="truncate font-mono text-[12px] text-slate-800">{value}</span>
    </div>
  );
}
