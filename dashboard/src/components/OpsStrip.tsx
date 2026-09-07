import type { DashboardData } from '../types';
import { IconCalendar } from './Icons';

/**
 * Operating-loop strip: monthly retrain, weekly score, 1-month horizon, drift.
 */
export function OpsStrip({ data }: { data: DashboardData }) {
  const ops = data.meta.ops;
  const drift = data.drift;
  const selection = data.featureSelection;
  if (!ops && !selection && !drift) return null;

  const horizon = ops?.forecastHorizonMonths ?? data.meta.forecastHorizon;
  const nSelected = ops?.nSelectedFeatures ?? selection?.nSelected;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[12px] text-slate-600">
      <span className="inline-flex items-center gap-1.5 font-medium text-slate-800">
        <IconCalendar className="h-3.5 w-3.5 text-slate-500" />
        Ops loop
      </span>
      <span>
        Horizon <span className="font-semibold text-slate-900">{horizon} mo</span>
      </span>
      {ops?.retrainCadence && (
        <span>
          Retrain <span className="font-semibold text-slate-900">{ops.retrainCadence}</span>
        </span>
      )}
      {ops?.scoreCadence && (
        <span>
          Score <span className="font-semibold text-slate-900">{ops.scoreCadence}</span>
        </span>
      )}
      {nSelected != null && (
        <span>
          Features selected{' '}
          <span className="font-semibold text-slate-900">{nSelected}</span>
        </span>
      )}
      {ops?.modelVersion && (
        <span className="font-mono text-[11px] text-slate-500">v{ops.modelVersion}</span>
      )}
      {drift?.alert ? (
        <span className="rounded-md bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
          Drift alert
        </span>
      ) : drift?.summary ? (
        <span className="text-emerald-700">No drift alert</span>
      ) : null}
    </div>
  );
}
