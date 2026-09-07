"""POC-scale correctness tests.

Not an exhaustive suite. These cover the failure modes that would silently
invalidate results rather than raise: feature leakage, non-reproducibility,
wrong metric maths, and training on data the model should not have seen.
"""

from __future__ import annotations

import dataclasses
import json

import numpy as np
import pandas as pd
import pytest

from price_forecasting.config import ConfigError, load_config
from price_forecasting.data_generation import generate_price_panel
from price_forecasting.data_sourcing import MacroSeries
from price_forecasting.evaluation import (
    compute_metrics,
    mean_absolute_error,
    mean_absolute_percentage_error,
    root_mean_squared_error,
)
from price_forecasting.feature_selection import selection_train_end, select_features
from price_forecasting.geopolitical import GeoBundle, MediatorSeries, causal_expanding_zscore
from price_forecasting.modeling import (
    PLAUSIBLE_RATIO_BOUNDS,
    _assert_plausible,
    build_supervised_frame,
    seasonal_naive_forecast,
    split_by_time,
)
from price_forecasting.preprocessing import (
    PreprocessingReport,
    build_features,
    clean_panel,
    get_feature_columns,
)

CONFIG_PATH = "config.yaml"


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def config():
    """Small config so the suite runs fast."""
    cfg = load_config(CONFIG_PATH)
    # Enough parts for the catalogue rotation to reach every project and
    # category at least once; below that the hierarchy assertions have nothing
    # to compare.
    object.__setattr__(cfg.generation, "n_parts", 120)
    object.__setattr__(cfg.modeling.sarima, "max_parts", 3)
    return cfg


@pytest.fixture(scope="module")
def fx_rates(config, macro):
    """Deterministic offline FX pair set - keeps the suite off the network."""
    from price_forecasting.fx import FxSeries

    months = macro.values.index
    rng = np.random.default_rng(7)
    out = {}
    for spec, start in zip(config.fx.pairs, (90.0, 83.0)):
        pair = f"{spec['base']}{spec['quote']}"
        steps = rng.normal(0.002, 0.012, size=len(months))
        steps[0] = 0.0
        out[pair] = FxSeries(
            values=pd.Series(start * np.exp(np.cumsum(steps)), index=months, name=pair),
            pair=pair,
            base=spec["base"],
            quote=spec["quote"],
            source="offline-fallback",
            observed_start=months[0],
            extrapolated_months=0,
        )
    return out


@pytest.fixture(scope="module")
def macro(config):
    """Deterministic offline macro anchor - keeps tests off the network."""
    months = pd.date_range(
        end=pd.Timestamp(config.generation.end_month + "-01"),
        periods=config.generation.history_months,
        freq="MS",
    )
    values = 100.0 * (1.0025 ** np.arange(len(months)))
    return MacroSeries(
        values=pd.Series(values, index=months, name="test-anchor"),
        series_id="test-anchor",
        source="offline-fallback",
        observed_start=None,
        extrapolated_months=0,
    )


@pytest.fixture(scope="module")
def panel(config, macro, fx_rates):
    return generate_price_panel(config, macro, fx_rates)


@pytest.fixture(scope="module")
def features(config, macro, panel, fx_rates):
    report = PreprocessingReport()
    cleaned = clean_panel(panel, config, report)
    return build_features(cleaned, config, macro, report, fx=fx_rates)


# --------------------------------------------------------------------------- #
# Generation
# --------------------------------------------------------------------------- #


def test_generation_is_deterministic(config, macro, fx_rates):
    """Same seed must reproduce the panel exactly, or nothing is reproducible."""
    first = generate_price_panel(config, macro, fx_rates)
    second = generate_price_panel(config, macro, fx_rates)
    pd.testing.assert_frame_equal(first, second)


def test_generated_prices_are_positive(panel):
    """A negative or zero price is nonsense and would break MAPE."""
    observed = panel["price"].dropna()
    assert (observed > 0).all()


def test_panel_shape_and_anomalies(config, panel):
    assert panel["part_id"].nunique() == config.generation.n_parts
    assert panel.groupby("part_id")["month"].count().nunique() == 1

    anomaly_parts = panel.loc[panel["is_anomaly_part"], "part_id"].nunique()
    assert anomaly_parts == config.generation.n_anomaly_parts

    types = set(panel.loc[panel["is_anomaly_part"], "anomaly_type"].unique())
    assert len(types) == config.generation.n_anomaly_parts, "breaks must be distinct"


def test_structural_break_actually_shifts_the_level(panel):
    """A break that does not move the series would not test robustness."""
    level_shift = panel[panel["anomaly_type"] == "tariff_step"]
    assert not level_shift.empty

    series = level_shift.sort_values("month")["price"].dropna().to_numpy()
    midpoint = len(series) // 2
    before = series[:midpoint].mean()
    after = series[midpoint:].mean()
    assert after / before > 1.08, "tariff step should raise the mean by >8%"


def test_seasonality_peaks_in_the_right_month(config, macro, fx_rates):
    """Electrical parts must peak in winter, or the seasonal signal is wrong."""
    panel = generate_price_panel(config, macro, fx_rates)
    electrical = panel[panel["category"] == "Electrical"].copy()
    electrical["m"] = electrical["month"].dt.month

    # Detrend by part so the macro trend does not swamp the seasonal shape.
    electrical["relative"] = electrical.groupby("part_id")["price"].transform(
        lambda s: s / s.mean()
    )
    by_month = electrical.groupby("m")["relative"].mean()
    assert by_month.idxmax() in (12, 1, 2), f"peak was month {by_month.idxmax()}"


# --------------------------------------------------------------------------- #
# Preprocessing - the leakage guarantee
# --------------------------------------------------------------------------- #


def test_features_do_not_leak_the_future(config, macro, panel):
    """Perturbing the final month must not change any earlier feature row.

    This is the single most important test here. A leak produces excellent
    metrics that evaporate in production, and it is invisible without an
    explicit check like this one.
    """
    report_a = PreprocessingReport()
    baseline = build_features(clean_panel(panel, config, report_a), config, macro, report_a)

    last_month = panel["month"].max()
    perturbed_panel = panel.copy()
    mask = perturbed_panel["month"] == last_month
    perturbed_panel.loc[mask, "price"] = perturbed_panel.loc[mask, "price"] * 99.0

    report_b = PreprocessingReport()
    perturbed = build_features(
        clean_panel(perturbed_panel, config, report_b), config, macro, report_b
    )

    feature_columns = get_feature_columns(baseline)
    earlier = baseline["month"] < last_month

    left = baseline.loc[earlier, feature_columns].select_dtypes(include=[np.number])
    right = perturbed.loc[earlier, feature_columns].select_dtypes(include=[np.number])

    pd.testing.assert_frame_equal(
        left.reset_index(drop=True),
        right.reset_index(drop=True),
        check_exact=False,
        rtol=1e-9,
    )


