import { useEffect, useMemo, useState } from 'react';
import type { DashboardData } from './types';
import {
  Sidebar,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_COLLAPSED,
  type View,
} from './components/Sidebar';
import { KpiCard } from './components/KpiCard';
import { PriceForecastChart } from './components/PriceForecastChart';
import { CategoryDonut } from './components/CategoryDonut';
import { TopPartsTable } from './components/TopPartsTable';
import { HorizonChart } from './components/HorizonChart';
import { AlertsStrip } from './components/AlertsStrip';
import { ValidationPanel } from './components/ValidationPanel';
import { FutureTestPanel } from './components/FutureTestPanel';
import { HierarchyPanel } from './components/HierarchyPanel';
import { FxScenarioPanel } from './components/FxScenarioPanel';
import { GeoScenarioPanel } from './components/GeoScenarioPanel';
import { DrillDownTree } from './components/DrillDownTree';
import { DataSourcePanel } from './components/DataSourcePanel';
import { FaqPanel } from './components/FaqPanel';
import { ParametersModal, ParametersButton } from './components/ParametersModal';
import { RiskStrip } from './components/RiskStrip';
import { ModelComparison } from './components/ModelComparison';
import { MacroChart } from './components/MacroChart';
import { ProvenanceBanner } from './components/ProvenanceBanner';
import { OpsStrip } from './components/OpsStrip';
import { IconCalendar, IconExport } from './components/Icons';
import { monthLabel, setCurrencySymbol } from './lib/format';

