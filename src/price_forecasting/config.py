"""Typed configuration loading.

The whole pipeline is driven by ``config.yaml``. Rather than passing raw dicts
around (which silently tolerate typos), the YAML is parsed into frozen
dataclasses so a bad key fails loudly at startup instead of halfway through a
training run.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml


class ConfigError(ValueError):
    """Raised when config.yaml is missing keys or holds implausible values."""


# --------------------------------------------------------------------------- #
# Section dataclasses
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ProjectConfig:
    name: str
    random_seed: int


@dataclass(frozen=True)
class PathsConfig:
    """Filesystem layout. All paths are resolved relative to the project root."""

    root: Path
    data_raw: Path
    data_processed: Path
    reports: Path
    figures: Path
    models: Path

    def ensure(self) -> None:
        """Create every output directory. Idempotent."""
        for f in dataclasses.fields(self):
            if f.name == "root":
                continue
            getattr(self, f.name).mkdir(parents=True, exist_ok=True)


@dataclass(frozen=True)
class SourcingConfig:
    bls_api_base: str
    series_id: str
    fallback_series_id: str
    request_timeout_seconds: int
    cache_ttl_days: int
    offline_annual_inflation: float


@dataclass(frozen=True)
class FxConfig:
    """Currency exposure setup.

    ``pairs`` is a list of ``{base, quote, channel, fallback_rate}`` mappings.
    ``channel`` distinguishes the direct import-invoicing effect from the
    indirect commodity effect, which have different elasticities.
    """

    api_base: str
    base_currency: str
    pairs: List[Dict[str, Any]]
    scenario_shocks: List[float]
    default_pass_through_lag: int
    base_pass_through: float

    def pair_names(self) -> List[str]:
        return [f"{p['base']}{p['quote']}" for p in self.pairs]

    def channel_for(self, pair: str) -> str:
        for spec in self.pairs:
            if f"{spec['base']}{spec['quote']}" == pair:
                return str(spec.get("channel", "import_invoicing"))
        return "import_invoicing"


@dataclass(frozen=True)
class GeoConfig:
    """Geopolitical mediators, event calendar and scenario shocks."""

    enabled: bool
    cache_ttl_days: int
    events_filename: str
    gpr_url: str
    pink_sheet_url: str
    pink_sheet_discover_url: str
    freight_filename: str
    freight_url: str
    feature_mode: str
    mediator_lags: List[int]
    mediator_return_periods: List[int]
    gpr_lags: List[int]
    event_decay_half_life_months: float
    commodity_pass_through: float
    freight_pass_through: float
    gpr_direct_pass_through: float
    scenario_freight_shocks: List[float]
    scenario_gpr_shocks: List[float]
    scenario_duty_shocks: List[float]


@dataclass(frozen=True)
class SkuConfig:
    """Where part-level prices come from.

    ``auto`` uses ``purchase_orders.csv`` when present, otherwise the synthetic
    generator. Flip to ``purchase_orders`` to fail loudly if the file is missing.
    """

    mode: str
    purchase_orders_filename: str
    panel_filename: str


@dataclass(frozen=True)
class GenerationConfig:
    n_parts: int
    history_months: int
    focus_months: int
    end_month: str
    n_anomaly_parts: int
    drift_mu: float
    drift_sigma: float
    noise_phi: float
    noise_sigma: float
    missing_value_rate: float


@dataclass(frozen=True)
class PreprocessingConfig:
    max_ffill_gap: int
    min_history_months: int
    outlier_mad_threshold: float
    outlier_window: int
    outlier_min_scale_frac: float
    winsorize_outliers: bool
    lags: List[int]
    rolling_windows: List[int]
    fx_lags: List[int]
    fx_return_periods: List[int]


@dataclass(frozen=True)
class SarimaConfig:
    order: List[int]
    seasonal_order: List[int]
    fallback_order: List[int]
    max_parts: int


@dataclass(frozen=True)
class XGBoostConfig:
    n_estimators: int
    max_depth: int
    learning_rate: float
    subsample: float
    colsample_bytree: float
    min_child_weight: int
    reg_lambda: float
    n_jobs: int

    def as_params(self, seed: int) -> Dict[str, Any]:
        """Return kwargs for ``xgboost.XGBRegressor``."""
        params = dataclasses.asdict(self)
        params["random_state"] = seed
        return params


@dataclass(frozen=True)
class FeatureSelectionConfig:
    top_k: int
    min_ablation_lift_pct: float
    always_keep_prefixes: List[str]
    run_ablation: bool = True


@dataclass(frozen=True)
class OpsConfig:
    """Monthly retrain / weekly score operating loop."""

    retrain_cadence: str
    score_cadence: str
    mape_drift_alert_pp: float
    psi_alert_threshold: float
    feature_selection: FeatureSelectionConfig


@dataclass(frozen=True)
class ModelingConfig:
    forecast_horizon: int
    validation_months: int
    test_months: int
    xgboost_target_mode: str
    sarima: SarimaConfig
    xgboost: XGBoostConfig


@dataclass(frozen=True)
class EvaluationConfig:
    backtest_folds: int
    backtest_horizon: int
    prediction_interval: float
    interval_coverage_target: float
    interval_max_inflate: float
    future_test_months: int


@dataclass(frozen=True)
class VisualizationConfig:
    grid_parts: int
    dpi: int
    figure_width: float
    style: str
    palette: str


@dataclass(frozen=True)
class LoggingConfig:
    level: str
    format: str
    datefmt: str


@dataclass(frozen=True)
class MaterialCostConfig:
    """Material Cost Dashboard baselines and spend basis."""

    commercial_filename: str
    nomination_month: Optional[str]
    sop_month: Optional[str]
    volume_weight: str  # annual_part_volume | project_volume | none
    require_commercial: bool


@dataclass(frozen=True)
class Config:
    """Root configuration object handed to every pipeline stage."""

    project: ProjectConfig
    paths: PathsConfig
    sourcing: SourcingConfig
    fx: FxConfig
    geo: GeoConfig
    sku: SkuConfig
    generation: GenerationConfig
    preprocessing: PreprocessingConfig
    modeling: ModelingConfig
    evaluation: EvaluationConfig
    ops: OpsConfig
    visualization: VisualizationConfig
    logging: LoggingConfig
    material_cost: MaterialCostConfig
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)


# --------------------------------------------------------------------------- #
# Loading
# --------------------------------------------------------------------------- #


def _require(section: Dict[str, Any], name: str) -> Dict[str, Any]:
    if name not in section:
        raise ConfigError(f"config.yaml is missing required section '{name}'")
    value = section[name]
    if not isinstance(value, dict):
        raise ConfigError(f"config.yaml section '{name}' must be a mapping")
    return value


def _build(cls: type, payload: Dict[str, Any], section_name: str):
    """Instantiate a dataclass from a YAML mapping, reporting bad keys clearly."""
    expected = {f.name for f in dataclasses.fields(cls)}
    unknown = set(payload) - expected
    if unknown:
        raise ConfigError(
            f"config.yaml section '{section_name}' has unknown key(s): "
            f"{sorted(unknown)}. Expected a subset of {sorted(expected)}"
        )
    missing = expected - set(payload)
    if missing:
        raise ConfigError(
            f"config.yaml section '{section_name}' is missing key(s): {sorted(missing)}"
        )
    return cls(**payload)


def load_config(path: str | Path) -> Config:
    """Load and validate ``config.yaml``.

    Args:
        path: Path to the YAML config file.

    Returns:
        A fully populated :class:`Config`.

    Raises:
        ConfigError: If the file is absent, malformed, or holds invalid values.
    """
    config_path = Path(path).expanduser().resolve()
    if not config_path.is_file():
        raise ConfigError(f"config file not found: {config_path}")

    with config_path.open("r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle)

    if not isinstance(raw, dict):
        raise ConfigError(f"config file {config_path} did not parse to a mapping")

    root = config_path.parent

    paths_raw = _require(raw, "paths")
    paths = PathsConfig(
        root=root,
        **{key: (root / value) for key, value in paths_raw.items()},
    )

    modeling_raw = dict(_require(raw, "modeling"))
    sarima = _build(SarimaConfig, _require(modeling_raw, "sarima"), "modeling.sarima")
    xgboost_cfg = _build(
        XGBoostConfig, _require(modeling_raw, "xgboost"), "modeling.xgboost"
    )
    modeling_raw["sarima"] = sarima
    modeling_raw["xgboost"] = xgboost_cfg

    ops_raw = dict(_require(raw, "ops"))
    fs_cfg = _build(
        FeatureSelectionConfig,
        _require(ops_raw, "feature_selection"),
        "ops.feature_selection",
    )
    ops_raw["feature_selection"] = fs_cfg

    mc_defaults = {
        "commercial_filename": "commercial_baselines.csv",
        "nomination_month": None,
        "sop_month": None,
        "volume_weight": "none",
        "require_commercial": False,
    }
    mc_raw = dict(mc_defaults)
    mc_raw.update(raw.get("material_cost") or {})
    # YAML null → None; blank string → None for months
    for month_key in ("nomination_month", "sop_month"):
        val = mc_raw.get(month_key)
        if val is None or (isinstance(val, str) and not val.strip()):
            mc_raw[month_key] = None
        else:
            mc_raw[month_key] = str(val).strip()
    mc_raw["require_commercial"] = bool(mc_raw.get("require_commercial", False))
    mc_raw["volume_weight"] = str(mc_raw.get("volume_weight") or "none")
    mc_raw["commercial_filename"] = str(
        mc_raw.get("commercial_filename") or "commercial_baselines.csv"
    )
    unknown_mc = set(mc_raw) - {f.name for f in dataclasses.fields(MaterialCostConfig)}
    if unknown_mc:
        raise ConfigError(
            f"config.yaml section 'material_cost' has unknown key(s): {sorted(unknown_mc)}"
        )
    material_cost_cfg = MaterialCostConfig(**mc_raw)

    config = Config(
        project=_build(ProjectConfig, _require(raw, "project"), "project"),
        paths=paths,
        sourcing=_build(SourcingConfig, _require(raw, "sourcing"), "sourcing"),
        fx=_build(FxConfig, _require(raw, "fx"), "fx"),
        geo=_build(GeoConfig, _require(raw, "geo"), "geo"),
        sku=_build(SkuConfig, _require(raw, "sku"), "sku"),
        generation=_build(GenerationConfig, _require(raw, "generation"), "generation"),
        preprocessing=_build(
            PreprocessingConfig, _require(raw, "preprocessing"), "preprocessing"
        ),
        modeling=_build(ModelingConfig, modeling_raw, "modeling"),
        evaluation=_build(EvaluationConfig, _require(raw, "evaluation"), "evaluation"),
        ops=_build(OpsConfig, ops_raw, "ops"),
        visualization=_build(
            VisualizationConfig, _require(raw, "visualization"), "visualization"
        ),
        logging=_build(LoggingConfig, _require(raw, "logging"), "logging"),
        material_cost=material_cost_cfg,
        raw=raw,
    )

    _validate(config)
    return config


def _validate(config: Config) -> None:
    """Cross-field sanity checks that a schema alone would not catch."""
    gen = config.generation
    mod = config.modeling

    if gen.n_parts < 1:
        raise ConfigError("generation.n_parts must be >= 1")

    if gen.n_anomaly_parts > gen.n_parts:
        raise ConfigError(
            f"generation.n_anomaly_parts ({gen.n_anomaly_parts}) exceeds "
            f"n_parts ({gen.n_parts})"
        )

    # SARIMA with a 12-month seasonal cycle needs at least two full cycles plus
    # room for differencing. Catching this here beats a wall of convergence
    # warnings later.
    seasonal_period = mod.sarima.seasonal_order[3]
    if gen.history_months < 2 * seasonal_period:
        raise ConfigError(
            f"generation.history_months ({gen.history_months}) is below two "
            f"seasonal cycles ({2 * seasonal_period}); seasonal SARIMA cannot be "
            f"identified. Increase history_months or drop the seasonal order."
        )

    holdout = mod.validation_months + mod.test_months
    if holdout >= gen.history_months:
        raise ConfigError(
            f"modeling.validation_months + test_months ({holdout}) leaves no "
            f"training data given history_months={gen.history_months}"
        )

    if gen.focus_months > gen.history_months:
        raise ConfigError(
            "generation.focus_months cannot exceed generation.history_months"
        )

    if not config.fx.pairs:
        raise ConfigError("fx.pairs must list at least one currency pair")

    for spec in config.fx.pairs:
        missing_keys = {"base", "quote"} - set(spec)
        if missing_keys:
            raise ConfigError(f"fx.pairs entry missing {sorted(missing_keys)}: {spec}")
        if spec["quote"] != config.fx.base_currency:
            raise ConfigError(
                f"fx pair {spec['base']}/{spec['quote']} does not quote into "
                f"fx.base_currency ({config.fx.base_currency}); pass-through "
                f"maths assumes every pair converts into the pricing currency"
            )

    if not 0.0 <= config.fx.base_pass_through <= 1.0:
        raise ConfigError("fx.base_pass_through must be in [0, 1]")

    if config.fx.default_pass_through_lag < 0:
        raise ConfigError("fx.default_pass_through_lag must be >= 0")

    geo = config.geo
    for field_name in (
        "commodity_pass_through",
        "freight_pass_through",
        "gpr_direct_pass_through",
    ):
        value = getattr(geo, field_name)
        if not 0.0 <= value <= 1.0:
            raise ConfigError(f"geo.{field_name} must be in [0, 1]")
    if geo.event_decay_half_life_months <= 0:
        raise ConfigError("geo.event_decay_half_life_months must be > 0")

    if mod.xgboost_target_mode not in ("level", "log_return"):
        raise ConfigError(
            f"modeling.xgboost_target_mode must be 'level' or 'log_return', "
            f"got '{mod.xgboost_target_mode}'"
        )

    mc = config.material_cost
    if mc.volume_weight not in (
        "annual_part_volume",
        "project_volume",
        "none",
        "unit",
    ):
        raise ConfigError(
            "material_cost.volume_weight must be one of "
            "annual_part_volume | project_volume | none"
        )

    if not 0.0 < config.evaluation.prediction_interval < 1.0:
        raise ConfigError("evaluation.prediction_interval must be in (0, 1)")

    if not 0.0 < config.evaluation.interval_coverage_target < 1.0:
        raise ConfigError("evaluation.interval_coverage_target must be in (0, 1)")
    if config.evaluation.interval_max_inflate < 1.0:
        raise ConfigError("evaluation.interval_max_inflate must be >= 1")

    if config.geo.feature_mode not in ("sparse", "full"):
        raise ConfigError("geo.feature_mode must be 'sparse' or 'full'")

    if config.sku.mode not in ("auto", "synthetic", "purchase_orders"):
        raise ConfigError(
            "sku.mode must be 'auto', 'synthetic', or 'purchase_orders'"
        )

    if mod.forecast_horizon < 1:
        raise ConfigError("modeling.forecast_horizon must be >= 1")

    if config.ops.feature_selection.top_k < 1:
        raise ConfigError("ops.feature_selection.top_k must be >= 1")
    if config.ops.mape_drift_alert_pp < 0:
        raise ConfigError("ops.mape_drift_alert_pp must be >= 0")
    if config.ops.psi_alert_threshold < 0:
        raise ConfigError("ops.psi_alert_threshold must be >= 0")

    if not 0.0 <= gen.missing_value_rate < 0.5:
        raise ConfigError("generation.missing_value_rate must be in [0, 0.5)")

    if config.preprocessing.min_history_months > gen.history_months:
        raise ConfigError(
            "preprocessing.min_history_months exceeds generation.history_months; "
            "every part would be treated as insufficient"
        )
