/**
 * Types mirroring the payload written by the Python pipeline's `export` stage
 * (`src/price_forecasting/export.py`).
 *
 * Everything rendered by this app comes from `dashboard.json`. There are no
 * hardcoded figures anywhere in the UI, so what you see is always what the
 * pipeline actually produced.
 */

export type Direction = 'up' | 'down' | 'flat';
export type NumberFormat = 'currency' | 'percent' | 'integer' | 'decimal';

export interface Kpi {
  id: string;
  label: string;
  value: number | null;
  format: NumberFormat;
  change: number | null;
  changeLabel: string;
  direction: Direction;
  icon: string;
  note?: string;
}

export interface PricePoint {
  month: string;
  label: string;
  actual: number | null;
  fitted: number | null;
  forecast: number | null;
  lower: number | null;
  upper: number | null;
}

export interface CategoryRow {
  category: string;
  value: number;
  share: number;
  forecastChange: number;
  parts: number;
}

export interface PartRow {
  partId: string;
  partName: string;
  component: string;
  category: string;
  brand: string;
  project?: string;
  vendor?: string;
  vendorOrigin?: string;
  currentPrice: number;
  forecastPrice: number;
  change: number;
  isAnomaly: boolean;
  anomalyType: string;
  sparkline: number[];
}

export interface HorizonBar {
  month: string;
  label: string;
  value: number;
  lower: number | null;
  upper: number | null;
}

export interface AlertRow {
  partId: string;
  title: string;
  message: string;
  severity: 'high' | 'medium' | 'low';
  change: number | null;
}

export interface Insight {
  headline: string;
  body: string;
  tone: 'positive' | 'warning' | 'neutral';
}

export interface ModelMetric {
  model: string;
  mae: number;
  rmse: number;
  mape: number;
  n?: number;
  n_parts?: number;
}

export interface BacktestSummaryRow {
  model: string;
  mae_mean: number;
  mae_std: number;
  rmse_mean: number;
  rmse_std: number;
  mape_mean: number;
  mape_std: number;
}

/** One month of the real-data backtest: what was predicted vs what BLS published. */
export interface RealBacktestPoint {
  month: string;
  actual: number;
  predicted: number;
  lower: number | null;
  upper: number | null;
  horizon: number;
  abs_error: number;
  pct_error: number;
  within_interval: boolean | null;
}

export interface RealBacktest {
  series_id: string;
  model: string;
  train_start: string;
  train_end: string;
  test_start: string;
  test_end: string;
  n_train: number;
  n_test: number;
  mae: number;
  rmse: number;
  mape: number;
  coverage_pct: number | null;
  points: RealBacktestPoint[];
}

/** A forecast recorded before its target month was published. */
export interface LedgerEntry {
  forecast_made_on: string;
  origin_month: string;
  target_month: string;
  model: string;
  predicted: number;
  lower: number | null;
  upper: number | null;
  actual: number | null;
  abs_error: number | null;
  pct_error: number | null;
  within_interval: boolean | null;
  scored_on: string | null;
}

export interface LedgerSummary {
  n_entries: number;
  n_scored: number;
  n_pending: number;
  next_target_month: string | null;
  by_model: Record<
    string,
    { n_scored: number; mae: number; mape: number; coverage_pct: number | null }
  >;
  entries: LedgerEntry[];
}

export interface Validation {
  available: boolean;
  reason?: string;
  series_id?: string;
  n_real_observations?: number;
  real_range?: [string, string];
  excluded_extrapolated_months?: number;
  backtests: RealBacktest[];
  ledger: LedgerSummary;
}

/** Per-horizon error from the simulated-future test. */
export interface HorizonScore {
  horizon: number;
  target_month: string;
  mae: number;
  rmse: number;
  mape: number;
  mean_signed_pct: number;
  n: number;
}

export interface ModelScore {
  model: string;
  mae: number;
  rmse: number;
  mape: number;
  mean_signed_pct: number;
  worst_month: string;
  worst_month_mape: number;
  n: number;
  by_horizon: HorizonScore[];
}

export interface FutureSeriesPoint {
  month: string;
  label: string;
  actual: number | null;
  revealed: number | null;
  [key: string]: string | number | null;
}

export interface TargetModeResult {
  mape: number | null;
  mae: number | null;
  mean_signed_pct: number | null;
  by_horizon: HorizonScore[];
}