def test_perturbing_a_middle_month_does_not_change_earlier_rows(config, macro, panel):
    """Stronger form of the leakage check, targeting backward-fill.

    Perturbing the *final* month cannot expose a backward-fill leak, because
    nothing follows it to fill from. An interior month can. This caught a real
    bug where an unrestricted ``bfill`` patched the trailing edge of interior
    gaps using the following month's price.
    """
    months = pd.DatetimeIndex(sorted(panel["month"].unique()))
    pivot = months[len(months) // 2]

    report_a = PreprocessingReport()
    baseline = build_features(clean_panel(panel, config, report_a), config, macro, report_a)

    perturbed_panel = panel.copy()
    mask = perturbed_panel["month"] >= pivot
    perturbed_panel.loc[mask, "price"] = perturbed_panel.loc[mask, "price"] * 77.0

    report_b = PreprocessingReport()
    perturbed = build_features(
        clean_panel(perturbed_panel, config, report_b), config, macro, report_b
    )

    feature_columns = get_feature_columns(baseline)
    earlier = baseline["month"] < pivot

    left = baseline.loc[earlier, feature_columns].select_dtypes(include=[np.number])
    right = perturbed.loc[earlier, feature_columns].select_dtypes(include=[np.number])

    pd.testing.assert_frame_equal(
        left.reset_index(drop=True),
        right.reset_index(drop=True),
        check_exact=False,
        rtol=1e-9,
    )


def test_short_gaps_are_filled_long_gaps_are_not(config, macro):
    """Forward-fill must respect its gap limit rather than smearing indefinitely."""
    months = pd.date_range("2024-01-01", periods=12, freq="MS")
    frame = pd.DataFrame(
        {
            "part_id": "TST-00001",
            "part_name": "Test Part",
            "component": "Oil Filter",
            "category": "filters",
            "brand": "Bosch",
            "platform": "Corolla 1.8L",
            "spec": "OE",
            "month": months,
            "price": [10.0, 11.0, np.nan, np.nan, np.nan, np.nan, 12.0, 12.5, 13.0, 13.5, 14.0, 14.5],
            "is_anomaly_part": False,
            "anomaly_type": "",
        }
    )
    report = PreprocessingReport()
    cleaned = clean_panel(frame, config, report)

    # Gap limit is 2, so months 3-4 fill and months 5-6 stay missing.
    assert cleaned["price"].isna().sum() == 4 - config.preprocessing.max_ffill_gap
    assert report.n_imputed == config.preprocessing.max_ffill_gap


def test_generative_fx_betas_are_never_features(features):
    """The true betas are the answer key, not an input.

    They are the coefficients the generator used to build prices. Feeding them
    to the model would make FX recovery trivially perfect and completely
    meaningless.
    """
    feature_columns = get_feature_columns(features)
    leaked = [c for c in feature_columns if c.startswith("true_")]
    assert leaked == [], f"generative ground truth leaked into features: {leaked}"


def test_fx_levels_are_excluded_from_features(features):
    """Only stationary FX transforms may be exposed.

    A cumulative FX path correlates ~0.9 with elapsed time on this window, so a
    level feature is a trend proxy - the model would re-learn the trend and
    attribute it to FX, and a shocked level lands outside the training range
    where trees are flat.
    """
    feature_columns = get_feature_columns(features)
    fx_columns = [c for c in feature_columns if c.startswith("fx_")]
    assert fx_columns, "expected FX features to be present"

    # Every FX feature must be a return or an interaction built on one.
    for column in fx_columns:
        assert "ret" in column, f"non-stationary FX feature exposed: {column}"

    # And the bare level columns must be gone entirely.
    assert "fx_eurinr" not in feature_columns
    assert "fx_usdinr" not in feature_columns


def test_hierarchy_encoding_uses_only_past_months(features):
    """A hierarchy encoding must never include its own month.

    Expanding target encoding is only leak-free if it is shifted. Verified
    directly: the encoding for a group in month t must equal the mean of that
    group over months strictly before t.
    """
    frame = features.sort_values("month")
    months = pd.DatetimeIndex(sorted(frame["month"].unique()))

    # First month has no prior history, so every encoding must be undefined.
    first = frame[frame["month"] == months[0]]
    assert first["hier_vendor_logprice"].isna().all()

    # Recompute one group's encoding by hand at a later month.
    target_month = months[5]
    vendor = frame["vendor_code"].iloc[0]
    prior = frame[(frame["vendor_code"] == vendor) & (frame["month"] < target_month)]
    monthly_means = np.log(prior["price"].where(prior["price"] > 0)).groupby(
        prior["month"]
    ).mean()
    expected = float(monthly_means.mean())

    actual = frame[
        (frame["vendor_code"] == vendor) & (frame["month"] == target_month)
    ]["hier_vendor_logprice"].iloc[0]
    assert actual == pytest.approx(expected, rel=1e-6)


def test_fx_exposure_differentiates_the_hierarchy(panel):
    """Each dimension must carry distinct FX exposure, or it is decoration.

    Import-heavy categories must out-expose steel ones on the direct channel;
    international vendors must out-expose domestic ones; and a CKD programme
    must out-expose a localised one.
    """
    by_category = panel.groupby("category")["true_eur_beta"].mean()
    assert by_category["Sensors"] > by_category["Fasteners"] * 5, (
        "semiconductor categories should carry far more direct FX exposure "
        "than domestically-sourced steel"
    )

    by_origin = panel.groupby("vendor_origin")["true_eur_beta"].mean()
    assert by_origin["international"] > by_origin["domestic"] * 2

    by_project = panel.groupby("project_localisation")["true_eur_beta"].mean()
    least_localised = by_project.index.min()
    most_localised = by_project.index.max()
    assert by_project[least_localised] > by_project[most_localised], (
        "a CKD programme should be more FX-exposed than a localised one"
    )


def test_commodity_channel_survives_localisation(panel):
    """Localisation must not zero out commodity exposure.

    Steel is priced off a USD benchmark even when bought domestically, so a
    fully-localised fastener stays exposed. Collapsing both channels into one
    elasticity would wrongly show it protected.
    """
    fasteners = panel[panel["category"] == "Fasteners"]
    assert fasteners["true_eur_beta"].mean() < 0.01, "fasteners are not import-invoiced"
    assert fasteners["true_usd_beta"].mean() > 0.10, (
        "fasteners must remain exposed to USD-benchmarked steel despite "
        "being locally sourced"
    )


def test_outlier_flag_is_not_a_model_feature(features):
    """Outlier detection uses a centred window, so it must never be a feature."""
    assert "outlier_flag" not in get_feature_columns(features)
    assert "is_anomaly_part" not in get_feature_columns(features)
    assert "anomaly_type" not in get_feature_columns(features)
    assert "price" not in get_feature_columns(features)


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #


def test_metrics_match_hand_computed_values():
    actual = np.array([100.0, 200.0, 300.0])
    predicted = np.array([110.0, 190.0, 330.0])

    # errors: -10, +10, -30 -> MAE = 50/3
    assert mean_absolute_error(actual, predicted) == pytest.approx(50.0 / 3.0)
    # squared: 100, 100, 900 -> RMSE = sqrt(1100/3)
    assert root_mean_squared_error(actual, predicted) == pytest.approx(
        np.sqrt(1100.0 / 3.0)
    )
    # pct: 10%, 5%, 10% -> MAPE = 25/3
    assert mean_absolute_percentage_error(actual, predicted) == pytest.approx(25.0 / 3.0)


def test_perfect_prediction_scores_zero():
    values = np.array([5.0, 10.0, 15.0])
    assert mean_absolute_error(values, values) == 0.0
    assert root_mean_squared_error(values, values) == 0.0
    assert mean_absolute_percentage_error(values, values) == 0.0


def test_compute_metrics_ignores_missing_rows():
    frame = pd.DataFrame(
        {"actual": [10.0, 20.0, np.nan], "prediction": [11.0, 21.0, 30.0]}
    )
    result = compute_metrics(frame)
    assert result["n"] == 2
    assert result["mae"] == pytest.approx(1.0)


# --------------------------------------------------------------------------- #
# Modeling
# --------------------------------------------------------------------------- #


def test_supervised_target_looks_forward_by_exactly_h(features):
    """The target must be built from the price exactly h months ahead.

    Checked under both formulations: ``level`` targets the future price
    directly, ``log_return`` targets its log ratio to the current price. Both
    must reference the same future observation.
    """
    horizon = 3

    levels = build_supervised_frame(features, horizon, target_mode="level")
    part_id = levels["part_id"].iloc[0]
    part = levels[levels["part_id"] == part_id].sort_values("month")

    expected = part["price"].shift(-horizon).to_numpy()
    np.testing.assert_allclose(
        part["target"].to_numpy(), expected, equal_nan=True, rtol=1e-12
    )
    np.testing.assert_allclose(
        part["future_price"].to_numpy(), expected, equal_nan=True, rtol=1e-12
    )

    returns = build_supervised_frame(features, horizon, target_mode="log_return")
    rpart = returns[returns["part_id"] == part_id].sort_values("month")
    expected_return = np.log(rpart["price"].shift(-horizon) / rpart["price"]).to_numpy()
    np.testing.assert_allclose(
        rpart["target"].to_numpy(), expected_return, equal_nan=True, rtol=1e-12
    )

    # Targets near the end of the series must be NaN, never filled.
    assert part["target"].tail(horizon).isna().all()
    assert rpart["target"].tail(horizon).isna().all()


def test_log_return_target_is_stationary_and_centred(features):
    """The log-return target must sit near zero, unlike the price level.

    This is the whole reason for the reformulation: a tree cannot predict
    outside the range of targets it trained on, so a target that drifts upward
    with the price level guarantees under-prediction at long horizons.
    """
    horizon = 3
    levels = build_supervised_frame(features, horizon, target_mode="level")
    returns = build_supervised_frame(features, horizon, target_mode="log_return")

    level_target = levels["target"].dropna()
    return_target = returns["target"].dropna()

    # The level target spans the whole price range; the return target does not.
    assert level_target.max() - level_target.min() > 100
    assert abs(return_target.mean()) < 0.05
    assert return_target.abs().max() < 1.0


def test_log_return_predictions_can_exceed_training_range():
    """A reconstructed level must be free to rise above anything seen in training.

    Verified against the reconstruction arithmetic directly: a positive log
    return applied to a high anchor price produces a level above the anchor,
    which a level-target tree could never output.
    """
    from price_forecasting.modeling import GlobalXGBModel

    class _StubBooster:
        """Returns a fixed +2% log return regardless of input."""

        def predict(self, frame):
            return np.full(len(frame), 0.02)

    model = GlobalXGBModel(
        models={1: _StubBooster()},
        feature_columns=[],
        target_mode="log_return",
    )
    frame = pd.DataFrame({"price": [100.0, 500.0]})
    predicted = model.predict(frame, 1)

    np.testing.assert_allclose(predicted, [100.0 * np.exp(0.02), 500.0 * np.exp(0.02)])
    # Both rise above their anchor - the behaviour a level target cannot produce
    # once the anchor sits at the top of the training range.
    assert (predicted > frame["price"].to_numpy()).all()


def test_log_return_reconstruction_is_clipped():
    """An extreme leaf value must not become an absurd price."""
    from price_forecasting.modeling import GlobalXGBModel

    class _WildBooster:
        def predict(self, frame):
            return np.full(len(frame), 50.0)  # exp(50) would be astronomical

    model = GlobalXGBModel(
        models={1: _WildBooster()}, feature_columns=[], target_mode="log_return"
    )
    predicted = model.predict(pd.DataFrame({"price": [100.0]}), 1)
    assert predicted[0] < 100.0 * np.exp(0.71)


def test_time_split_is_chronological_and_disjoint(features, config):
    splits = split_by_time(features, config)
    assert splits["train_end"] < splits["test_end"] < splits["validation_end"]

    months = pd.DatetimeIndex(sorted(features["month"].unique()))
    n_validation = (months > splits["test_end"]).sum()
    n_test = ((months > splits["train_end"]) & (months <= splits["test_end"])).sum()

    assert n_validation == config.modeling.validation_months
    assert n_test == config.modeling.test_months


def test_seasonal_naive_repeats_the_value_from_twelve_months_back(panel):
    origin = panel["month"].max()
    forecast = seasonal_naive_forecast(panel, origin, [1, 2])

    part_id = forecast["part_id"].iloc[0]
    row = forecast[(forecast["part_id"] == part_id) & (forecast["horizon"] == 1)].iloc[0]

    source_month = row["target_month"] - pd.DateOffset(months=12)
    expected = panel[
        (panel["part_id"] == part_id) & (panel["month"] == source_month)
    ]["price"].iloc[0]

    assert row["prediction"] == pytest.approx(expected)


def test_plausibility_guard_rejects_divergent_forecasts():
    """The guard that catches explosive SARIMA fits.

    ``isfinite`` alone is not enough - an explosive AR root produces perfectly
    finite numbers that grow by orders of magnitude.
    """
    history = pd.Series(
        [100.0, 101.0, 102.0],
        index=pd.date_range("2025-01-01", periods=3, freq="MS"),
    )
    index = pd.date_range("2025-04-01", periods=3, freq="MS")

    sane = pd.Series([103.0, 104.0, 105.0], index=index)
    _assert_plausible(sane, history, "TST-00001", "sarima")  # must not raise

    exploded = pd.Series([500.0, 5_000.0, 50_000.0], index=index)
    with pytest.raises(ValueError, match="diverged"):
        _assert_plausible(exploded, history, "TST-00001", "sarima")

    collapsed = pd.Series([1.0, 0.5, 0.1], index=index)
    with pytest.raises(ValueError, match="diverged"):
        _assert_plausible(collapsed, history, "TST-00001", "sarima")

    assert PLAUSIBLE_RATIO_BOUNDS[0] < 1.0 < PLAUSIBLE_RATIO_BOUNDS[1]


# --------------------------------------------------------------------------- #
# Real-data validation
# --------------------------------------------------------------------------- #


def test_ledger_never_overwrites_a_recorded_forecast(tmp_path):
    """A forecast you can revise after seeing the outcome is not a forecast.

    The ledger's entire value rests on entries being immutable once written, so
    this guarantee is asserted directly.
    """
    from price_forecasting.validation import ForecastLedger

    ledger = ForecastLedger(tmp_path / "ledger.json")
    origin = pd.Timestamp("2026-06-01")
    target = pd.Timestamp("2026-07-01")

    assert ledger.record(origin, target, "sarima", 188.9) is True
    # Same month and model again, with a different number - must be refused.
    assert ledger.record(origin, target, "sarima", 999.0) is False
    assert len(ledger.entries) == 1
    assert ledger.entries[0].predicted == 188.9

    # A different model for the same month is a distinct forecast.
    assert ledger.record(origin, target, "naive", 187.6) is True
    assert len(ledger.entries) == 2


def test_ledger_scores_only_published_months(tmp_path):
    """Pending entries stay pending until real data covers their month."""
    from price_forecasting.validation import ForecastLedger

    ledger = ForecastLedger(tmp_path / "ledger.json")
    origin = pd.Timestamp("2026-06-01")
    ledger.record(origin, pd.Timestamp("2026-07-01"), "naive", 190.0)
    ledger.record(origin, pd.Timestamp("2026-08-01"), "naive", 190.0)

    published = pd.Series(
        [188.0], index=pd.DatetimeIndex([pd.Timestamp("2026-07-01")])
    )
    assert ledger.score_against(published) == 1

    july = next(e for e in ledger.entries if e.target_month == "2026-07")
    august = next(e for e in ledger.entries if e.target_month == "2026-08")

    assert july.actual == 188.0
    assert july.abs_error == pytest.approx(2.0)
    # Ledger values are stored rounded to 4dp, so compare on an absolute tolerance.
    assert july.pct_error == pytest.approx((190.0 - 188.0) / 188.0 * 100, abs=1e-3)
    assert august.actual is None, "unpublished month must not be scored"

    # Re-scoring must be idempotent, not double-counted.
    assert ledger.score_against(published) == 0


def test_validation_excludes_back_extrapolated_months():
    """Scoring against our own reconstruction would be circular."""
    from price_forecasting.data_sourcing import MacroSeries
    from price_forecasting.validation import _real_observations

    months = pd.date_range("2024-01-01", periods=12, freq="MS")
    macro = MacroSeries(
        values=pd.Series(np.linspace(180, 190, 12), index=months, name="test"),
        series_id="test",
        source="bls-live",
        observed_start=months[4],
        extrapolated_months=4,
    )

    real = _real_observations(macro)
    assert len(real) == 8
    assert real.index.min() == months[4]


# --------------------------------------------------------------------------- #
# Config validation
# --------------------------------------------------------------------------- #


def test_config_rejects_history_too_short_for_seasonal_sarima(tmp_path):
    """Twelve months cannot identify a 12-month seasonal cycle; fail loudly."""
    import yaml

    original = yaml.safe_load(open(CONFIG_PATH, encoding="utf-8"))
    original["generation"]["history_months"] = 12
    original["generation"]["focus_months"] = 12

    bad_config = tmp_path / "config.yaml"
    bad_config.write_text(yaml.safe_dump(original), encoding="utf-8")

    with pytest.raises(ConfigError, match="seasonal cycles"):
        load_config(bad_config)


def test_config_rejects_unknown_keys(tmp_path):
    import yaml

    original = yaml.safe_load(open(CONFIG_PATH, encoding="utf-8"))
    original["evaluation"]["typo_key"] = 1

    bad_config = tmp_path / "config.yaml"
    bad_config.write_text(yaml.safe_dump(original), encoding="utf-8")

    with pytest.raises(ConfigError, match="unknown key"):
        load_config(bad_config)


# --------------------------------------------------------------------------- #
# Geopolitical mediators & event calendar
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def geo_bundle(config, macro):
    from price_forecasting.geopolitical import load_geo_bundle

    return load_geo_bundle(config, macro.values.index)


@pytest.fixture(scope="module")
def geo_features(config, macro, fx_rates, geo_bundle):
    panel = generate_price_panel(config, macro, fx_rates, geo=geo_bundle)
    report = PreprocessingReport()
    cleaned = clean_panel(panel, config, report)
    return build_features(
        cleaned, config, macro, report, fx=fx_rates, geo=geo_bundle
    ), report, panel


def test_geo_event_schema_round_trip():
    from price_forecasting.geopolitical import default_seed_events
    from price_forecasting.geo_schema import events_to_frame, frame_to_events

    events = default_seed_events()
    frame = events_to_frame(events)
    restored = frame_to_events(frame)
    assert len(restored) == len(events)
    assert restored[0].event_id == events[0].event_id
    assert "freight" in restored[1].channels_affected


def test_geo_features_exclude_ground_truth(geo_features):
    features, report, _panel = geo_features
    cols = get_feature_columns(features)
    for banned in (
        "true_eur_beta",
        "true_usd_beta",
        "true_fx_lag",
        "true_steel_beta",
        "true_freight_beta",
        "true_gpr_beta",
        "commodity_key",
    ):
        assert banned not in cols
    assert report.geo_features, "expected geo features to be registered"
    assert any(c.startswith("freight_") for c in cols)
    assert any(c.startswith("cmd_steel") for c in cols)
    assert any(c.startswith("gpr") for c in cols)
    assert any(c.startswith("geo_event_") for c in cols)


def test_geo_features_do_not_leak_future(config, macro, fx_rates, geo_bundle):
    """Perturbing the final month must not change earlier geo feature rows."""
    panel = generate_price_panel(config, macro, fx_rates, geo=geo_bundle)
    report_a = PreprocessingReport()
    baseline = build_features(
        clean_panel(panel, config, report_a), config, macro, report_a,
        fx=fx_rates, geo=geo_bundle,
    )

    perturbed = panel.copy()
    last = perturbed["month"].max()
    mask = perturbed["month"] == last
    perturbed.loc[mask, "price"] = perturbed.loc[mask, "price"] * 1.5

    report_b = PreprocessingReport()
    after = build_features(
        clean_panel(perturbed, config, report_b), config, macro, report_b,
        fx=fx_rates, geo=geo_bundle,
    )

    early = baseline["month"] < last
    geo_cols = [
        c for c in get_feature_columns(baseline)
        if c.startswith(("freight_", "cmd_", "gpr", "chokepoint_", "geo_event_"))
    ]
    assert geo_cols
    pd.testing.assert_frame_equal(
        baseline.loc[early, geo_cols].reset_index(drop=True),
        after.loc[early, geo_cols].reset_index(drop=True),
    )


def test_future_gpr_changes_do_not_move_historical_gpr_features(
    config, macro, fx_rates, geo_bundle
):
    panel = generate_price_panel(config, macro, fx_rates, geo=geo_bundle)
    report_a = PreprocessingReport()
    baseline = build_features(
        clean_panel(panel, config, report_a), config, macro, report_a,
        fx=fx_rates, geo=geo_bundle,
    )

    months = geo_bundle.gpr["overall"].values.index
    pivot = months[-4]
    shifted = geo_bundle.gpr["overall"].values.copy()
    shifted.loc[shifted.index >= pivot] = shifted.loc[shifted.index >= pivot] * 4.0
    altered_gpr = dict(geo_bundle.gpr)
    altered_gpr["overall"] = MediatorSeries(
        values=shifted,
        name=geo_bundle.gpr["overall"].name,
        source=geo_bundle.gpr["overall"].source,
        unit=geo_bundle.gpr["overall"].unit,
    )
    altered_bundle = GeoBundle(
        commodities=geo_bundle.commodities,
        freight=geo_bundle.freight,
        gpr=altered_gpr,
        chokepoint=geo_bundle.chokepoint,
        events=geo_bundle.events,
    )

    report_b = PreprocessingReport()
    after = build_features(
        clean_panel(panel, config, report_b), config, macro, report_b,
        fx=fx_rates, geo=altered_bundle,
    )
    early = baseline["month"] < pivot
    gpr_cols = [c for c in get_feature_columns(baseline) if c.startswith("gpr")]
    pd.testing.assert_frame_equal(
        baseline.loc[early, gpr_cols].reset_index(drop=True),
        after.loc[early, gpr_cols].reset_index(drop=True),
    )


def test_future_freight_changes_do_not_move_historical_chokepoint_features(
    config, macro, fx_rates, geo_bundle
):
    panel = generate_price_panel(config, macro, fx_rates, geo=geo_bundle)
    report_a = PreprocessingReport()
    baseline = build_features(
        clean_panel(panel, config, report_a), config, macro, report_a,
        fx=fx_rates, geo=geo_bundle,
    )

    months = geo_bundle.freight.values.index
    pivot = months[-4]
    shifted_freight = geo_bundle.freight.values.copy()
    shifted_freight.loc[shifted_freight.index >= pivot] = (
        shifted_freight.loc[shifted_freight.index >= pivot] * 3.0
    )
    altered_bundle = GeoBundle(
        commodities=geo_bundle.commodities,
        freight=MediatorSeries(
            values=shifted_freight,
            name=geo_bundle.freight.name,
            source=geo_bundle.freight.source,
            unit=geo_bundle.freight.unit,
        ),
        gpr=geo_bundle.gpr,
        chokepoint=geo_bundle.chokepoint,
        events=geo_bundle.events,
    )

    report_b = PreprocessingReport()
    after = build_features(
        clean_panel(panel, config, report_b), config, macro, report_b,
        fx=fx_rates, geo=altered_bundle,
    )
    early = baseline["month"] < pivot
    choke_cols = [c for c in get_feature_columns(baseline) if c.startswith("chokepoint_")]
    pd.testing.assert_frame_equal(
        baseline.loc[early, choke_cols].reset_index(drop=True),
        after.loc[early, choke_cols].reset_index(drop=True),
    )


def test_freight_exposure_survives_localisation(geo_features):
    """Import-dependent vendors keep freight beta even on localised programmes."""
    _features, _report, panel = geo_features
    high_import = panel[panel["vendor_import_dependency"] >= 0.5]
    low_import = panel[panel["vendor_import_dependency"] <= 0.2]
    assert high_import["true_freight_beta"].mean() > low_import["true_freight_beta"].mean()


def test_mediator_pass_through_moves_prices(config, macro, fx_rates, geo_bundle):
    """With geo mediators, the panel must differ from an FX-only generation."""
    with_geo = generate_price_panel(config, macro, fx_rates, geo=geo_bundle)
    without = generate_price_panel(config, macro, fx_rates, geo=None)
    # Same seed → same catalogue/noise; mediator path should still move levels
    assert not np.allclose(
        with_geo["price"].fillna(0).to_numpy(),
        without["price"].fillna(0).to_numpy(),
    )


def test_nlp_enriches_event_severity(config, tmp_path):
    from price_forecasting.geo_nlp import enrich_events_with_nlp, score_narrative
    from price_forecasting.geopolitical import default_seed_events

    assert score_narrative("invasion and war") > score_narrative("trade phase agreement")

    paths = dataclasses.replace(
        config.paths,
        data_raw=tmp_path,
        data_processed=tmp_path / "processed",
        reports=tmp_path / "reports",
        figures=tmp_path / "figures",
        models=tmp_path / "models",
    )
    cfg = dataclasses.replace(config, paths=paths)
    enriched = enrich_events_with_nlp(default_seed_events(), cfg)
    assert all(e.nlp_severity is not None for e in enriched)
    assert (tmp_path / cfg.geo.events_filename).is_file()


def test_parameter_catalogue_marks_geo_drivers_implemented(geo_features):
    from price_forecasting.parameters import build_parameter_catalogue

    features, _report, _panel = geo_features
    catalogue = build_parameter_catalogue(get_feature_columns(features))
    by_id = {d["id"]: d for d in catalogue["drivers"]}
    for driver_id in GEO_DRIVER_IDS:
        assert by_id[driver_id]["status"] == "implemented", driver_id


# --------------------------------------------------------------------------- #
# Geo feature modes - sparse vs the full lag ladder
# --------------------------------------------------------------------------- #

GEO_DRIVER_IDS = (
    "geopolitical_risk",
    "tariffs_duty",
    "chokepoints",
    "steel",
    "aluminium_copper",
    "container_freight",
)


@pytest.fixture(scope="module")
def geo_features_by_mode(config, macro, fx_rates, geo_bundle):
    """Feature frames for both geo feature modes, built off one shared panel."""
    panel = generate_price_panel(config, macro, fx_rates, geo=geo_bundle)
    cleaned = clean_panel(panel, config, PreprocessingReport())

    built = {}
    for mode in ("sparse", "full"):
        scoped = dataclasses.replace(
            config, geo=dataclasses.replace(config.geo, feature_mode=mode)
        )
        report = PreprocessingReport()
        frame = build_features(
            cleaned, scoped, macro, report, fx=fx_rates, geo=geo_bundle
        )
        built[mode] = (frame, report)
    return built


def test_sparse_mode_prunes_the_lag_ladder(geo_features_by_mode):
    """Sparse must drop columns from the full set, never invent new ones.

    The wide ladder spends most of its columns on near-duplicate lags of the
    same mediator, which on a three-year panel cost holdout accuracy and
    scrambled the freight shock ranking. Sparse being a strict subset is what
    makes the two arms comparable in the ablation.
    """
    sparse = geo_features_by_mode["sparse"][1].geo_features
    full = geo_features_by_mode["full"][1].geo_features

    assert set(sparse) <= set(full), sorted(set(sparse) - set(full))
    assert len(sparse) < len(full) / 2, f"sparse={len(sparse)} full={len(full)}"


def test_sparse_mode_excludes_non_contract_event_columns_from_model_inputs(
    geo_features_by_mode,
):
    frame, _report = geo_features_by_mode["sparse"]
    cols = set(get_feature_columns(frame))
    banned = {
        "geo_event_conflict",
        "geo_event_conflict_severity",
        "geo_event_tariff_severity",
        "geo_event_sanction",
        "geo_event_sanction_severity",
        "geo_event_sanction_decay",
        "geo_event_trade_agreement",
        "geo_event_trade_agreement_severity",
        "geo_event_trade_agreement_decay",
        "geo_event_max_severity",
    }
    assert cols.isdisjoint(banned), sorted(cols.intersection(banned))


def test_both_geo_modes_keep_driver_coverage(geo_features_by_mode):
    """Pruning must not silently demote a driver to 'not implemented'."""
    from price_forecasting.parameters import build_parameter_catalogue

    for mode, (frame, _report) in geo_features_by_mode.items():
        catalogue = build_parameter_catalogue(get_feature_columns(frame))
        by_id = {d["id"]: d for d in catalogue["drivers"]}
        for driver_id in GEO_DRIVER_IDS:
            assert by_id[driver_id]["status"] == "implemented", (mode, driver_id)


def test_geo_features_expose_only_stationary_transforms(geo_features_by_mode):
    """Mediator levels track time, so only returns and z-scores may be features.

    Same discipline as the FX features: a raw commodity or freight level is a
    trend proxy, and a shocked level lands outside the training range where
    trees are flat.
    """
    for mode, (_frame, report) in geo_features_by_mode.items():
        for name in report.geo_features:
            if name.startswith(("cmd_", "freight_")):
                assert "ret" in name, f"non-stationary mediator feature ({mode}): {name}"
            if name.startswith("gpr"):
                assert "_z_" in name, f"non-standardised GPR feature ({mode}): {name}"


def test_hitl_alerts_require_confirmation_payload(geo_features, config, geo_bundle):
    """Alerts must ship impact pre-computed but gated behind analyst review."""
    from price_forecasting.geo_hitl import build_hitl_payload
    from price_forecasting.geopolitical import geo_provenance
    from price_forecasting.modeling import train_global_xgboost

    features, _report, panel = geo_features
    provenance = geo_provenance(geo_bundle)
    origin = features["month"].max()
    model = train_global_xgboost(features, config, origin, [1, 3])

    payload = build_hitl_payload(
        geo_bundle.events,
        provenance["mediators"],
        model,
        features,
        panel,
        config,
        horizon=3,
    )
    assert payload["available"]
    assert payload["alerts"], "expected headline-driven alerts"
    alert = payload["alerts"][0]
    assert alert["prompt"]
    assert alert["sourceVerifications"]
    assert alert["impact"]["available"] is True
    assert "overallPriceChangePct" in alert["impact"]
    drivers = payload["forecastDrivers"]
    assert drivers.get("available")
    assert drivers.get("drivers")


# --------------------------------------------------------------------------- #
# Purchase-order ingest
# --------------------------------------------------------------------------- #


def test_config_rejects_bad_sku_mode(tmp_path):
    import yaml

    original = yaml.safe_load(open(CONFIG_PATH, encoding="utf-8"))
    original["sku"]["mode"] = "excel"
    bad_config = tmp_path / "config.yaml"
    bad_config.write_text(yaml.safe_dump(original), encoding="utf-8")
    with pytest.raises(ConfigError, match="sku.mode"):
        load_config(bad_config)


def test_po_column_aliases_and_volume_weighted_price(config, tmp_path):
    from price_forecasting.po_ingest import (
        aggregate_po_to_panel,
        load_purchase_orders,
        resolve_sku_mode,
    )

    po_path = tmp_path / "purchase_orders.csv"
    po_path.write_text(
        "sku,invoice_date,net_price,qty,part_name,project_code,project,"
        "vendor_code,vendor,category_code,category\n"
        "P1,2024-01-10,100,1,Widget,PRJ,Programme,V1,Vendor,CAT,Category\n"
        "P1,2024-01-20,200,3,Widget,PRJ,Programme,V1,Vendor,CAT,Category\n"
        "P1,2024-02-05,110,2,Widget,PRJ,Programme,V1,Vendor,CAT,Category\n",
        encoding="utf-8",
    )

    # Point config at the temp file without mutating the frozen Config.
    from dataclasses import replace

    sku = replace(config.sku, purchase_orders_filename=po_path.name, mode="auto")
    paths = replace(config.paths, data_raw=tmp_path)
    cfg = replace(config, sku=sku, paths=paths)

    assert resolve_sku_mode(cfg) == "purchase_orders"
    raw = load_purchase_orders(cfg, po_path)
    assert "part_id" in raw.columns and "unit_price" in raw.columns
    panel, report = aggregate_po_to_panel(raw, cfg, source_path=str(po_path))
    assert report.n_parts == 1
    assert report.n_months == 2
    jan = panel[panel["month"] == "2024-01-01"]["price"].iloc[0]
    # (100*1 + 200*3) / 4 = 175
    assert abs(jan - 175.0) < 1e-6
    assert report.as_dict()["skuLayer"] == "purchase_orders"


def test_resolve_sku_mode_auto_falls_back_to_synthetic(config, tmp_path):
    from dataclasses import replace

    from price_forecasting.po_ingest import resolve_sku_mode

    sku = replace(config.sku, mode="auto", purchase_orders_filename="missing_pos.csv")
    paths = replace(config.paths, data_raw=tmp_path)
    cfg = replace(config, sku=sku, paths=paths)
    assert resolve_sku_mode(cfg) == "synthetic"


# --------------------------------------------------------------------------- #
# Live mediator parsing (Pink Sheet / freight)
# --------------------------------------------------------------------------- #


def test_workbook_bytes_keeps_xlsx_zip_intact():
    """OOXML xlsx starts with PK; must not be treated as a zip-of-xlsx."""
    import io
    import zipfile

    from price_forecasting.geopolitical import _workbook_bytes

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("xl/workbook.xml", "<workbook/>")
    payload = buf.getvalue()
    assert payload[:2] == b"PK"
    assert _workbook_bytes(payload) is payload or _workbook_bytes(payload) == payload


def test_parse_pink_sheet_cmo_month_labels(tmp_path):
    """World Bank uses 2024M03 labels; ellipsis cells must become NaN."""
    import io

    from price_forecasting.geopolitical import _parse_pink_sheet

    # Minimal Monthly Prices-like sheet
    rows = [
        ["World Bank Commodity Price Data", None, None, None, None],
        [None, None, None, None, None],
        [None, None, None, None, None],
        [None, None, None, None, None],
        [None, "Crude oil, average", "Aluminum", "Iron ore, cfr spot", "Copper"],
        [None, "($/bbl)", "($/mt)", "($/dmt)", "($/mt)"],
        ["2023M01", 80.0, 2200.0, 100.0, 8000.0],
        ["2023M02", 82.0, 2300.0, "…", 8100.0],
        ["2023M03", 81.0, 2250.0, 110.0, 8200.0],
    ]
    frame = pd.DataFrame(rows)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        frame.to_excel(writer, sheet_name="Monthly Prices", header=False, index=False)
    months = pd.date_range("2023-01-01", periods=3, freq="MS")
    parsed = _parse_pink_sheet(buf.getvalue(), months)
    assert "steel" in parsed and "aluminium" in parsed and "copper" in parsed
    assert "energy" in parsed
    assert float(parsed["energy"].iloc[0]) == pytest.approx(80.0)
    # Iron ore Feb was ellipsis → interpolated/filled by align; still a finite series
    assert parsed["steel"].notna().all()


def test_freight_csv_drop_in_marked_real(config, tmp_path):
    from dataclasses import replace

    from price_forecasting.geopolitical import fetch_freight

    csv_path = tmp_path / "freight_monthly.csv"
    csv_path.write_text(
        "month,value\n2023-01-01,100\n2023-02-01,110\n2023-03-01,105\n",
        encoding="utf-8",
    )
    geo = replace(config.geo, freight_filename="freight_monthly.csv", freight_url="")
    paths = replace(config.paths, data_raw=tmp_path)
    cfg = replace(config, geo=geo, paths=paths)
    months = pd.date_range("2023-01-01", periods=3, freq="MS")
    freight = fetch_freight(cfg, months)
    assert freight.is_real
    assert freight.source == "freight-csv"
    assert float(freight.values.iloc[1]) == pytest.approx(110.0)


# --------------------------------------------------------------------------- #
# Ops loop: horizon-1 + feature selection
# --------------------------------------------------------------------------- #


def test_config_horizon_is_one_month():
    cfg = load_config(CONFIG_PATH)
    assert cfg.modeling.forecast_horizon == 1
    assert cfg.evaluation.backtest_horizon == 1
    assert cfg.ops.feature_selection.top_k >= 1


def test_feature_group_and_apply_selection_keeps_core(config):
    from price_forecasting.feature_selection import apply_selection, feature_group

    assert feature_group("fx_eurinr_ret_lag2") == "fx"
    assert feature_group("cmd_matched_ret_lag2") == "cmd_matched"
    assert feature_group("freight_ret_lag2_x_import") == "freight"

    frame = pd.DataFrame(
        {
            "month": pd.to_datetime(["2024-01-01", "2024-02-01"]),
            "part_id": ["A", "A"],
            "price": [10.0, 11.0],
            "price_lag_1": [1.0, 1.1],
            "fx_eurinr_ret_lag2": [0.01, 0.02],
            "cmd_matched_ret_lag2": [0.0, 0.1],
            "noise_feature_xyz": [3.0, 4.0],
            "project": ["P", "P"],
            "vendor": ["V", "V"],
            "category": ["C", "C"],
        }
    )
    for col in ("project", "vendor", "category"):
        frame[col] = frame[col].astype("category")

    frozen = {
        "selected": ["price_lag_1", "fx_eurinr_ret_lag2"],
        "rejected": ["noise_feature_xyz"],
    }
    kept = apply_selection(frame, frozen)
    assert "price_lag_1" in kept
    assert "fx_eurinr_ret_lag2" in kept
    # Core prefixes missing from frozen report are appended
    assert "cmd_matched_ret_lag2" in kept
    assert "noise_feature_xyz" not in kept


def test_select_features_reuses_full_model_for_baseline_mape(config, geo_features, monkeypatch):
    """Full-candidate XGB is fit once; baseline MAPE and selection match a dual-fit path."""
    from dataclasses import replace

    import price_forecasting.feature_selection as fs_mod
    from price_forecasting.feature_selection import (
        _gain_importance,
        _holdout_mape,
        _score_holdout_mape,
        feature_group,
        select_features,
        selection_train_end,
    )
    from price_forecasting.modeling import train_global_xgboost
    from price_forecasting.preprocessing import get_feature_columns

    features, _report, _panel = geo_features
    # Keep methodology flags; shrink trees only so the dual-path reference stays fast.
    xgb = replace(config.modeling.xgboost, n_estimators=25, max_depth=3)
    modeling = replace(config.modeling, xgboost=xgb)
    fs = replace(config.ops.feature_selection, top_k=10, run_ablation=True)
    cfg = replace(config, modeling=modeling, ops=replace(config.ops, feature_selection=fs))

    candidates = get_feature_columns(features)
    train_end = selection_train_end(features, cfg)
    horizon = cfg.modeling.forecast_horizon

    train_calls: list[tuple[str, ...]] = []
    real_train = fs_mod.train_global_xgboost

    def spy_train(features_arg, config_arg, train_end_arg, horizons, feature_columns=None):
        cols = (
            list(feature_columns)
            if feature_columns is not None
            else get_feature_columns(features_arg)
        )
        train_calls.append(tuple(cols))
        return real_train(
            features_arg, config_arg, train_end_arg, horizons, feature_columns=feature_columns
        )

    monkeypatch.setattr(fs_mod, "train_global_xgboost", spy_train)

    report = select_features(features, cfg)

    full_fits = [cols for cols in train_calls if list(cols) == candidates]
    assert len(full_fits) == 1, (
        f"expected exactly one full-feature XGBoost fit, got {len(full_fits)} "
        f"(total trains={len(train_calls)})"
    )

    # Old Fit-2 path: fresh identical full-feature train + MAPE.
    # Deterministic seed => numerically identical to scoring the reused Fit-1 model.
    legacy_baseline = _holdout_mape(features, cfg, candidates, train_end, horizon)
    assert report.baseline_mape == round(float(legacy_baseline), 4)

    reused_baseline = _score_holdout_mape(
        real_train(features, cfg, train_end, [horizon], feature_columns=candidates),
        features,
        train_end,
        horizon,
    )
    assert report.baseline_mape == round(float(reused_baseline), 4)

    # Reference selection with the legacy dual full-fit methodology (same rules).
    full_model = train_global_xgboost(
        features, cfg, train_end, [horizon], feature_columns=candidates
    )
    gains = _gain_importance(full_model, candidates, horizon)
    ranked = sorted(gains.items(), key=lambda kv: kv[1], reverse=True)
    always = [
        c
        for c in candidates
        if any(c.startswith(p) for p in cfg.ops.feature_selection.always_keep_prefixes)
    ]
    top = [c for c, _ in ranked[: cfg.ops.feature_selection.top_k]]
    selected_set = set(always) | set(top)

    group_map: dict[str, list[str]] = {}
    for col in candidates:
        group_map.setdefault(feature_group(col), []).append(col)

    baseline_mape = legacy_baseline
    for group, cols in group_map.items():
        if all(c in selected_set for c in cols):
            continue
        reduced = [c for c in candidates if c not in cols]
        if not reduced:
            selected_set.update(cols)
            continue
        ablated_mape = _holdout_mape(features, cfg, reduced, train_end, horizon)
        if (
            baseline_mape is not None
            and not np.isnan(baseline_mape)
            and ablated_mape is not None
            and not np.isnan(ablated_mape)
        ):
            lift = float(ablated_mape - baseline_mape)
            if lift >= cfg.ops.feature_selection.min_ablation_lift_pct:
                selected_set.update(cols)

    expected_selected = [c for c in candidates if c in selected_set]
    expected_selected.sort(key=lambda c: gains.get(c, 0.0), reverse=True)
    assert report.selected == expected_selected


def test_select_features_writes_report_and_keeps_prefixes(config, geo_features, tmp_path):
    from dataclasses import replace

    from price_forecasting.feature_selection import save_selection, select_features

    features, _report, _panel = geo_features
    paths = replace(config.paths, data_processed=tmp_path)
    cfg = replace(config, paths=paths)
    # Speed: importance-only (skip group ablation trains)
    fs = replace(cfg.ops.feature_selection, top_k=10, run_ablation=False)
    ops = replace(cfg.ops, feature_selection=fs)
    cfg = replace(cfg, ops=ops)

    report = select_features(features, cfg)
    path = save_selection(cfg, report)
    assert path.is_file()
    assert report.selected
    assert any(c.startswith("fx_") for c in report.selected) or any(
        c.startswith("price_lag_") or c.startswith("cmd_matched") or c.startswith("freight")
        for c in report.selected
    )
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["nSelected"] == len(report.selected)
    assert "asOf" in payload


def test_feature_selection_is_nested_inside_holdout_training_window(config, geo_features):
    features, _report, _panel = geo_features
    outer_train_end = split_by_time(features, config)["train_end"]
    inner_train_end = selection_train_end(features, config)

    assert inner_train_end < outer_train_end

    horizon = config.modeling.forecast_horizon
    inner_eval_month = inner_train_end + pd.DateOffset(months=horizon)
    final_holdout_start = outer_train_end + pd.DateOffset(months=1)
    assert inner_eval_month < final_holdout_start


def test_arbitrary_numeric_column_is_not_automatically_a_model_feature(features):
    frame = features.copy()
    frame["unexpected_numeric_feature"] = 123.0
    assert "unexpected_numeric_feature" not in get_feature_columns(frame)


def test_select_features_always_keeps_price_lag_1(config, geo_features):
    from dataclasses import replace

    features, _report, _panel = geo_features
    fs = replace(config.ops.feature_selection, top_k=0, run_ablation=False)
    cfg = replace(config, ops=replace(config.ops, feature_selection=fs))
    report = select_features(features, cfg)
    assert "price_lag_1" in report.selected
