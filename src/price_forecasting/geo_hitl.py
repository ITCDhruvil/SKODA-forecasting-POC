"""Human-in-the-loop geopolitical alerts and forecast explanations.

Turns curated headlines and events into a review queue the analyst must
explicitly accept before any price impact is shown. Impact scenarios are
pre-computed offline (same model as :mod:`geo_scenario`) but the dashboard
only reveals them after the user confirms — nothing is auto-applied.

Also builds a driver-attribution report for the latest forecast month: which
mediators moved, in which direction, and whether each series came from a
verified cache or an offline fallback.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from .config import Config
from .geo_schema import GeoEvent, TRANSMISSION_CHANNELS
from .geo_scenario import _rollup_delta, _shift_prefixed_features
from .logging_utils import get_logger
from .modeling import GlobalXGBModel

logger = get_logger(__name__)

# Channel vocabulary -> feature prefixes shocked in counterfactuals.
_CHANNEL_PREFIXES: Dict[str, Tuple[str, ...]] = {
    "fx": ("fx_",),
    "freight": ("freight_", "chokepoint_"),
    "commodity:steel": ("cmd_steel_", "cmd_matched_"),
    "commodity:aluminium": ("cmd_aluminium_",),
    "commodity:copper": ("cmd_copper_",),
    "commodity:energy": ("cmd_",),
    "duty": ("geo_event_tariff",),
    "insurance": ("geo_event_", "chokepoint_"),
}

# Conflict / chokepoint events also move GPR and chokepoint proxies.
_CATEGORY_EXTRA_PREFIXES: Dict[str, Tuple[str, ...]] = {
    "conflict": ("gpr", "geo_event_conflict"),
    "chokepoint": ("chokepoint_", "geo_event_chokepoint", "freight_"),
    "tariff": ("geo_event_tariff",),
    "sanction": ("gpr", "geo_event_tariff"),
}


def _channel_prefixes(event: GeoEvent) -> Tuple[str, ...]:
    """Resolve feature prefixes to shock for one event."""
    prefixes: List[str] = []
    for channel in event.channels_affected:
        prefixes.extend(_CHANNEL_PREFIXES.get(channel, ()))
    prefixes.extend(_CATEGORY_EXTRA_PREFIXES.get(event.category, ()))
    # De-duplicate while preserving order.
    seen: set[str] = set()
    ordered: List[str] = []
    for prefix in prefixes:
        if prefix not in seen:
            seen.add(prefix)
            ordered.append(prefix)
    return tuple(ordered)


def _severity_shock_pct(event: GeoEvent) -> float:
    """Map curator severity to a counterfactual shock magnitude."""
    # Severity 1–5 → roughly +5% … +25% on affected channels.
    return float(event.severity) * 5.0


def verify_event_sources(
    event: GeoEvent,
    mediators: Sequence[Dict[str, object]],
) -> List[Dict[str, object]]:
    """Cross-check each transmission channel against live mediator provenance."""
    mediator_by_name = {str(m["name"]): m for m in mediators}
    rows: List[Dict[str, object]] = []

    for channel in event.channels_affected:
        if channel not in TRANSMISSION_CHANNELS:
            rows.append(
                {
                    "channel": channel,
                    "source": event.source,
                    "isVerified": False,
                    "note": "Channel not in controlled vocabulary.",
                }
            )
            continue

        mediator_key = None
        if channel == "freight":
            mediator_key = "freight"
        elif channel.startswith("commodity:"):
            mediator_key = channel.split(":", 1)[1]
        elif channel in ("fx",):
            mediator_key = None

        if mediator_key and mediator_key in mediator_by_name:
            med = mediator_by_name[mediator_key]
            is_real = bool(med.get("isReal"))
            rows.append(
                {
                    "channel": channel,
                    "source": str(med.get("source", "unknown")),
                    "isVerified": is_real,
                    "note": (
                        f"Mediator series cached from {med.get('source')} "
                        f"({med.get('totalMovePct', 0):+.1f}% over window)."
                        if is_real
                        else "Using offline fallback — verify against a live feed before acting."
                    ),
                }
            )
        elif channel == "duty":
            rows.append(
                {
                    "channel": channel,
                    "source": event.source,
                    "isVerified": event.confidence >= 0.8,
                    "note": (
                        "Duty step comes from the curated event calendar "
                        f"(confidence {event.confidence:.0%})."
                    ),
                }
            )
        else:
            rows.append(
                {
                    "channel": channel,
                    "source": event.source,
                    "isVerified": event.confidence >= 0.75,
                    "note": f"Event-sourced channel; curator confidence {event.confidence:.0%}.",
                }
            )

    if event.category in ("conflict", "chokepoint") and "gpr_overall" in mediator_by_name:
        gpr = mediator_by_name["gpr_overall"]
        rows.append(
            {
                "channel": "gpr",
                "source": str(gpr.get("source", "gpr-cache")),
                "isVerified": bool(gpr.get("isReal")),
                "note": (
                    f"GPR index moved {gpr.get('totalMovePct', 0):+.1f}% over the "
                    "observation window."
                ),
            }
        )

    return rows


def run_event_impact_scenario(
    event: GeoEvent,
    model: GlobalXGBModel,
    features: pd.DataFrame,
    config: Config,
    horizon: int,
) -> Dict[str, object]:
    """Estimate part-price impact if this event's channels were shocked today."""
    origin = features["month"].max()
    base_frame = features[features["month"] == origin].copy()
    if base_frame.empty:
        return {"available": False, "reason": "no feature rows at forecast origin"}

    if horizon not in model.models:
        horizon = max(model.models) if model.models else None
        if horizon is None:
            return {"available": False, "reason": "model has no trained horizons"}

    prefixes = _channel_prefixes(event)
    if not prefixes:
        return {"available": False, "reason": "no mappable transmission channels"}

    shock_pct = _severity_shock_pct(event)
    baseline_pred = model.predict(base_frame, horizon)
    baseline = pd.Series(baseline_pred, index=base_frame["part_id"].to_numpy())

    shocked_frame = base_frame.copy()
    for prefix in prefixes:
        shocked_frame = _shift_prefixed_features(shocked_frame, (prefix,), shock_pct)
    shocked_frame["price"] = base_frame["price"]
    shocked_pred = model.predict(shocked_frame, horizon)
    shocked = pd.Series(shocked_pred, index=base_frame["part_id"].to_numpy())

    meta_cols = [
        c for c in ("part_id", "project", "vendor", "category") if c in base_frame.columns
    ]
    meta = base_frame[meta_cols].drop_duplicates("part_id")
    by_level = _rollup_delta(baseline, shocked, meta)
    overall = float(
        ((shocked / baseline.replace(0, np.nan) - 1.0) * 100.0).mean(skipna=True)
    )
    direction = "up" if overall > 0.05 else "down" if overall < -0.05 else "flat"

    category_rows = by_level.get("category", [])
    top_up = sorted(category_rows, key=lambda r: r["priceChangePct"], reverse=True)[:3]
    top_down = sorted(category_rows, key=lambda r: r["priceChangePct"])[:3]

    # Plain-language mechanism chain for the analyst.
    channel_labels = ", ".join(event.channels_affected)
    explanation = (
        f"If {event.category.replace('_', ' ')} severity {event.severity}/5 materialises "
        f"through {channel_labels}, the model estimates a portfolio-wide "
        f"{overall:+.2f}% price move at horizon {horizon} month(s). "
    )
    if top_up:
        explanation += (
            f"Largest upward pressure: {top_up[0]['name']} ({top_up[0]['priceChangePct']:+.2f}%). "
        )
    if top_down and top_down[0]["priceChangePct"] < 0:
        explanation += (
            f"Largest downward pressure: {top_down[0]['name']} "
            f"({top_down[0]['priceChangePct']:+.2f}%)."
        )

    return {
        "available": True,
        "eventId": event.event_id,
        "shockPct": shock_pct,
        "horizonMonths": horizon,
        "overallPriceChangePct": round(overall, 4),
        "direction": direction,
        "channelsUsed": list(event.channels_affected),
        "prefixesShocked": list(prefixes),
        "byLevel": by_level,
        "byCategory": category_rows,
        "explanation": explanation.strip(),
        "causalityNote": (
            "Counterfactual shock on model features — association, not proof of "
            "causation. Treat as directional until confirmed on real PO history."
        ),
    }


