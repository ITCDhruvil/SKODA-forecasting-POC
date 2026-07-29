"""FX scenario analysis and hierarchical roll-ups.

Two questions a procurement team actually asks:

1. *"If the rupee drops another 5%, what happens to my costs?"* Answered by
   re-running the trained model with the FX features shocked and nothing else
   changed, then reading the difference. Because the model is a single global
   estimator over all parts, the shock propagates through whatever FX structure
   it actually learned - it is not a formula applied on top.

2. *"Where does that land?"* Answered by rolling the per-part response up the
   project / vendor / category hierarchy, which is where a buyer can act on it.

The scenario also serves as a **model diagnostic**. The generator's true FX betas
are known, so the elasticity the model reveals under shock can be compared
against the elasticity that was actually built in. A model that ignored FX would
show a flat response and be caught here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from .config import Config
from .logging_utils import get_logger
from .modeling import GlobalXGBModel

logger = get_logger(__name__)

# Hierarchy levels reported for every scenario, coarse to fine.
ROLLUP_LEVELS = (
    ("project", "project"),
    ("vendor", "vendor"),
    ("category", "category"),
)


@dataclass
class ScenarioResult:
    """Price response to one FX shock."""

    name: str
    shock_pct: float
    pairs: List[str]
    overall_price_change_pct: float
    implied_elasticity: float
    by_level: Dict[str, List[Dict[str, object]]]

    def as_dict(self) -> Dict[str, object]:
        return {
            "name": self.name,
            "shockPct": round(self.shock_pct, 3),
            "pairs": self.pairs,
            "overallPriceChangePct": round(self.overall_price_change_pct, 4),
            "impliedElasticity": round(self.implied_elasticity, 4),
            "byLevel": self.by_level,
        }


def _shift_fx_features(
    frame: pd.DataFrame, shock_pct: float, pairs: Sequence[str]
) -> pd.DataFrame:
    """Apply a proportional shock to every FX feature for the given pairs.

    Level features scale by ``(1 + shock)``. Return and cumulative-log features
    shift by ``log(1 + shock)``, because they live in log space - scaling them
    proportionally instead would be wrong by an order of magnitude for small
    moves and is a very easy mistake to make silently.

    Nothing else in the frame is touched, so the difference in prediction is
    attributable to FX alone.
    """
    shocked = frame.copy()
    log_shock = float(np.log1p(shock_pct / 100.0))

    # Exposure weights the interaction features were built from. The shock has
    # to flow through them too - they are the features the model actually uses
    # to tell an import-heavy vendor from a domestic one, so leaving them at
    # baseline would produce a near-flat, meaningless response.
    import_dependency = (
        shocked["vendor_import_dependency"]
        if "vendor_import_dependency" in shocked.columns
        else pd.Series(0.5, index=shocked.index)
    )
    import_content = (
        1.0 - shocked["project_localisation"]
        if "project_localisation" in shocked.columns
        else pd.Series(0.5, index=shocked.index)
    )

    for pair in pairs:
        key = pair.lower()
        level_col = f"fx_{key}"
        if level_col in shocked.columns:
            shocked[level_col] = shocked[level_col] * (1.0 + shock_pct / 100.0)

        for column in shocked.columns:
            if not column.startswith(f"fx_{key}_"):
                continue
            if column.endswith("_x_import"):
                shocked[column] = shocked[column] + log_shock * import_dependency
            elif column.endswith("_x_content"):
                shocked[column] = shocked[column] + log_shock * import_content
            else:
                # Return columns are already in log space.
                shocked[column] = shocked[column] + log_shock

    return shocked


def _rollup(
    frame: pd.DataFrame, level_column: str, baseline: str, shocked: str
) -> List[Dict[str, object]]:
    """Aggregate the price response by one hierarchy dimension."""
    if level_column not in frame.columns:
        return []

    grouped = frame.groupby(level_column, observed=True)
    rows = []
    for name, group in grouped:
        base_total = float(group[baseline].sum())
        shock_total = float(group[shocked].sum())
        if base_total <= 0:
            continue
        rows.append(
            {
                "name": str(name),
                "parts": int(group["part_id"].nunique()),
                "baselineValue": round(base_total, 2),
                "shockedValue": round(shock_total, 2),
                "changePct": round((shock_total - base_total) / base_total * 100, 4),
                "changeAbs": round(shock_total - base_total, 2),
            }
        )
    rows.sort(key=lambda r: abs(r["changePct"]), reverse=True)
    return rows


def run_fx_scenarios(
    config: Config,
    model: GlobalXGBModel,
    features: pd.DataFrame,
    horizon: int,
    shocks: Optional[Sequence[float]] = None,
) -> List[Dict[str, object]]:
    """Re-predict under a range of FX shocks and roll the response up.

    Args:
        config: Pipeline configuration.
        model: Trained global model.
        features: Feature frame; the latest month is used as the forecast origin.
        horizon: Which horizon's model to use for the scenario.
        shocks: Percentage moves in the foreign currency. Positive means the
            domestic currency weakens, which should raise prices.

    Returns:
        One serialisable payload per shock.
    """
    shocks = shocks or config.fx.scenario_shocks
    pairs = config.fx.pair_names()

    origin_month = features["month"].max()
    origin = features[features["month"] == origin_month].copy()
    if origin.empty:
        logger.warning("no rows at origin month; skipping FX scenarios")
        return []

    if horizon not in model.models:
        horizon = max(model.models) if model.models else None
        if horizon is None:
            logger.warning("model has no trained horizons; skipping FX scenarios")
            return []

    baseline = model.predict(origin, horizon)
    origin["baseline_price"] = baseline

    results: List[ScenarioResult] = []

    for shock_pct in shocks:
        shocked_frame = _shift_fx_features(origin, shock_pct, pairs)
        # The anchor price must NOT be shocked: it is an observed historical
        # value, not a forecast. Only the FX inputs move.
        shocked_frame["price"] = origin["price"]
        shocked_prediction = model.predict(shocked_frame, horizon)

        working = origin.copy()
        working["shocked_price"] = shocked_prediction

        base_total = float(working["baseline_price"].sum())
        shock_total = float(working["shocked_price"].sum())
        change_pct = (shock_total - base_total) / base_total * 100 if base_total else 0.0

        by_level = {
            label: _rollup(working, column, "baseline_price", "shocked_price")
            for label, column in ROLLUP_LEVELS
        }

        result = ScenarioResult(
            name=f"{shock_pct:+.0f}% FX",
            shock_pct=float(shock_pct),
            pairs=pairs,
            overall_price_change_pct=change_pct,
            # Elasticity: fraction of the FX move that reaches price.
            implied_elasticity=change_pct / shock_pct if shock_pct else 0.0,
            by_level=by_level,
        )
        results.append(result)

        logger.info(
            "FX scenario %+.0f%%: basket %+.3f%% (implied pass-through %.3f)",
            shock_pct,
            change_pct,
            result.implied_elasticity,
        )

    _log_extremes(results)
    return [r.as_dict() for r in results]


def _log_extremes(results: Sequence[ScenarioResult]) -> None:
    """Log which parts of the hierarchy are most and least FX-exposed."""
    if not results:
        return
    worst = max(results, key=lambda r: abs(r.shock_pct))
    categories = worst.by_level.get("category", [])
    if len(categories) >= 2:
        logger.info(
            "under %s, most exposed category: %s (%+.2f%%); least exposed: %s (%+.2f%%)",
            worst.name,
            categories[0]["name"],
            categories[0]["changePct"],
            categories[-1]["name"],
            categories[-1]["changePct"],
        )


def fx_trend_collinearity(fx: Dict[str, object]) -> Dict[str, object]:
    """How separable is FX from a plain time trend on this window?

    This is the question that actually decides whether FX-conditional forecasts
    are trustworthy, and it is *not* the same as asking whether the FX effect is
    large enough to detect. An effect can be perfectly detectable and still be
    unattributable, if the driver moves in lockstep with something else.

    Over a window where the rupee depreciated almost monotonically, the
    cumulative FX path is nearly a straight line in time - so "prices rose
    because FX moved" and "prices rose because time passed" are the same
    statement, and no estimator can separate them. Monthly *returns* are far
    less collinear, which is why they are the only FX transform exposed to the
    model.
    """
    rows = []
    series_map = {pair: np.log(s.values.to_numpy()) for pair, s in fx.items()}

    for pair, log_rate in series_map.items():
        cumulative = log_rate - log_rate[0]
        time_index = np.arange(len(cumulative), dtype=float)
        rows.append(
            {
                "pair": pair,
                "cumulativeVsTime": round(float(np.corrcoef(cumulative, time_index)[0, 1]), 4),
                "risingMonthsPct": round(
                    float((np.diff(log_rate) > 0).mean() * 100), 1
                ),
            }
        )

    pairs = list(series_map)
    cross_level = cross_return = None
    if len(pairs) >= 2:
        a, b = series_map[pairs[0]], series_map[pairs[1]]
        cross_level = round(float(np.corrcoef(a, b)[0, 1]), 4)
        cross_return = round(float(np.corrcoef(np.diff(a), np.diff(b))[0, 1]), 4)

    worst = max((abs(r["cumulativeVsTime"]) for r in rows), default=0.0)
    separable = worst < 0.7

    logger.info(
        "FX/trend collinearity: cumulative path correlates %.2f with elapsed "
        "time; currency pairs correlate %s on levels but %s on returns -> FX is "
        "%s from trend on this window",
        worst,
        cross_level,
        cross_return,
        "separable" if separable else "NOT separable",
    )
    if not separable:
        logger.warning(
            "FX is collinear with the time trend here (r=%.2f). Aggregate "
            "direction is still meaningful, but attributing category-level "
            "differences to FX rather than to trend is not supported by this "
            "data.",
            worst,
        )

    return {
        "available": True,
        "byPair": rows,
        "crossPairLevelCorr": cross_level,
        "crossPairReturnCorr": cross_return,
        "maxCumulativeVsTime": round(float(worst), 4),
        "separable": bool(separable),
        "note": (
            "Detectability and attributability are different questions. Over a "
            "near-monotonic depreciation the cumulative FX path is collinear "
            "with elapsed time, so a model cannot tell an FX effect from a "
            "trend effect no matter how large either is. Monthly returns carry "
            "the independent variation, which is why only returns are exposed "
            "as features. Separating FX properly needs a window containing "
            "reversals, or currencies that diverge."
        ),
    }


def fx_signal_to_noise(
    panel: pd.DataFrame, config: Config, fx_log_move: float
) -> Dict[str, object]:
    """Is category-level FX exposure even detectable at this noise level?

    Before blaming a model for failing to rank categories by FX exposure, check
    whether the ranking is recoverable at all. The spread in true betas times
    the FX move gives the price difference between the most and least exposed
    category; the AR(1) noise gives what that difference has to be seen through.

    If the signal sits below the noise, "not recovered" is a statement about the
    data, not about the model - and reporting it as a model failure would be
    wrong.
    """
    if "true_eur_beta" not in panel.columns:
        return {"available": False}

    by_category = (
        panel.groupby("category")[["true_eur_beta", "true_usd_beta"]].mean().sum(axis=1)
    )
    beta_spread = float(by_category.max() - by_category.min())
    signal_pct = beta_spread * abs(fx_log_move) * 100

    noise_sd = config.generation.noise_sigma / np.sqrt(
        1 - config.generation.noise_phi**2
    )
    monthly_noise_pct = float(noise_sd * 100)

    # Averaging over parts and months shrinks the noise on a category mean.
    parts_per_category = float(panel.groupby("category")["part_id"].nunique().mean())
    months = float(panel["month"].nunique())
    category_noise_pct = monthly_noise_pct / np.sqrt(max(parts_per_category * months, 1.0))

    ratio = signal_pct / category_noise_pct if category_noise_pct else float("inf")
    identifiable = ratio >= 3.0

    logger.info(
        "FX signal-to-noise: category beta spread %.4f x FX move %.3f = %.2f%% "
        "price signal, against %.3f%% noise on a category mean -> SNR %.1f (%s)",
        beta_spread,
        fx_log_move,
        signal_pct,
        category_noise_pct,
        ratio,
        "identifiable" if identifiable else "NOT identifiable",
    )

    return {
        "available": True,
        "betaSpread": round(beta_spread, 4),
        "signalPct": round(signal_pct, 4),
        "monthlyNoisePct": round(monthly_noise_pct, 4),
        "categoryMeanNoisePct": round(float(category_noise_pct), 5),
        "snr": round(float(ratio), 2),
        "identifiable": bool(identifiable),
        "note": (
            "Signal is the price gap between the most and least FX-exposed "
            "category over the observed FX move. Noise is the AR(1) volatility "
            "remaining on a category mean after averaging over parts and months. "
            "Below an SNR of about 3 the ranking is not recoverable by any "
            "model, so a poor correlation is a property of the data rather than "
            "a failure of the estimator."
        ),
    }


def validate_fx_learning(
    panel: pd.DataFrame, scenarios: Sequence[Dict[str, object]]
) -> Dict[str, object]:
    """Compare the model's revealed FX response against the generator's truth.

    The generator's ``true_eur_beta`` / ``true_usd_beta`` say how much each part
    *should* move per unit log-change in FX. A shock scenario reveals how much
    the model thinks it moves. Ranking categories by both and correlating them
    tests whether the model recovered the FX structure or merely fitted the
    average drift.

    Rank correlation is the right measure here: the model sees a damped,
    noise-obscured version of the true relationship, so matching the *ordering*
    of exposure across categories is the meaningful claim, not matching betas
    one-for-one.
    """
    if not scenarios or "true_eur_beta" not in panel.columns:
        return {"available": False, "reason": "no scenarios or no ground truth in panel"}

    # Use the largest *positive* shock. Keying on abs() would tie -10% with
    # +10% and return whichever came first, silently correlating a negative
    # price response against positive true betas and flipping the sign.
    positive = [s for s in scenarios if s["shockPct"] > 0]
    if not positive:
        return {"available": False, "reason": "no positive FX shock to evaluate"}
    largest = max(positive, key=lambda s: s["shockPct"])
    modelled = {row["name"]: row["changePct"] for row in largest["byLevel"].get("category", [])}
    if len(modelled) < 3:
        return {"available": False, "reason": "too few categories to correlate"}

    truth = (
        panel.groupby("category")[["true_eur_beta", "true_usd_beta"]]
        .mean()
        .sum(axis=1)
        .to_dict()
    )

    common = sorted(set(modelled) & set(truth))
    if len(common) < 3:
        return {"available": False, "reason": "category names did not align"}

    modelled_values = pd.Series([modelled[c] for c in common])
    true_values = pd.Series([truth[c] for c in common])

    spearman = float(modelled_values.corr(true_values, method="spearman"))
    pearson = float(modelled_values.corr(true_values, method="pearson"))

    rows = [
        {
            "category": category,
            "trueBeta": round(float(truth[category]), 4),
            "modelledChangePct": round(float(modelled[category]), 4),
        }
        for category in common
    ]
    rows.sort(key=lambda r: r["trueBeta"], reverse=True)

    verdict = (
        "recovered" if spearman >= 0.6
        else "partial" if spearman >= 0.3
        else "not recovered"
    )
    logger.info(
        "FX learning check: Spearman %.3f, Pearson %.3f across %d categories -> %s",
        spearman,
        pearson,
        len(common),
        verdict,
    )
    if verdict == "not recovered":
        logger.warning(
            "the model's FX response does not track the true category exposure "
            "ordering. FX-conditional forecasts should not be trusted."
        )

    return {
        "available": True,
        "shockPct": largest["shockPct"],
        "spearman": round(spearman, 4),
        "pearson": round(pearson, 4),
        "verdict": verdict,
        "nCategories": len(common),
        "rows": rows,
    }


def hierarchy_rollup(
    panel: pd.DataFrame, forecasts: pd.DataFrame, horizon: Optional[int] = None
) -> Dict[str, List[Dict[str, object]]]:
    """Current vs forecast spend, rolled up each hierarchy dimension.

    This is how the prediction is read at each level: a part-level model
    aggregated to the level a decision is made at. Project-level tells a
    programme manager their cost trajectory; vendor-level drives negotiation
    priority; category-level points at commodity hedging.
    """
    latest_month = panel["month"].max()
    latest = panel[panel["month"] == latest_month]

    primary = forecasts[forecasts["model"] == "xgboost"]
    if primary.empty:
        primary = forecasts[forecasts["model"] == "sarima"]
    if primary.empty:
        return {}

    target_horizon = horizon or int(primary["horizon"].max())
    end = primary[primary["horizon"] == target_horizon]

    static_columns = [c for c in ("project", "vendor", "category") if c in latest.columns]
    merged = end.merge(
        latest[["part_id", "price"] + static_columns].drop_duplicates("part_id"),
        on="part_id",
        how="inner",
        suffixes=("", "_current"),
    )

    result: Dict[str, List[Dict[str, object]]] = {}
    for label, column in ROLLUP_LEVELS:
        if column not in merged.columns:
            continue
        rows = []
        for name, group in merged.groupby(column, observed=True):
            current = float(group["price"].sum())
            forecast = float(group["prediction"].sum())
            if current <= 0:
                continue
            rows.append(
                {
                    "name": str(name),
                    "parts": int(group["part_id"].nunique()),
                    "currentSpend": round(current, 2),
                    "forecastSpend": round(forecast, 2),
                    "changePct": round((forecast - current) / current * 100, 3),
                    "changeAbs": round(forecast - current, 2),
                }
            )
        rows.sort(key=lambda r: r["changePct"], reverse=True)
        result[label] = rows

    for label, rows in result.items():
        if rows:
            logger.info(
                "%s roll-up over %d month(s): %s %+.2f%% (highest), %s %+.2f%% (lowest)",
                label,
                target_horizon,
                rows[0]["name"],
                rows[0]["changePct"],
                rows[-1]["name"],
                rows[-1]["changePct"],
            )
    return result
