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
    }
)

# Hierarchy dimensions plus part characteristics. XGBoost consumes pandas
# 'category' dtype natively, so no one-hot expansion is needed.
CATEGORICAL_COLUMNS = (
    "project_code", "vendor_code", "category_code",
    "oem", "segment", "vendor_origin", "material", "complexity_tier",
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


def build_features(
    panel: pd.DataFrame,
    config: Config,
    macro: MacroSeries,
    report: PreprocessingReport,
    fx: Optional[Dict[str, "FxSeries"]] = None,
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

    # --- Hierarchy: project / vendor / category encodings -------------------
    frame = _add_hierarchy_features(frame, report)

    # --- Categoricals. XGBoost consumes pandas 'category' dtype natively. ---
    for column in CATEGORICAL_COLUMNS:
        if column in frame.columns:
            frame[column] = frame[column].astype("category")

    # Free-text duplicates of the coded dimensions add cardinality without
    # information, so keep the codes and drop the labels from the feature set.
    label_columns = {"project", "vendor", "category"}
    feature_columns = [
        col
        for col in frame.columns
        if col not in NON_FEATURE_COLUMNS
        and col not in label_columns
        and col not in ("macro_index_month",)
        and not _is_raw_fx_level(col)
    ]
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
    label_columns = {"project", "vendor", "category"}
    return [
        col
        for col in frame.columns
        if col not in NON_FEATURE_COLUMNS
        and col not in label_columns
        and not _is_raw_fx_level(col)
    ]


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