def load_headline_alerts(config: Config) -> List[Dict[str, object]]:
    """Read headline rows that can surface as pending analyst alerts."""
    path = config.paths.data_raw / "geo_headlines.csv"
    if not path.is_file():
        return []
    frame = pd.read_csv(path)
    if "event_id" not in frame.columns or "headline" not in frame.columns:
        return []

    alerts: List[Dict[str, object]] = []
    for idx, row in frame.iterrows():
        reported = str(row.get("reported_at") or row.get("date") or "").strip()
        if not reported:
            # Demo-friendly default: stagger headlines across recent days.
            reported = (
                datetime.now(timezone.utc)
                .replace(hour=9 + int(idx) % 8, minute=15, second=0, microsecond=0)
                .isoformat(timespec="minutes")
            )
        alerts.append(
            {
                "headline": str(row["headline"]),
                "eventId": str(row["event_id"]),
                "reportedAt": reported,
                "tone": float(row["tone"]) if "tone" in row and pd.notna(row["tone"]) else None,
                "alertId": f"{row['event_id']}_{idx}",
            }
        )
    return alerts


def build_geo_alerts(
    events: Sequence[GeoEvent],
    mediators: Sequence[Dict[str, object]],
    model: GlobalXGBModel,
    features: pd.DataFrame,
    config: Config,
    horizon: int,
) -> List[Dict[str, object]]:
    """Assemble the human-in-the-loop alert queue with gated impact payloads."""
    events_by_id = {e.event_id: e for e in events}
    headline_rows = load_headline_alerts(config)
    if not headline_rows:
        # Fall back to one alert per curated event with a narrative.
        headline_rows = [
            {
                "alertId": e.event_id,
                "eventId": e.event_id,
                "headline": e.narrative or f"{e.category} event in {e.region_scope}",
                "reportedAt": f"{e.date_start}T09:00:00+00:00",
                "tone": e.nlp_severity,
            }
            for e in events
        ]

    alerts: List[Dict[str, object]] = []
    for row in headline_rows:
        event = events_by_id.get(str(row["eventId"]))
        if event is None:
            continue

        verifications = verify_event_sources(event, mediators)
        all_verified = all(v["isVerified"] for v in verifications) if verifications else False
        impact = run_event_impact_scenario(event, model, features, config, horizon)

        alerts.append(
            {
                "alertId": str(row["alertId"]),
                "headline": str(row["headline"]),
                "reportedAt": str(row["reportedAt"]),
                "eventId": event.event_id,
                "category": event.category,
                "severity": int(event.severity),
                "regionScope": event.region_scope,
                "narrative": event.narrative,
                "channelsAffected": list(event.channels_affected),
                "confidence": float(event.confidence),
                "source": event.source,
                "nlpSeverity": event.nlp_severity,
                "sourceVerifications": verifications,
                "allSourcesVerified": all_verified,
                "prompt": (
                    "This signal was reported recently. Do you want to see the "
                    "estimated impact on auto part prices?"
                ),
                # Pre-computed but UI must not render until the user confirms.
                "impact": impact,
            }
        )

    # Most recent headline first.
    alerts.sort(key=lambda a: str(a["reportedAt"]), reverse=True)
    logger.info("built %d human-in-the-loop geo alert(s)", len(alerts))
    return alerts


