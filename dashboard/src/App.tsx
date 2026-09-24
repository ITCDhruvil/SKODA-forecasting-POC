import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DashboardData, MaterialPartRow, MaterialWalkId } from './types';
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
import { BuyerBrief } from './components/BuyerBrief';
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
import { OpsStrip } from './components/OpsStrip';
import { ChatWidget } from './components/ChatWidget';
import { CostWalkWaterfall, MaterialCostPanel, PartDetailDrawer } from './material-cost';
import { DateRangeControl } from './components/DateRangeControl';
import { IconExport } from './components/Icons';
import { setCurrencySymbol } from './lib/format';
import {
  availableMonthExtent,
  dateRangeToMonthKeys,
  filterDashboardData,
  type MonthRange,
} from './lib/filterDashboardData';

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
  material: {
    title: 'Material Cost Dashboard',
    subtitle:
      'Track part price from Nomination to SOP, and walk Budget (BG) to Forecast (FC) with drill-down.',
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
  const [materialFocus, setMaterialFocus] = useState<{
    walk: MaterialWalkId;
    bridge: string | null;
  } | null>(null);
  const [selectedMaterialPart, setSelectedMaterialPart] = useState<MaterialPartRow | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [parametersOpen, setParametersOpen] = useState(false);
  const [radarOpen, setRadarOpen] = useState(false);
  const [monthRange, setMonthRange] = useState<MonthRange | null>(null);
  const closeRadar = useCallback(() => setRadarOpen(false), []);

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
        const [start, end] = availableMonthExtent(payload);
        setMonthRange({ start, end });
      })
      .catch((err: Error) =>
        setError(
          `Could not load dashboard.json (${err.message}). Run: python -m price_forecasting.pipeline --stage export`,
        ),
      );
  }, []);

  const availableRange = useMemo(
    () => (data ? availableMonthExtent(data) : (['', ''] as [string, string])),
    [data],
  );

  const filtered = useMemo(() => {
    if (!data || !monthRange) return data;
    const [availStart, availEnd] = availableRange;
    if (monthRange.start === availStart && monthRange.end === availEnd) return data;
    return filterDashboardData(data, monthRange);
  }, [data, monthRange, availableRange]);

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

  if (!data || !filtered) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-slate-500">Loading forecast data...</div>
      </div>
    );
  }

  const { title, subtitle } = TITLES[view];

  const openMaterialPart = (partId: string) => {
    const part = data.materialCost?.parts?.find((row) => row.partId === partId) ?? null;
    setSelectedMaterialPart(part);
  };

  const sidebarWidth = sidebarCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH;

  return (
    <div className="min-h-screen">
      <Sidebar
        view={view}
        onChange={setView}
        alertCount={data.alerts.length}
        geoAlertCount={data.geoAnalysis?.hitl?.alerts?.length ?? 0}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
        onAskRadar={() => setRadarOpen((open) => !open)}
        radarOpen={radarOpen}
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
            <DateRangeControl
              historyRange={availableRange}
              onRangeChange={(range) => {
                const keys = dateRangeToMonthKeys(range);
                if (keys) setMonthRange(keys);
              }}
            />
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
          <div className="mt-3">
            <OpsStrip data={data} />
          </div>

          {/* ---- Dashboard ---------------------------------------------- */}
          {view === 'dashboard' && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {filtered.kpis.map((kpi) => (
                  <KpiCard key={kpi.id} kpi={kpi} />
                ))}
              </div>

              {data.materialCost?.parts && data.materialCost.milestones?.forecast.label && (
                <BuyerBrief
                  parts={data.materialCost.parts}
                  forecastLabel={data.materialCost.milestones.forecast.label}
                  sopSpend={data.materialCost.summary?.sopSpend}
                  forecastSpend={data.materialCost.summary?.forecastSpend}
                  onOpenPart={openMaterialPart}
                />
              )}

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.55fr_1fr]">
                <div className="flex flex-col gap-4">
                  <PriceForecastChart
                    series={filtered.priceSeries}
                    horizonMonths={data.meta.forecastHorizon}
                    materialCost={data.materialCost}
                    unitBasket={data.kpis.find((k) => k.id === 'forecast')?.value}
                  />
                  {data.materialCost?.waterfallSopToFc && (
                    <CostWalkWaterfall
                      steps={data.materialCost.waterfallSopToFc}
                      activeId={null}
                      onSelect={(id) => {
                        setMaterialFocus({ walk: 'sop_to_fc', bridge: id });
                        setView('material');
                      }}
                      title="Why the forecast moved"
                      subtitle="SOP to the forecast month. Click a reason to see those parts."
                    />
                  )}
                </div>
                <div className="flex h-full min-h-0 flex-col gap-4">
                  <CategoryDonut categories={data.categories} />
                  <div className="min-h-0 flex-1">
                    <HorizonChart horizon={filtered.horizon} fill />
                  </div>
                </div>
              </div>

              <TopPartsTable parts={data.topParts} limit={7} onSelect={openMaterialPart} />

              <RiskStrip risk={data.riskConcentration} />

              <AlertsStrip
                alerts={data.alerts}
                onSeeAll={() => setView('alerts')}
                onOpenPart={openMaterialPart}
              />
            </>
          )}

          {/* ---- Forecast detail ---------------------------------------- */}
          {view === 'forecast' && (
            <>
              <PriceForecastChart
                series={filtered.priceSeries}
                horizonMonths={data.meta.forecastHorizon}
                materialCost={data.materialCost}
                unitBasket={data.kpis.find((k) => k.id === 'forecast')?.value}
              />
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <HorizonChart horizon={filtered.horizon} />
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
                onOpenPart={openMaterialPart}
              />
              <HierarchyPanel
                hierarchy={data.hierarchy ?? data.fxAnalysis?.rollups}
                horizonMonths={data.meta.forecastHorizon}
              />
            </>
          )}

          {/* ---- Material Cost ------------------------------------------- */}
          {view === 'material' && (
            <MaterialCostPanel materialCost={filtered.materialCost} focus={materialFocus} />
          )}

          {/* ---- Technical FAQ ------------------------------------------- */}
          {view === 'faq' && <FaqPanel data={data} />}

          {/* ---- FX impact ----------------------------------------------- */}
          {view === 'fx' && <FxScenarioPanel fx={data.fxAnalysis} />}

          {/* ---- Geopolitical risk --------------------------------------- */}
          {view === 'geo' && <GeoScenarioPanel geo={data.geoAnalysis} />}

          {/* ---- Parts --------------------------------------------------- */}
          {view === 'parts' && <TopPartsTable parts={data.topParts} onSelect={openMaterialPart} />}

          {/* ---- Simulated-future test ----------------------------------- */}
          {view === 'futuretest' && <FutureTestPanel futureTest={data.futureTest} />}

          {/* ---- Validation ---------------------------------------------- */}
          {view === 'validation' && (
            <>
              <ValidationPanel validation={data.validation} />
              <MacroChart
                series={filtered.macroSeries}
                seriesId={data.provenance.macroSeriesId}
              />
            </>
          )}

          {/* ---- Alerts -------------------------------------------------- */}
          {view === 'alerts' && (
            <AlertsStrip alerts={data.alerts} onOpenPart={openMaterialPart} />
          )}

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

      {selectedMaterialPart && (
        <PartDetailDrawer
          part={selectedMaterialPart}
          onClose={() => setSelectedMaterialPart(null)}
        />
      )}

      <ChatWidget open={radarOpen} onClose={closeRadar} data={data} />
    </div>
  );
}

