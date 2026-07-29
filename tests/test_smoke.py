"""POC-scale correctness tests.

Not an exhaustive suite. These cover the failure modes that would silently
invalidate results rather than raise: feature leakage, non-reproducibility,
wrong metric maths, and training on data the model should not have seen.
"""

from __future__ import annotations

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