export interface NoiseFloor {
  byHorizon: {
    horizon: number;
    label: string;
    achieved: number;
    floor: number;
    excess: number;
    efficiencyPct: number;
  }[];
  meanFloorPct: number;
  bestAchievedPct: number | null;
  aggregateNoisePct: number;
  note: string;
}

export interface FutureTest {
  available: boolean;
  targetMode?: string;
  noiseFloor?: NoiseFloor;
  futureMonths?: number;
  trainEnd?: string;
  revealedRange?: [string, string];
  nParts?: number;
  scores: ModelScore[];
  series: FutureSeriesPoint[];
  byCategory: {
    category: string;
    mape: number;
    mae: number;
    mean_signed_pct: number;
    n: number;
  }[];
  disclaimer?: string;
  targetModeComparison?: {
    level?: TargetModeResult;
    log_return?: TargetModeResult;
    improvementPct?: number;
  };
}

/** One node of a hierarchy roll-up (a project, vendor, or category). */
export interface RollupRow {
  name: string;
  parts: number;
  currentSpend: number;
  forecastSpend: number;
  changePct: number;
  changeAbs: number;
}

export type HierarchyRollup = Record<string, RollupRow[]>;

/** Price response of one hierarchy node to an FX shock. */
export interface ScenarioLevelRow {
  name: string;
  parts: number;
  baselineValue: number;
  shockedValue: number;
  changePct: number;
  changeAbs: number;
}

export interface FxScenario {
  name: string;
  shockPct: number;
  pairs: string[];
  overallPriceChangePct: number;
  impliedElasticity: number;
  byLevel: Record<string, ScenarioLevelRow[]>;
}

/** Did the model recover the generator's FX structure? */
export interface FxLearning {
  available: boolean;
  reason?: string;
  shockPct?: number;
  spearman?: number;
  pearson?: number;
  verdict?: 'recovered' | 'partial' | 'not recovered';
  nCategories?: number;
  rows?: { category: string; trueBeta: number; modelledChangePct: number }[];
}

/** Is the FX effect detectable above noise? */
export interface FxSignalToNoise {
  available: boolean;
  betaSpread?: number;
  signalPct?: number;
  monthlyNoisePct?: number;
  categoryMeanNoisePct?: number;
  snr?: number;
  identifiable?: boolean;
  note?: string;
}

/** Is the FX effect separable from the time trend? Different question. */
export interface FxCollinearity {
  available: boolean;
  byPair?: { pair: string; cumulativeVsTime: number; risingMonthsPct: number }[];
  crossPairLevelCorr?: number | null;
  crossPairReturnCorr?: number | null;
  maxCumulativeVsTime?: number;
  separable?: boolean;
  note?: string;
}

export interface TrueExposureRow {
  category: string;
  code: string;
  material: string;
  eurBeta: number;
  usdBeta: number;
  totalBeta: number;
  lagMonths: number;
}

export interface FxPairProvenance {
  pair: string;
  base: string;
  quote: string;
  source: string;
  isReal: boolean;
  extrapolatedMonths: number;
  firstRate: number;
  lastRate: number;
  totalMovePct: number;
  observedStart: string | null;
}

export interface FxAnalysis {
  available: boolean;
  scenarios?: FxScenario[];
  learning?: FxLearning;
  signalToNoise?: FxSignalToNoise;
  collinearity?: FxCollinearity;
  rollups?: HierarchyRollup;
  trueExposure?: TrueExposureRow[];
  provenance?: { pairs: FxPairProvenance[]; allReal: boolean };
}

export interface GeoMediatorProvenance {
  name: string;
  source: string;
  isReal: boolean;
  unit: string;
  first: number;
  last: number;
  totalMovePct: number;
}

export interface GeoEventRow {
  event_id: string;
  date_start: string;
  date_end: string | null;
  category: string;
  severity: number;
  region_scope: string;
  channels_affected: string[];
  source: string;
  confidence: number;
  narrative: string;
  nlp_severity: number | null;
}

export interface GeoScenarioLevelRow {
  name: string;
  priceChangePct: number;
  nParts: number;
}

export interface GeoScenario {
  name: string;
  family: string;
  shockPct: number;
  pairs: string[];
  overallPriceChangePct: number;
  impliedElasticity: number;
  byLevel: Record<string, GeoScenarioLevelRow[]>;
}

export interface GeoMediation {
  available: boolean;
  reason?: string;
  nMonths?: number;
  totalCorrGprPrice?: number;
  partialCorrGprPriceGivenMediators?: number;
  mediators?: string[];
  interpretation?: string;
}