def explain_forecast_drivers(
    features: pd.DataFrame,
    panel: pd.DataFrame,
    mediators: Sequence[Dict[str, object]],
    config: Config,
) -> Dict[str, object]:
    """Explain why the latest forecast month moved vs the prior month.

    Compares month-over-month changes in the key geo/FX mediators exposed as
    model features and ranks them by absolute move. Each driver carries its
    data source so the analyst can verify before trusting the direction.
    """
    months = pd.DatetimeIndex(sorted(features["month"].unique()))
    if len(months) < 2:
        return {"available": False, "reason": "need at least two months"}

    current = months[-1]
    prior = months[-2]
    cur_row = features[features["month"] == current].iloc[0]
    prev_row = features[features["month"] == prior].iloc[0]

    mediator_lookup = {str(m["name"]): m for m in mediators}

    # Feature column -> human label + source key for provenance lookup.
    driver_specs = [
        ("freight_ret_1m", "Container freight (1m return)", "freight"),
        ("cmd_steel_ret_1m", "Steel benchmark (1m return)", "steel"),
        ("cmd_aluminium_ret_lag2_x_mat", "Aluminium × material intensity", "aluminium"),
        ("cmd_copper_ret_lag2_x_mat", "Copper × material intensity", "copper"),
        ("gpr_z_lag0", "Geopolitical risk index (z-score)", "gpr_overall"),
        ("fx_eurinr_ret_1m", "EUR/INR (1m return)", None),
        ("fx_usdinr_ret_1m", "USD/INR (1m return)", None),
        ("geo_event_tariff", "Tariff / duty step", None),
        ("chokepoint_lag0", "Shipping chokepoint intensity", "chokepoint"),
    ]

    drivers: List[Dict[str, object]] = []
    for col, label, source_key in driver_specs:
        if col not in features.columns:
            continue
        cur_val = float(cur_row[col]) if pd.notna(cur_row[col]) else 0.0
        prev_val = float(prev_row[col]) if pd.notna(prev_row[col]) else 0.0
        delta = cur_val - prev_val
        if abs(delta) < 1e-9:
            continue

        if source_key and source_key in mediator_lookup:
            med = mediator_lookup[source_key]
            source = str(med.get("source", "unknown"))
            is_real = bool(med.get("isReal"))
        elif col.startswith("fx_"):
            source = "ecb-cache"
            is_real = True
        else:
            source = "event-calendar"
            is_real = True

        direction = "up" if delta > 0 else "down"
        price_effect = "upward" if delta > 0 else "downward"
        drivers.append(
            {
                "id": col,
                "label": label,
                "direction": direction,
                "magnitude": round(abs(delta), 5),
                "currentValue": round(cur_val, 5),
                "priorValue": round(prev_val, 5),
                "source": source,
                "isReal": is_real,
                "explanation": (
                    f"{label} moved {delta:+.4f} from "
                    f"{prior.strftime('%b %Y')} to {current.strftime('%b %Y')}, "
                    f"implying {price_effect} price pressure through the "
                    f"{'verified' if is_real else 'offline-fallback'} {source} series."
                ),
            }
        )

    drivers.sort(key=lambda d: d["magnitude"], reverse=True)
    drivers = drivers[:8]

    # Portfolio price move for context.
    price_mom = None
    if "price" in panel.columns:
        cur_price = panel[panel["month"] == current]["price"].mean()
        prev_price = panel[panel["month"] == prior]["price"].mean()
        if prev_price and prev_price > 0:
            price_mom = float((cur_price / prev_price - 1.0) * 100.0)

    top = drivers[0] if drivers else None
    summary = (
        f"From {prior.strftime('%b %Y')} to {current.strftime('%b %Y')}, "
        + (
            f"average part prices moved {price_mom:+.2f}%. "
            if price_mom is not None
            else ""
        )
        + (
            f"The largest mediator move was {top['label']} ({top['direction']}). "
            if top
            else "No mediator features changed materially."
        )
        + "Sources are listed per driver — verify offline fallbacks before external use."
    )

    return {
        "available": bool(drivers),
        "periodLabel": f"{prior.strftime('%b %Y')} → {current.strftime('%b %Y')}",
        "portfolioMomPct": round(price_mom, 4) if price_mom is not None else None,
        "summary": summary,
        "drivers": drivers,
        "note": (
            "Drivers are month-over-month feature changes, not a formal SHAP "
            "decomposition. They show which verified inputs moved, not a "
            "guaranteed attribution of the forecast delta."
        ),
    }


def build_hitl_payload(
    events: Sequence[GeoEvent],
    mediators: Sequence[Dict[str, object]],
    model: GlobalXGBModel,
    features: pd.DataFrame,
    panel: pd.DataFrame,
    config: Config,
    horizon: int,
) -> Dict[str, object]:
    """Full human-in-the-loop block for ``geoAnalysis`` export."""
    alerts = build_geo_alerts(events, mediators, model, features, config, horizon)
    drivers = explain_forecast_drivers(features, panel, mediators, config)
    return {
        "available": bool(alerts) or drivers.get("available", False),
        "policy": (
            "Alerts surface recent geopolitical signals with source verification. "
            "Price impact is hidden until you explicitly confirm — the model does "
            "not auto-apply news to forecasts."
        ),
        "alerts": alerts,
        "forecastDrivers": drivers,
    }
