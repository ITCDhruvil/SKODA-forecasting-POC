import type { ReactElement } from 'react';
import { useState } from 'react';
import clsx from 'clsx';
import {
  IconGrid,
  IconChart,
  IconPackage,
  IconBeaker,
  IconAlert,
  IconDatabase,
  IconTarget,
  IconChevronLeft,
  IconChevronRight,
  IconLayers,
  IconCurrency,
  IconGlobe,
  IconHelp,
} from './Icons';
import { AskRadarButton } from './AskRadarButton';
import type { Insight } from '../types';

export type View =
  | 'dashboard'
  | 'forecast'
  | 'hierarchy'
  | 'fx'
  | 'geo'
  | 'parts'
  | 'futuretest'
  | 'validation'
  | 'alerts'
  | 'data'
  | 'faq';

export const SIDEBAR_WIDTH = 208;
export const SIDEBAR_WIDTH_COLLAPSED = 64;

const NAV: { id: View; label: string; icon: (p: { className?: string }) => ReactElement }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: IconGrid },
  { id: 'forecast', label: 'Forecast', icon: IconChart },
  { id: 'hierarchy', label: 'Hierarchy', icon: IconLayers },
  { id: 'fx', label: 'FX Impact', icon: IconCurrency },
  { id: 'geo', label: 'Geo Risk', icon: IconGlobe },
  { id: 'parts', label: 'Parts', icon: IconPackage },
  { id: 'futuretest', label: 'Future Test', icon: IconTarget },
  { id: 'validation', label: 'Validation', icon: IconBeaker },
  { id: 'alerts', label: 'Alerts', icon: IconAlert },
  { id: 'data', label: 'Data Source', icon: IconDatabase },
  { id: 'faq', label: 'Technical FAQ', icon: IconHelp },
];

interface Props {
  view: View;
  onChange: (view: View) => void;
  insight: Insight;
  alertCount: number;
  geoAlertCount?: number;
  onViewInsight: () => void;
  collapsed: boolean;
  onToggle: () => void;
  onAskRadar: () => void;
  radarOpen: boolean;
}

/**
 * Left navigation. Fixed to the viewport height so it does not stretch with
 * page content. Collapses to an icon rail when toggled.
 */
export function Sidebar({
  view,
  onChange,
  insight,
  alertCount,
  geoAlertCount = 0,
  onViewInsight,
  collapsed,
  onToggle,
  onAskRadar,
  radarOpen,
}: Props) {
  const [insightOpen, setInsightOpen] = useState(false);

  const toneClasses =
    insight.tone === 'warning'
      ? 'border-amber-200 bg-amber-50'
      : insight.tone === 'positive'
        ? 'border-emerald-200 bg-emerald-50'
        : 'border-slate-200 bg-slate-50';

  const toneText =
    insight.tone === 'warning'
      ? 'text-amber-900'
      : insight.tone === 'positive'
        ? 'text-emerald-900'
        : 'text-slate-800';

  return (
    <aside
      className={clsx(
        'fixed inset-y-0 left-0 z-30 flex h-screen flex-col border-r border-slate-200 bg-white transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-[208px]',
      )}
    >
      <div
        className={clsx(
          'flex items-center py-5',
          collapsed ? 'justify-center px-2' : 'gap-2 px-4',
        )}
      >
        {!collapsed && (
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-[15px] font-bold text-slate-900">AutoParts</div>
            <div className="text-[11px] text-slate-500">Price Forecasting</div>
          </div>
        )}
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
        >
          {collapsed ? (
            <IconChevronRight className="h-4 w-4" />
          ) : (
            <IconChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>

      <nav className={clsx('flex flex-col gap-0.5 overflow-y-auto', collapsed ? 'px-2' : 'px-3')}>
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              title={collapsed ? item.label : undefined}
              onClick={() => onChange(item.id)}
              className={clsx(
                'relative flex items-center rounded-lg py-2 text-left text-sm transition',
                collapsed ? 'justify-center px-0' : 'gap-3 px-3',
                active
                  ? 'bg-brand-50 font-semibold text-brand-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
              )}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1">{item.label}</span>
                  {item.id === 'alerts' && alertCount > 0 && (
                    <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                      {alertCount}
                    </span>
                  )}
                  {item.id === 'geo' && geoAlertCount > 0 && (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                      {geoAlertCount}
                    </span>
                  )}
                </>
              )}
              {collapsed && item.id === 'alerts' && alertCount > 0 && (
                <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-red-500" />
              )}
              {collapsed && item.id === 'geo' && geoAlertCount > 0 && (
                <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-amber-500" />
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto overflow-y-auto">
        <div className={clsx('pt-3', collapsed ? 'flex justify-center px-2' : 'px-3')}>
          <AskRadarButton collapsed={collapsed} open={radarOpen} onClick={onAskRadar} />
        </div>

        {!collapsed && (
          <div className="p-3">
            <div className={clsx('rounded-xl border', toneClasses)}>
              <button
                type="button"
                onClick={() => setInsightOpen((open) => !open)}
                className={clsx(
                  'flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold',
                  toneText,
                )}
                aria-expanded={insightOpen}
              >
                <IconTarget className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Real-Data Finding</span>
                {insightOpen ? (
                  <IconChevronLeft className="h-3.5 w-3.5 shrink-0 -rotate-90" />
                ) : (
                  <IconChevronRight className="h-3.5 w-3.5 shrink-0 rotate-90" />
                )}
              </button>
              {insightOpen && (
                <div className="border-t border-black/5 px-3 pb-2.5 pt-2">
                  <p className={clsx('text-[12px] font-semibold leading-snug', toneText)}>
                    {insight.headline}
                  </p>
                  <button
                    type="button"
                    onClick={onViewInsight}
                    className={clsx('mt-1.5 text-[11px] font-semibold hover:underline', toneText)}
                  >
                    View evidence &rarr;
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        <div
          className={clsx(
            'flex items-center border-t border-slate-200 py-3.5',
            collapsed ? 'justify-center px-2' : 'gap-2.5 px-4',
          )}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-700 text-[11px] font-semibold text-white">
            ML
          </div>
          {!collapsed && (
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[13px] font-medium text-slate-900">ML Engineer</div>
              <div className="truncate text-[11px] text-slate-500">POC build</div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