export interface EventStudyPoint {
  offset: number;
  logDelta: number | null;
  pctDelta: number | null;
}

export interface EventStudy {
  eventId: string;
  category: string;
  severity: number;
  regionScope: string;
  narrative: string;
  anchorMonth: string;
  path: EventStudyPoint[];
}

export interface GeoFrameworkLayer {
  id: string;
  name: string;
  items: string[];
}

export interface GeoAnalysis {
  available: boolean;
  scenarios?: GeoScenario[];
  mediation?: GeoMediation;
  eventStudies?: EventStudy[];
  provenance?: {
    mediators: GeoMediatorProvenance[];
    nEvents: number;
    events: GeoEventRow[];
    framework: {
      layers: GeoFrameworkLayer[];
      claim: string;
      causalityNote: string;
    };
    allReal: boolean;
    commoditiesReal?: boolean;
    freightReal?: boolean;
    gprReal?: boolean;
  };
  hitl?: GeoHitlBlock;
}

/** Source check for one transmission channel on an alert. */
export interface SourceVerification {
  channel: string;
  source: string;
  isVerified: boolean;
  note: string;
}

/** Pre-computed impact — only rendered after the user confirms. */
export interface GeoAlertImpact {
  available: boolean;
  reason?: string;
  eventId?: string;
  shockPct?: number;
  horizonMonths?: number;
  overallPriceChangePct?: number;
  direction?: 'up' | 'down' | 'flat';
  channelsUsed?: string[];
  byCategory?: GeoScenarioLevelRow[];
  explanation?: string;
  causalityNote?: string;
}

/** One geopolitical news signal awaiting analyst review. */
export interface GeoAlert {
  alertId: string;
  headline: string;
  reportedAt: string;
  eventId: string;
  category: string;
  severity: number;
  regionScope: string;
  narrative: string;
  channelsAffected: string[];
  confidence: number;
  source: string;
  nlpSeverity?: number | null;
  sourceVerifications: SourceVerification[];
  allSourcesVerified: boolean;
  prompt: string;
  impact: GeoAlertImpact;
}

/** One driver explaining recent forecast movement. */
export interface ForecastDriver {
  id: string;
  label: string;
  direction: 'up' | 'down' | 'flat';
  magnitude: number;
  currentValue: number;
  priorValue: number;
  source: string;
  isReal: boolean;
  explanation: string;
}

export interface ForecastDriverReport {
  available: boolean;
  reason?: string;
  periodLabel?: string;
  portfolioMomPct?: number | null;
  summary?: string;
  drivers?: ForecastDriver[];
  note?: string;
}

export interface GeoHitlBlock {
  available: boolean;
  policy?: string;
  alerts?: GeoAlert[];
  forecastDrivers?: ForecastDriverReport;
}

/**
 * Not a probability — a signal-to-error ratio.
 *
 * `high` means the predicted move is at least 2x the model's typical error at
 * that horizon, so the direction is worth acting on. `low` means the move sits
 * inside the noise.
 */
export interface Confidence {
  level: 'high' | 'medium' | 'low';
  signalToErrorRatio: number;
  expectedErrorPct: number;
}

export interface ForecastReasonDriver {
  id: string;
  label: string;
  direction: 'up' | 'down' | 'flat';
  magnitude: number;
  source: string;
  isReal: boolean;
  evidence: string;
}

export interface ForecastReason {
  available: boolean;
  summary: string;
  story?: string;
  tip?: string;
  drivers: ForecastReasonDriver[];
  causalityNote?: string;
}

export interface TreePart {
  partId: string;
  partName: string;
  currentPrice: number;
  forecastPrice: number;
  lower: number | null;
  upper: number | null;
  changePct: number;
  changeAbs: number;
  isAnomaly: boolean;
  anomalyType: string;
  confidence: Confidence;
  reason?: ForecastReason;
}

export interface TreeCategory {
  name: string;
  currentSpend: number;
  forecastSpend: number;
  changePct: number;
  changeAbs: number;
  partCount: number;
  parts: TreePart[];
}

export interface TreeVendor {
  name: string;
  origin: string;
  currentSpend: number;
  forecastSpend: number;
  changePct: number;
  changeAbs: number;
  categoryCount: number;
  categories: TreeCategory[];
}

export interface TreeProject {
  name: string;
  currentSpend: number;
  forecastSpend: number;
  changePct: number;
  changeAbs: number;
  vendorCount: number;
  vendors: TreeVendor[];
}

