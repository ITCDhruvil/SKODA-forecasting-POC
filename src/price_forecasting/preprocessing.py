"""Cleaning, outlier flagging and leak-free feature engineering.

The governing rule: **a feature row stamped month t may only use information
available at month t.** Every window operation here is trailing, never centred,
and every cross-part operation is grouped by ``part_id``. ``tests/test_smoke.py``
asserts this directly by perturbing future prices and checking that earlier
feature rows do not move.

The one deliberate exception is ``outlier_flag``, which uses a centred window
because detecting a level shift needs evidence from both sides of it. It is a
diagnostic column only and is excluded from :data:`FEATURE_COLUMNS`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from .config import Config
from .data_sourcing import MacroSeries
from .fx import FxSeries
from .geopolitical import (
    GeoBundle,
    commodity_key_for_row,
    event_monthly_features,
    material_intensity_series,
)
from .logging_utils import get_logger

logger = get_logger(__name__)

# Columns that must never be handed to a model.
#
# Three kinds: identifiers, the raw target, and **generative ground truth**. The
# ``true_*`` FX betas are the coefficients the generator used to build prices.
# Recovering them is the whole test of whether the model learned FX transmission,
# so feeding them in would be answer-key leakage of the worst sort - the metrics
# would look excellent and mean nothing.
NON_FEATURE_COLUMNS = frozenset(
    {
        "part_id", "part_name", "component", "month", "price",
        "is_anomaly_part", "anomaly_type", "outlier_flag",
        "price_was_imputed", "insufficient_history",
        "true_eur_beta", "true_usd_beta", "true_fx_lag",
        "true_steel_beta", "true_freight_beta", "true_gpr_beta",
        "commodity_key",
    }
)

# Hierarchy dimensions plus part characteristics. XGBoost consumes pandas
# 'category' dtype natively, so no one-hot expansion is needed.
CATEGORICAL_COLUMNS = (
    "project_code", "vendor_code", "category_code",
    "oem", "segment", "vendor_origin", "material", "complexity_tier",
)

STATIC_NUMERIC_FEATURES = frozenset(
    {
        "project_volume",
        "project_localisation",
        "vendor_import_dependency",
        "vendor_reprice_months",
        "annual_part_volume",
        "weight_kg",
        "material_intensity",
    }
)

CALENDAR_FEATURES = frozenset(
    {
        "month_sin",
        "month_cos",
        "macro_mom_pct",
        "macro_yoy_pct",
        "price_mom_pct",
        "price_yoy_pct",
        "price_vs_expanding_mean",
    }
)

SPARSE_GEO_EVENT_COLUMNS = frozenset(
    {
        "geo_event_any",
        "geo_event_tariff",
        "geo_event_chokepoint",
        "geo_event_conflict_decay",
        "geo_event_tariff_decay",
        "geo_event_chokepoint_decay",
        "geo_event_conflict_decay_x_import",
        "geo_event_tariff_x_import",
        "geo_event_tariff_decay_x_import",
        "geo_event_chokepoint_x_import",
        "geo_event_chokepoint_decay_x_import",
    }
)

FULL_GEO_EVENT_COLUMNS = frozenset(
    {
        "geo_event_conflict",
        "geo_event_conflict_severity",
        "geo_event_conflict_decay",
        "geo_event_tariff",
        "geo_event_tariff_severity",
        "geo_event_tariff_decay",
        "geo_event_chokepoint",
        "geo_event_chokepoint_severity",
        "geo_event_chokepoint_decay",
        "geo_event_sanction",
        "geo_event_sanction_severity",
        "geo_event_sanction_decay",
        "geo_event_trade_agreement",
        "geo_event_trade_agreement_severity",
        "geo_event_trade_agreement_decay",
        "geo_event_any",
        "geo_event_max_severity",
        "geo_event_conflict_decay_x_import",
        "geo_event_tariff_x_import",
        "geo_event_tariff_decay_x_import",
        "geo_event_chokepoint_x_import",
        "geo_event_chokepoint_decay_x_import",
    }
)

EXCLUDED_MODEL_FEATURES = frozenset(
    {
        "month_of_year",
        "months_since_start",
        "macro_index",
        "price_roll_mean_3",
        "price_roll_mean_6",
        "price_expanding_mean",
        "hier_vendor_category_logprice",
        "fx_eurinr_ret_6m",
        "fx_eurinr_ret_12m",
        "fx_eurinr_ret_lag6",
        "fx_eurinr_ret_lag6_x_import",
        "fx_eurinr_ret_lag6_x_content",
        "fx_usdinr_ret_6m",
        "fx_usdinr_ret_12m",
        "fx_usdinr_ret_lag6",
        "fx_usdinr_ret_lag6_x_import",
        "fx_usdinr_ret_lag6_x_content",
    }
)

# Hierarchy levels for target encoding, coarse to fine. Cross-level keys let the
# model learn that, say, Bosch prices sensors differently from how Bosch prices
# braking - an interaction a flat categorical cannot express.
HIERARCHY_LEVELS: tuple[tuple[str, ...], ...] = (
    ("project_code",),
    ("vendor_code",),
    ("category_code",),
    ("project_code", "category_code"),
    ("vendor_code", "category_code"),
    ("project_code", "vendor_code"),
)


def _causal_expanding_zscore(series: pd.Series, min_periods: int = 3) -> pd.Series:
    """Normalise each point using only earlier observations.

    For month t, statistics come from months < t via shift(1). This keeps the
    feature causal and avoids diluting the current move into its own baseline.
    """
    series = pd.Series(series, copy=False)
    history = series.shift(1)
    mean = history.expanding(min_periods=min_periods).mean()
    std = history.expanding(min_periods=min_periods).std()
    denom = std.where(std > 1e-6)
    return (series - mean) / denom


def _allowed_event_columns(feature_mode: str) -> frozenset[str]:
    return SPARSE_GEO_EVENT_COLUMNS if feature_mode == "sparse" else FULL_GEO_EVENT_COLUMNS


def _feature_contract(config: Optional[Config] = None) -> tuple[set[str], tuple[str, ...], frozenset[str]]:
    exact = set(CATEGORICAL_COLUMNS) | set(STATIC_NUMERIC_FEATURES) | set(CALENDAR_FEATURES)
    prefixes = (
        "price_lag_",
        "price_roll_mean_",
        "price_roll_std_",
        "fx_",
        "cmd_",
        "freight_",
        "gpr",
        "chokepoint_",
        "hier_",
    )
    events = _allowed_event_columns(config.geo.feature_mode) if config is not None else FULL_GEO_EVENT_COLUMNS
    return exact, prefixes, events


def _is_contract_feature(name: str, config: Optional[Config] = None) -> bool:
    if name in EXCLUDED_MODEL_FEATURES:
        return False
    exact, prefixes, event_columns = _feature_contract(config)
    if name in exact or name in event_columns:
        return True
    return any(name.startswith(prefix) for prefix in prefixes)


def _resolved_feature_columns(
    frame: pd.DataFrame, config: Optional[Config] = None
) -> List[str]:
    label_columns = {"project", "vendor", "category"}
    return [
        col
        for col in frame.columns
        if col not in NON_FEATURE_COLUMNS
        and col not in label_columns
        and col not in ("macro_index_month",)
        and not _is_raw_fx_level(col)
        and _is_contract_feature(col, config)
    ]


@dataclass
class PreprocessingReport:
    """Diagnostics from the cleaning stage, surfaced in the final report."""

    n_rows_in: int = 0
    n_parts_in: int = 0
    n_missing_prices: int = 0
    n_imputed: int = 0
    n_unfillable: int = 0
    n_outliers_flagged: int = 0
    insufficient_history_parts: List[str] = field(default_factory=list)
    feature_columns: List[str] = field(default_factory=list)
    hierarchy_features: List[str] = field(default_factory=list)
    fx_features: List[str] = field(default_factory=list)
    geo_features: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, object]:
        return {
            "rows_in": self.n_rows_in,
            "parts_in": self.n_parts_in,
            "missing_prices": self.n_missing_prices,
            "imputed_by_ffill": self.n_imputed,
            "unfillable_dropped": self.n_unfillable,
            "outliers_flagged": self.n_outliers_flagged,
            "insufficient_history_parts": len(self.insufficient_history_parts),
            "n_features": len(self.feature_columns),
            "n_hierarchy_features": len(self.hierarchy_features),
            "n_fx_features": len(self.fx_features),
            "n_geo_features": len(self.geo_features),
        }


# --------------------------------------------------------------------------- #
# Cleaning
# --------------------------------------------------------------------------- #


def _ensure_complete_grid(panel: pd.DataFrame) -> pd.DataFrame:
    """Reindex every part onto the full month grid.

    A part missing from a month entirely (rather than having a NaN price) would
    otherwise silently shift its lag features by one position, which is a subtle
    and nasty source of wrong answers.
    """
    months = pd.DatetimeIndex(sorted(panel["month"].unique()))
    # Everything that describes the part rather than the month. Constant within
    # a part, so filling them across a reindexed gap is exact, not an estimate.
    static_cols = [
        column
        for column in (
            "part_name", "project_code", "project", "oem", "segment",
            "project_volume", "project_localisation", "vendor_code", "vendor",
            "vendor_origin", "vendor_import_dependency", "vendor_reprice_months",
            "category_code", "category", "material", "complexity_tier",
            "annual_part_volume", "weight_kg",
            "true_eur_beta", "true_usd_beta", "true_fx_lag",
            "true_steel_beta", "true_freight_beta", "true_gpr_beta",
            "is_anomaly_part", "anomaly_type",
        )
        if column in panel.columns
    ]

    frames = []
    for part_id, group in panel.groupby("part_id", sort=True):
        group = group.sort_values("month").set_index("month")
        reindexed = group.reindex(months)
        reindexed["part_id"] = part_id
        # Static attributes do not vary within a part, so forward/backward fill
        # is exact, not an approximation.
        for col in static_cols:
            if col in reindexed.columns:
                reindexed[col] = reindexed[col].ffill().bfill()
        frames.append(reindexed.reset_index().rename(columns={"index": "month"}))

    return pd.concat(frames, ignore_index=True)


def clean_panel(
    panel: pd.DataFrame, config: Config, report: PreprocessingReport
) -> pd.DataFrame:
    """Impute short gaps, flag outliers, and mark parts with thin history.

    Args:
        panel: Long-format raw panel.
        config: Pipeline configuration.
        report: Mutated in place with diagnostics.

    Returns:
        Cleaned panel with ``price_was_imputed``, ``outlier_flag`` and
        ``insufficient_history`` columns added.
    """
    prep = config.preprocessing
    panel = panel.copy()
    panel["month"] = pd.to_datetime(panel["month"])
    panel = panel.sort_values(["part_id", "month"]).reset_index(drop=True)

    report.n_rows_in = len(panel)
    report.n_parts_in = panel["part_id"].nunique()

    panel = _ensure_complete_grid(panel)
    panel = panel.sort_values(["part_id", "month"]).reset_index(drop=True)

    missing_mask = panel["price"].isna()
    report.n_missing_prices = int(missing_mask.sum())
    panel["price_was_imputed"] = missing_mask

    # Forward-fill within each part, but only across short gaps. A long gap
    # means the part genuinely had no price, and carrying a stale value across
    # it would invent data.
    grouped = panel.groupby("part_id", sort=False)["price"]
    panel["price"] = grouped.ffill(limit=prep.max_ffill_gap)

    # A leading NaN cannot be forward-filled, so back-fill is the only option
    # for it. Crucially this is applied ONLY to positions before a part's first
    # real observation. Applying bfill generally would also patch the trailing
    # edge of interior gaps using the month *after* them - future information
    # flowing backwards into the feature set.
    first_valid = panel.groupby("part_id", sort=False)["price"].transform(
        lambda s: s.notna().cumsum()
    )
    leading_gap = first_valid == 0
    backfilled = panel.groupby("part_id", sort=False)["price"].bfill()
    panel.loc[leading_gap, "price"] = backfilled[leading_gap]

    unfillable = panel["price"].isna()
    report.n_unfillable = int(unfillable.sum())
    report.n_imputed = int(missing_mask.sum() - unfillable.sum())

    if report.n_unfillable:
        logger.warning(
            "%d observation(s) could not be filled within a %d-month gap limit; "
            "left as NaN and excluded from training",
            report.n_unfillable,
            prep.max_ffill_gap,
        )
    logger.info(
        "imputed %d of %d missing prices by forward-fill (gap limit %d months)",
        report.n_imputed,
        report.n_missing_prices,
        prep.max_ffill_gap,
    )

    panel = _flag_outliers(panel, config, report)
    panel = _flag_insufficient_history(panel, config, report)
    return panel


def _flag_outliers(
    panel: pd.DataFrame, config: Config, report: PreprocessingReport
) -> pd.DataFrame:
    """Flag price points far from a local median, using a robust MAD z-score.

    Deliberately **flags rather than removes**. Four parts in this dataset carry
    genuine structural breaks; smoothing them away would erase exactly the
    robustness test they exist to provide. Winsorisation is available behind a
    config switch and is off by default.

    Uses a centred window - this is diagnostic output, not a model feature, and
    is excluded from :data:`FEATURE_COLUMNS`.

    Scope note: this detects **point** outliers, not structural breaks. Of the
    four injected anomalies it flags only the transient spike. That is correct
    behaviour, not a miss - after a permanent level shift the new level becomes
    the local median, so a point-outlier test has nothing left to see. Detecting
    permanent breaks is a different problem (a level-shift test), deliberately
    out of scope here; the models' robustness to those breaks is measured
    instead by the anomaly-vs-normal metric split in :mod:`evaluation`.
    """
    prep = config.preprocessing
    window = prep.outlier_window

    def _score(series: pd.Series) -> pd.Series:
        median = series.rolling(window, center=True, min_periods=3).median()
        deviation = (series - median).abs()
        mad = deviation.rolling(window, center=True, min_periods=3).median()
        # 1.4826 rescales MAD to a standard-deviation equivalent for normal data.
        scaled = 1.4826 * mad
        # Floor the scale at a small fraction of the local price level. On a
        # smooth series the local MAD collapses toward zero, which inflates the
        # z-score and flags ordinary month-to-month wiggle as anomalous. The
        # floor means "a deviation must also be economically meaningful", not
        # merely large relative to an unusually quiet window.
        floor = prep.outlier_min_scale_frac * median.abs()
        scaled = np.maximum(scaled, floor)
        return (series - median).abs() / scaled.replace(0.0, np.nan)

    panel["outlier_score"] = panel.groupby("part_id", sort=False)["price"].transform(_score)
    panel["outlier_flag"] = panel["outlier_score"] > prep.outlier_mad_threshold
    panel["outlier_flag"] = panel["outlier_flag"].fillna(False)
    report.n_outliers_flagged = int(panel["outlier_flag"].sum())

    logger.info(
        "flagged %d outlier observation(s) at MAD z > %.1f (%.2f%% of panel); "
        "winsorize=%s",
        report.n_outliers_flagged,
        prep.outlier_mad_threshold,
        100.0 * report.n_outliers_flagged / max(len(panel), 1),
        prep.winsorize_outliers,
    )

    if prep.winsorize_outliers:
        median = panel.groupby("part_id", sort=False)["price"].transform(
            lambda s: s.rolling(window, center=True, min_periods=3).median()
        )
        panel.loc[panel["outlier_flag"], "price"] = median[panel["outlier_flag"]]
        logger.warning(
            "winsorize_outliers=true: %d flagged point(s) replaced by local median. "
            "This suppresses the injected structural breaks.",
            report.n_outliers_flagged,
        )

    return panel.drop(columns=["outlier_score"])


def _flag_insufficient_history(
    panel: pd.DataFrame, config: Config, report: PreprocessingReport
) -> pd.DataFrame:
    """Mark parts with too few observations to model individually.

    These are not dropped. They stay in the panel and are routed to a
    category-median fallback forecaster in :mod:`modeling`, because in
    production a new part still needs a number attached to it.
    """
    counts = panel.dropna(subset=["price"]).groupby("part_id")["price"].count()
    thin = counts[counts < config.preprocessing.min_history_months]
    report.insufficient_history_parts = sorted(thin.index.tolist())

    panel["insufficient_history"] = panel["part_id"].isin(report.insufficient_history_parts)

    if len(thin):
        logger.warning(
            "%d part(s) have fewer than %d observations and will use the "
            "category-median fallback forecaster: %s",
            len(thin),
            config.preprocessing.min_history_months,
            ", ".join(thin.index[:5].tolist()) + ("..." if len(thin) > 5 else ""),
        )
    else:
        logger.info(
            "all %d parts meet the %d-month minimum history requirement",
            panel["part_id"].nunique(),
            config.preprocessing.min_history_months,
        )
    return panel


# --------------------------------------------------------------------------- #
# Feature engineering
# --------------------------------------------------------------------------- #


def _expanding_hierarchy_encoding(
    frame: pd.DataFrame, keys: Sequence[str], value_column: str
) -> pd.Series:
    """Mean log-price for a hierarchy group, using only *earlier* months.

    Target encoding is the standard way to give a tree model a numeric handle on
    a high-cardinality group, but the naive version - encoding each row with its
    own group's overall mean - leaks the target straight into the features.

    This uses an **expanding window shifted by one month**: the encoding for a
    group in month *t* is the mean over that group across every month strictly
    before *t*. A row can never influence its own encoding, and no future month
    can influence a past one. Groups get NaN until they have history, which the
    model handles natively rather than being papered over with a global mean.
    """
    monthly = (
        frame.groupby(list(keys) + ["month"], observed=True)[value_column]
        .mean()
        .reset_index()
        .sort_values("month")
    )
    monthly["encoding"] = (
        monthly.groupby(list(keys), observed=True)[value_column]
        .transform(lambda s: s.expanding().mean().shift(1))
    )
    merged = frame[list(keys) + ["month"]].merge(
        monthly[list(keys) + ["month", "encoding"]],
        on=list(keys) + ["month"],
        how="left",
    )
    return merged["encoding"].to_numpy()


def _add_hierarchy_features(frame: pd.DataFrame, report: PreprocessingReport) -> pd.DataFrame:
    """Attach leak-free target encodings at each level of the hierarchy.

    Gives the model an explicit numeric signal for "what does this vendor
    normally charge", "what does this category normally cost on this programme",
    and so on, without which it would have to rediscover the whole hierarchy
    from raw categorical splits.
    """
    frame = frame.copy()
    frame["_log_price"] = np.log(frame["price"].where(frame["price"] > 0))

    added: List[str] = []
    for keys in HIERARCHY_LEVELS:
        if not all(key in frame.columns for key in keys):
            continue
        name = "hier_" + "_".join(k.replace("_code", "") for k in keys) + "_logprice"
        frame[name] = _expanding_hierarchy_encoding(frame, keys, "_log_price")
        added.append(name)

    # Where does this part sit inside its own category? A part priced well above
    # its category norm behaves differently from one at the bottom of the range.
    if "hier_category_logprice" in frame.columns:
        frame["hier_part_vs_category"] = (
            frame["_log_price"] - frame["hier_category_logprice"]
        )
        added.append("hier_part_vs_category")
    if "hier_vendor_logprice" in frame.columns:
        frame["hier_part_vs_vendor"] = (
            frame["_log_price"] - frame["hier_vendor_logprice"]
        )
        added.append("hier_part_vs_vendor")

    frame = frame.drop(columns=["_log_price"])
    report.hierarchy_features = added
    logger.info(
        "added %d leak-free hierarchy encoding(s) across %d level(s)",
        len(added),
        len(HIERARCHY_LEVELS),
    )
    return frame


def _add_fx_features(
    frame: pd.DataFrame, config: Config, fx: Dict[str, "FxSeries"], report: PreprocessingReport
) -> pd.DataFrame:
    """Attach FX levels, returns and lags.

    The rate for month *t* is public and known at purchase time, so using it
    contemporaneously is legitimate - unlike the price, it is not something we
    are trying to predict.

    Lags matter more than the level here. Pass-through is delayed by contract
    repricing cadence and inventory buffers, so the FX move that explains this
    month's price happened two to four months ago. Supplying an explicit ladder
    of lagged returns lets the model find that delay per category rather than
    being told it.
    """
    frame = frame.copy()
    added: List[str] = []

    # Exposure weights from vendor and project master data. These are things a
    # purchasing team genuinely knows - what share of a vendor's input cost is
    # imported, and how localised a programme is - not generative ground truth.
    import_dependency = (
        frame["vendor_import_dependency"]
        if "vendor_import_dependency" in frame.columns
        else pd.Series(0.5, index=frame.index)
    )
    import_content = (
        1.0 - frame["project_localisation"]
        if "project_localisation" in frame.columns
        else pd.Series(0.5, index=frame.index)
    )

    for pair, series in fx.items():
        key = pair.lower()
        log_rate = np.log(series.values)

        # NOTE: the FX *level* is deliberately not a feature.
        #
        # Over this window both rates rose almost monotonically, making the
        # level a near-perfect proxy for elapsed time. A tree offered both will
        # split on the trend and ignore FX, and a shocked level lands outside
        # the training range where trees are flat - so counterfactual scenarios
        # come back incoherent. Only stationary transforms are exposed.
        for periods in config.preprocessing.fx_return_periods:
            mapped = frame["month"].map(log_rate.diff(periods))
            frame[f"fx_{key}_ret_{periods}m"] = mapped
            added.append(f"fx_{key}_ret_{periods}m")

        # Lagged *returns*, not cumulative levels.
        #
        # Measured on this window, a cumulative FX path correlates 0.90 with
        # elapsed time and 0.93 with the other currency - it is a trend proxy,
        # and a model given it will re-learn the trend and call it FX. Monthly
        # returns between the two currencies correlate only 0.12, so that is
        # where the independent variation lives. Only returns are exposed.
        monthly_return = log_rate.diff(1)
        for lag in config.preprocessing.fx_lags:
            lagged = frame["month"].map(monthly_return.shift(lag))
            frame[f"fx_{key}_ret_lag{lag}"] = lagged
            added.append(f"fx_{key}_ret_lag{lag}")

            # Cross-sectional identification: in a single month, a high-import
            # vendor's prices must respond more to the same FX move than a
            # low-import vendor's. That contrast is not confounded with time,
            # because it compares parts within the same month.
            frame[f"fx_{key}_ret_lag{lag}_x_import"] = lagged * import_dependency
            added.append(f"fx_{key}_ret_lag{lag}_x_import")

            frame[f"fx_{key}_ret_lag{lag}_x_content"] = lagged * import_content
            added.append(f"fx_{key}_ret_lag{lag}_x_content")

    report.fx_features = added
    logger.info(
        "added %d FX feature(s) across %d pair(s): %s-month returns, lags %s, "
        "and vendor/project exposure interactions (levels excluded - collinear "
        "with trend and unusable for counterfactuals)",
        len(added),
        len(fx),
        config.preprocessing.fx_return_periods,
        config.preprocessing.fx_lags,
    )
    return frame


def _add_geo_features(
    frame: pd.DataFrame,
    config: Config,
    geo: GeoBundle,
    report: PreprocessingReport,
) -> pd.DataFrame:
    """Attach commodity, freight, GPR, chokepoint and event features.

    Same identification discipline as FX: expose stationary returns and lags,
    never raw levels that track time. Cross-sectional interactions with import
    dependency and material intensity provide within-month contrast.

    ``feature_mode=sparse`` (default) keeps only the identifying interactions
    and a short lag set. It matches the full lag ladder on holdout MAPE with
    roughly a quarter of the columns, so the extra lags buy nothing beyond
    making individual contributions unreadable.
    """
    frame = frame.copy()
    added: List[str] = []
    geo_cfg = config.geo
    sparse = geo_cfg.feature_mode == "sparse"
    lags = geo_cfg.mediator_lags if not sparse else list(geo_cfg.mediator_lags)[:2]
    ret_periods = (
        geo_cfg.mediator_return_periods
        if not sparse
        else list(geo_cfg.mediator_return_periods)[:1]
    )
    gpr_lags = geo_cfg.gpr_lags if not sparse else [0, 1]

    import_dependency = (
        frame["vendor_import_dependency"]
        if "vendor_import_dependency" in frame.columns
        else pd.Series(0.5, index=frame.index)
    )
    material_intensity = material_intensity_series(frame)
    frame["material_intensity"] = material_intensity
    added.append("material_intensity")

    # --- Commodities: prefer matched channel + material interaction ----------
    for name, series in geo.commodities.items():
        log_level = np.log(series.values.clip(lower=1e-9))
        monthly_return = log_level.diff(1)
        if not sparse:
            for periods in ret_periods:
                mapped = frame["month"].map(log_level.diff(periods))
                col = f"cmd_{name}_ret_{periods}m"
                frame[col] = mapped
                added.append(col)
            for lag in lags:
                lagged = frame["month"].map(monthly_return.shift(lag))
                col = f"cmd_{name}_ret_lag{lag}"
                frame[col] = lagged
                added.append(col)
                inter = f"cmd_{name}_ret_lag{lag}_x_mat"
                frame[inter] = lagged * material_intensity
                added.append(inter)
        else:
            # One contemporaneous return for mediation diagnostics
            if name == "steel":
                col = f"cmd_{name}_ret_1m"
                frame[col] = frame["month"].map(log_level.diff(1))
                added.append(col)
            for lag in lags:
                lagged = frame["month"].map(monthly_return.shift(lag))
                inter = f"cmd_{name}_ret_lag{lag}_x_mat"
                frame[inter] = lagged * material_intensity
                added.append(inter)

    cmd_key = commodity_key_for_row(frame)
    frame["commodity_key"] = cmd_key
    matched = pd.Series(0.0, index=frame.index)
    for name, series in geo.commodities.items():
        mask = cmd_key == name
        if not mask.any():
            continue
        ret1 = frame["month"].map(
            np.log(series.values.clip(lower=1e-9)).diff(1).shift(int(lags[0]))
        )
        matched = matched.where(~mask, ret1.fillna(0.0))
    frame["cmd_matched_ret_lag2"] = matched
    frame["cmd_matched_ret_lag2_x_mat"] = matched * material_intensity
    added.extend(["cmd_matched_ret_lag2", "cmd_matched_ret_lag2_x_mat"])

    # --- Freight: returns + import interactions (identification) ------------
    freight_log = np.log(geo.freight.values.clip(lower=1e-9))
    freight_ret = freight_log.diff(1)
    frame["freight_ret_1m"] = frame["month"].map(freight_ret)
    added.append("freight_ret_1m")
    for lag in lags:
        lagged = frame["month"].map(freight_ret.shift(lag))
        if not sparse:
            col = f"freight_ret_lag{lag}"
            frame[col] = lagged
            added.append(col)
        inter = f"freight_ret_lag{lag}_x_import"
        frame[inter] = lagged * import_dependency
        added.append(inter)

    # --- GPR: overall only in sparse mode (threat/act add collinearity) -----
    gpr_keys = ("overall",) if sparse else tuple(geo.gpr.keys())
    for key in gpr_keys:
        series = geo.gpr[key]
        prefix = "gpr" if key == "overall" else f"gpr_{key}"
        z = _causal_expanding_zscore(series.values)
        for lag in gpr_lags:
            lagged = frame["month"].map(z.shift(lag) if lag else z)
            col = f"{prefix}_z_lag{lag}"
            frame[col] = lagged
            added.append(col)
            if not sparse or lag == 0:
                inter = f"{prefix}_z_lag{lag}_x_import"
                frame[inter] = lagged * import_dependency
                added.append(inter)

    # --- Chokepoint: single intensity + import interaction ------------------
    choke = geo.chokepoint.values
    choke_lags = (0, 1) if sparse else (0, 1, 2)
    for lag in choke_lags:
        lagged = frame["month"].map(choke.shift(lag) if lag else choke)
        if not sparse or lag == 0:
            col = f"chokepoint_lag{lag}"
            frame[col] = lagged
            added.append(col)
        inter = f"chokepoint_lag{lag}_x_import"
        frame[inter] = lagged * import_dependency
        added.append(inter)

    # --- Event calendar: decays + tariff step (skip redundant severity dummies)
    event_frame = event_monthly_features(
        geo.events,
        pd.DatetimeIndex(sorted(frame["month"].unique())),
        decay_half_life=geo_cfg.event_decay_half_life_months,
    )
    keep_events = {
        "geo_event_any",
        "geo_event_tariff",
        "geo_event_chokepoint",
        "geo_event_conflict_decay",
        "geo_event_tariff_decay",
        "geo_event_chokepoint_decay",
    }
    if not sparse:
        keep_events = {c for c in event_frame.columns if c != "month"}

    frame = frame.merge(event_frame, on="month", how="left")
    for col in event_frame.columns:
        if col == "month":
            continue
        frame[col] = frame[col].fillna(0.0)
        if col not in keep_events:
            continue
        added.append(col)
        if col.endswith("_decay") or col in ("geo_event_tariff", "geo_event_chokepoint"):
            inter = f"{col}_x_import"
            frame[inter] = frame[col] * import_dependency
            added.append(inter)

    if sparse:
        allowed_events = _allowed_event_columns("sparse")
        drop_cols = [
            col
            for col in frame.columns
            if col.startswith("geo_event_") and col not in allowed_events
        ]
        if drop_cols:
            frame = frame.drop(columns=drop_cols)

    report.geo_features = added
    logger.info(
        "added %d geo/mediator feature(s) (mode=%s): commodities, freight, GPR, "
        "chokepoint, event calendar (+ exposure interactions)",
        len(added),
        geo_cfg.feature_mode,
    )
    return frame


def build_features(
    panel: pd.DataFrame,
    config: Config,
    macro: MacroSeries,
    report: PreprocessingReport,
    fx: Optional[Dict[str, "FxSeries"]] = None,
    geo: Optional[GeoBundle] = None,
) -> pd.DataFrame:
    """Attach model features to the cleaned panel.

    Every feature is computed as of month *t* using only months <= *t*. The
    model rows are later paired with targets at *t+h* by :mod:`modeling`, so no
    shifting of the target happens here.

    Args:
        panel: Cleaned panel from :func:`clean_panel`.
        config: Pipeline configuration.
        macro: Macro index, joined on month as an exogenous regressor.
        report: Mutated in place with the resolved feature list.

    Returns:
        The panel with feature columns appended.
    """
    prep = config.preprocessing
    frame = panel.sort_values(["part_id", "month"]).reset_index(drop=True).copy()
    price_by_part = frame.groupby("part_id", sort=False)["price"]

    # --- Lagged levels. lag_0 is the current price, which IS known at t. -----
    for lag in prep.lags:
        frame[f"price_lag_{lag}"] = price_by_part.shift(lag)

    # --- Trailing rolling statistics, inclusive of t ------------------------
    for window in prep.rolling_windows:
        frame[f"price_roll_mean_{window}"] = price_by_part.transform(
            lambda s, w=window: s.rolling(w, min_periods=2).mean()
        )
        frame[f"price_roll_std_{window}"] = price_by_part.transform(
            lambda s, w=window: s.rolling(w, min_periods=2).std()
        )

    # --- Growth rates --------------------------------------------------------
    frame["price_mom_pct"] = price_by_part.pct_change(1)
    frame["price_yoy_pct"] = price_by_part.pct_change(12)

    # --- Level context: where this part sits relative to its own history -----
    frame["price_expanding_mean"] = price_by_part.transform(
        lambda s: s.expanding(min_periods=2).mean()
    )
    frame["price_vs_expanding_mean"] = frame["price"] / frame["price_expanding_mean"]

    # --- Calendar. Sine/cosine keeps December adjacent to January. ----------
    month_num = frame["month"].dt.month
    frame["month_sin"] = np.sin(2 * np.pi * month_num / 12.0)
    frame["month_cos"] = np.cos(2 * np.pi * month_num / 12.0)
    frame["month_of_year"] = month_num.astype(int)

    origin = frame["month"].min()
    frame["months_since_start"] = (
        (frame["month"].dt.year - origin.year) * 12
        + (frame["month"].dt.month - origin.month)
    ).astype(int)

    # --- Macro anchor as exogenous regressor --------------------------------
    # Assumption stated plainly: BLS publishes with a ~2 week lag, so the index
    # for month t is treated as known at the end of month t. For monthly
    # forecasting that is a fair approximation; a stricter setup would lag it.
    macro_frame = macro.normalized().rename("macro_index").reset_index()
    macro_frame.columns = ["month", "macro_index"]
    macro_frame["macro_mom_pct"] = macro_frame["macro_index"].pct_change(1)
    macro_frame["macro_yoy_pct"] = macro_frame["macro_index"].pct_change(12)
    frame = frame.merge(macro_frame, on="month", how="left")

    # --- Foreign exchange ---------------------------------------------------
    if fx:
        frame = _add_fx_features(frame, config, fx, report)

    # --- Geopolitical mediators & event calendar ----------------------------
    if geo is not None and config.geo.enabled:
        frame = _add_geo_features(frame, config, geo, report)

    # --- Hierarchy: project / vendor / category encodings -------------------
    frame = _add_hierarchy_features(frame, report)

    # --- Categoricals. XGBoost consumes pandas 'category' dtype natively. ---
    for column in CATEGORICAL_COLUMNS:
        if column in frame.columns:
            frame[column] = frame[column].astype("category")

    # Free-text duplicates of the coded dimensions add cardinality without
    # information, so keep the codes and drop the labels from the feature set.
    feature_columns = _resolved_feature_columns(frame, config)
    report.feature_columns = feature_columns

    logger.info(
        "engineered %d features across %d rows (%d numeric, %d categorical)",
        len(feature_columns),
        len(frame),
        len(feature_columns) - len(CATEGORICAL_COLUMNS),
        len(CATEGORICAL_COLUMNS),
    )
    return frame


def _is_raw_fx_level(column: str) -> bool:
    """True for a bare FX rate column such as ``fx_eurinr``.

    The panel carries the rate prevailing at purchase time because that belongs
    in the data record, but the *level* must never reach the model: it
    correlates ~0.9 with elapsed time on this window, so it acts as a trend
    proxy, and a shocked level falls outside the training range where trees are
    flat. Only the stationary transforms (``fx_*_ret_*``) are features.
    """
    return column.startswith("fx_") and "ret" not in column


def get_feature_columns(frame: pd.DataFrame) -> List[str]:
    """Return the model-input columns present on a feature frame.

    Excludes identifiers, the target, the generative ``true_*`` FX betas, and
    raw FX levels - see :data:`NON_FEATURE_COLUMNS` and :func:`_is_raw_fx_level`.
    """
    return _resolved_feature_columns(frame)


def save_features(config: Config, frame: pd.DataFrame) -> Path:
    """Persist the engineered feature frame to ``data/processed``."""
    config.paths.data_processed.mkdir(parents=True, exist_ok=True)
    out_path = config.paths.data_processed / "features.parquet"
    try:
        frame.to_parquet(out_path, index=False)
    except (ImportError, ValueError) as exc:
        # pyarrow is not a hard requirement for this POC; CSV round-trips fine
        # at this scale, just larger.
        out_path = config.paths.data_processed / "features.csv"
        frame.to_csv(out_path, index=False)
        logger.info("parquet unavailable (%s); wrote CSV instead", exc)
    logger.info("wrote features to %s", out_path)
    return out_path