const TITLES: Record<View, { title: string; subtitle: string }> = {
  dashboard: {
    title: 'Car Parts Price Forecasting',
    subtitle: 'Forecast spare parts prices and plan procurement ahead of the curve.',
  },
  forecast: {
    title: 'Forecast Detail',
    subtitle: 'Model comparison, backtest stability, and the forward projection.',
  },
  hierarchy: {
    title: 'Hierarchy Drill-down',
    subtitle:
      'Project → vendor → category → part. Expand any row to see current price, forecast, and how much to trust it.',
  },
  faq: {
    title: 'Technical FAQ',
    subtitle:
      'Questions a technical review will ask, answered from the live pipeline output.',
  },
  fx: {
    title: 'FX Impact',
    subtitle:
      'How currency moves reach part prices, and whether that effect can be trusted.',
  },
  geo: {
    title: 'Geopolitical Risk',
    subtitle:
      'Review news signals before applying them. Confirm to see price impact; sources are verified per channel.',
  },
  parts: {
    title: 'Parts',
    subtitle: 'Every part ranked by forecast price movement.',
  },
  futuretest: {
    title: 'Simulated-Future Test',
    subtitle:
      'Extra months generated, hidden, forecast blind, then revealed — scored for the configured horizon (default: next month).',
  },
  validation: {
    title: 'Real-Data Validation',
    subtitle: 'Are the predictions actually right? Scored against published BLS data.',
  },
  alerts: {
    title: 'Alerts',
    subtitle: 'Parts whose forecast movement warrants a procurement review.',
  },
  data: {
    title: 'Data Source',
    subtitle: 'Provenance of every number in this dashboard.',
  },
};

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [parametersOpen, setParametersOpen] = useState(false);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}dashboard.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((payload: DashboardData) => {
        // Symbol must be set before any component formats a value.
        setCurrencySymbol(payload.meta?.currencySymbol ?? '₹');
        setData(payload);
      })
      .catch((err: Error) =>
        setError(
          `Could not load dashboard.json (${err.message}). Run: python -m price_forecasting.pipeline --stage export`,
        ),
      );
  }, []);

  const historyLabel = useMemo(() => {
    if (!data) return '';
    const [from, to] = data.meta.historyRange;
    return `${monthLabel(from)} - ${monthLabel(to)}`;
  }, [data]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <div className="card max-w-lg p-6">
          <h1 className="text-lg font-semibold text-slate-900">Dashboard data not found</h1>
          <p className="mt-2 text-sm text-slate-600">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-slate-500">Loading forecast data...</div>
      </div>
    );
  }

  const { title, subtitle } = TITLES[view];

  const sidebarWidth = sidebarCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH;

  return (
    <div className="min-h-screen">
      <Sidebar
        view={view}
        onChange={setView}
        insight={data.insight}
        alertCount={data.alerts.length}
        geoAlertCount={data.geoAnalysis?.hitl?.alerts?.length ?? 0}
        onViewInsight={() => setView('validation')}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
      />

      <main
        className="min-w-0 min-h-screen transition-[margin] duration-200"
        style={{ marginLeft: sidebarWidth }}
      >
        {/* ---- Header ---------------------------------------------------- */}
        <header className="flex flex-wrap items-start justify-between gap-4 px-8 pt-7 pb-5">
          <div className="min-w-0">
            <h1 className="text-[26px] font-bold leading-tight tracking-tight text-slate-900">
              {title}
            </h1>
            <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-700">
              <IconCalendar className="h-4 w-4 text-slate-400" />
              {historyLabel}
            </div>
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-700">
              {data.meta.nParts} parts
            </div>
            <ParametersButton
              count={data.parameterCatalogue?.total ?? 0}
              onClick={() => setParametersOpen(true)}
            />
            <a
              href={`${import.meta.env.BASE_URL}dashboard.json`}
              download
              className="flex items-center gap-2 rounded-lg border border-brand-600 px-3 py-2 text-[13px] font-medium text-brand-600 transition hover:bg-brand-50"
            >
              <IconExport className="h-4 w-4" />
              Export
            </a>
          </div>
        </header>

        <div className="flex flex-col gap-4 px-8 pb-10">
          <ProvenanceBanner data={data} />
          <div className="mt-3">
            <OpsStrip data={data} />
          </div>

          {/* ---- Dashboard ---------------------------------------------- */}
          {view === 'dashboard' && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {data.kpis.map((kpi) => (
                  <KpiCard key={kpi.id} kpi={kpi} />
                ))}
              </div>

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.55fr_1fr]">
                <PriceForecastChart
                  series={data.priceSeries}
                  horizonMonths={data.meta.forecastHorizon}
                />
                <CategoryDonut categories={data.categories} />
              </div>

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.55fr_1fr]">
                <TopPartsTable parts={data.topParts} limit={7} />
                <HorizonChart horizon={data.horizon} />
              </div>

              <RiskStrip risk={data.riskConcentration} />

              <AlertsStrip alerts={data.alerts} onSeeAll={() => setView('alerts')} />
            </>
          )}

          {/* ---- Forecast detail ---------------------------------------- */}
          {view === 'forecast' && (
            <>
              <PriceForecastChart
                series={data.priceSeries}
                horizonMonths={data.meta.forecastHorizon}
              />
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <HorizonChart horizon={data.horizon} />
                <CategoryDonut categories={data.categories} />
              </div>
              <ModelComparison
                comparison={data.modelComparison}
                backtestSummary={data.backtestSummary}
              />
            </>
          )}

          {/* ---- Hierarchy ----------------------------------------------- */}
          {view === 'hierarchy' && (
            <>
              <DrillDownTree
                tree={data.tree}
                horizonMonths={data.meta.forecastHorizon}
              />
              <HierarchyPanel
                hierarchy={data.hierarchy ?? data.fxAnalysis?.rollups}
                horizonMonths={data.meta.forecastHorizon}
              />
            </>
          )}

          {/* ---- Technical FAQ ------------------------------------------- */}
          {view === 'faq' && <FaqPanel data={data} />}

          {/* ---- FX impact ----------------------------------------------- */}
          {view === 'fx' && <FxScenarioPanel fx={data.fxAnalysis} />}

          {/* ---- Geopolitical risk --------------------------------------- */}
          {view === 'geo' && <GeoScenarioPanel geo={data.geoAnalysis} />}

          {/* ---- Parts --------------------------------------------------- */}
          {view === 'parts' && <TopPartsTable parts={data.topParts} />}

          {/* ---- Simulated-future test ----------------------------------- */}
          {view === 'futuretest' && <FutureTestPanel futureTest={data.futureTest} />}

          {/* ---- Validation ---------------------------------------------- */}
          {view === 'validation' && (
            <>
              <ValidationPanel validation={data.validation} />
              <MacroChart series={data.macroSeries} seriesId={data.provenance.macroSeriesId} />
            </>
          )}

          {/* ---- Alerts -------------------------------------------------- */}
          {view === 'alerts' && <AlertsStrip alerts={data.alerts} />}

          {/* ---- Data source --------------------------------------------- */}
          {view === 'data' && <DataSourcePanel data={data} />}
        </div>
      </main>

      {parametersOpen && (
        <ParametersModal
          catalogue={data.parameterCatalogue}
          onClose={() => setParametersOpen(false)}
        />
      )}
    </div>
  );
}