export interface DataSource {
  id: string;
  name: string;
  kind: string;
  provider: string;
  identifier: string;
  endpoint: string | null;
  isReal: boolean;
  status: 'real' | 'synthetic' | 'fallback';
  frequency: string;
  coverage: string;
  observations: number;
  caveat: string;
  usedFor: string;
  auth: string;
}

export type DriverStatus = 'implemented' | 'available' | 'roadmap';

export interface DriverSource {
  provider: string;
  access: 'free' | 'paid' | 'customer';
  frequency: string;
  latency: string;
  endpoint?: string;
}

/** One candidate forecasting parameter in the roadmap catalogue. */
export interface Driver {
  id: string;
  name: string;
  group: string;
  description: string;
  impact_channel: string;
  direction: string;
  effort: 'low' | 'medium' | 'high';
  example: string;
  sources: DriverSource[];
  status: DriverStatus;
  matchedFeatures?: string[];
  matchedFeatureCount?: number;
  affectsPrediction?: boolean;
  selectionNote?: string;
}

export interface ParameterCatalogue {
  groups: string[];
  drivers: Driver[];
  counts: Record<DriverStatus, number>;
  total: number;
  note: string;
  selection?: {
    nSelected: number;
    nRejected: number;
    asOf?: string;
    reason?: string;
    nScored?: number;
  };
}

export interface FeatureSelectionBlock {
  available?: boolean;
  asOf?: string;
  selected?: string[];
  rejected?: string[];
  nSelected?: number;
  nRejected?: number;
  nCandidates?: number;
  reason?: string;
  groups?: Record<string, { kept?: boolean; reason?: string; ablationLiftPct?: number | null }>;
}

export interface DriftBlock {
  available?: boolean;
  alert?: boolean;
  mapeAlert?: boolean;
  psiAlert?: boolean;
  currentMape?: number | null;
  priorMape?: number | null;
  mapeDeltaPp?: number | null;
  maxPsi?: number;
  summary?: string;
}

export interface OpsMeta {
  retrainCadence?: string;
  scoreCadence?: string;
  forecastHorizonMonths?: number;
  lastRetrainAt?: string;
  lastScoreAt?: string;
  modelVersion?: string;
  holdoutMape?: number | null;
  nSelectedFeatures?: number;
}

export interface RiskRow {
  name: string;
  spendAtRisk: number;
  shareOfRisk: number;
  parts: number;
  avgIncreasePct: number;
}

export interface RiskConcentration {
  available: boolean;
  thresholdPct?: number;
  totalSpendAtRisk?: number;
  partsAtRisk?: number;
  top4VendorSharePct?: number;
  byDimension?: Record<string, RiskRow[]>;
}

export interface MacroPoint {
  month: string;
  label: string;
  value: number;
  isReal: boolean;
}

export interface DashboardData {
  meta: {
    generatedAt: string;
    projectName: string;
    randomSeed: number;
    forecastHorizon: number;
    historyMonths: number;
    nParts: number;
    nCategories: number;
    nProjects?: number;
    nVendors?: number;
    currency?: string;
    currencySymbol?: string;
    historyRange: [string, string];
    versions: Record<string, string>;
    ops?: OpsMeta;
  };
  provenance: {
    macroSeriesId: string;
    macroSource: string;
    macroIsReal: boolean;
    extrapolatedMonths: number;
    skuLayer: string;
    skuIsReal?: boolean;
    disclaimer: string;
    poIngest?: Record<string, unknown> | null;
  };
  featureSelection?: FeatureSelectionBlock;
  drift?: DriftBlock;
  kpis: Kpi[];
  priceSeries: PricePoint[];
  categories: CategoryRow[];
  topParts: PartRow[];
  horizon: HorizonBar[];
  alerts: AlertRow[];
  insight: Insight;
  modelComparison: ModelMetric[];
  backtestSummary: BacktestSummaryRow[];
  validation: Validation;
  /** Optional: absent from payloads written before the futuretest stage existed. */
  futureTest?: FutureTest;
  /** Optional: absent from payloads written before the fxscenario stage existed. */
  fxAnalysis?: FxAnalysis;
  /** Optional: absent from payloads written before the geoscenario stage existed. */
  geoAnalysis?: GeoAnalysis;
  hierarchy?: HierarchyRollup;
  riskConcentration?: RiskConcentration;
  tree?: TreeProject[];
  dataSources?: DataSource[];
  parameterCatalogue?: ParameterCatalogue;
  macroSeries: MacroPoint[];
}
