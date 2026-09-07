"""Canonical schema for geopolitical events and transmission channels.

Geopolitics rarely prices a part directly. It moves mediators (FX, freight,
commodities, duty), and mediator x exposure produces the part-level effect.
This module defines the shared vocabulary so event calendars, continuous
indices, scenarios and (later) NLP severity scores all land in the same shape.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import pandas as pd

# --------------------------------------------------------------------------- #
# Controlled vocabularies
# --------------------------------------------------------------------------- #

EVENT_CATEGORIES = (
    "conflict",
    "tariff",
    "chokepoint",
    "sanction",
    "trade_agreement",
    "other",
)

TRANSMISSION_CHANNELS = (
    "fx",
    "freight",
    "commodity:steel",
    "commodity:aluminium",
    "commodity:copper",
    "commodity:energy",
    "duty",
    "insurance",
)

REGION_SCOPES = (
    "GLOBAL",
    "EU-IN",
    "CN-EU",
    "CN-IN",
    "ME-GLOBAL",
    "UA-EU",
    "RED-SEA",
    "IN-DOMESTIC",
)

# Material / category → commodity channel used for exposure interactions.
MATERIAL_COMMODITY: Dict[str, str] = {
    "steel": "steel",
    "iron/friction": "steel",
    "aluminium": "aluminium",
    "aluminium/copper": "aluminium",
    "polymer": "energy",
    "copper/semiconductor": "copper",
    "LED/polycarbonate": "copper",
    "semiconductor": "copper",
}

CATEGORY_MATERIAL_INTENSITY: Dict[str, float] = {
    "FST": 0.90,
    "BDY": 0.95,
    "CHS": 0.85,
    "ITR": 0.45,
    "BRK": 0.70,
    "PWT": 0.75,
    "HVC": 0.65,
    "ELC": 0.40,
    "LGT": 0.25,
    "SNS": 0.20,
}


@dataclass
class GeoEvent:
    """One dated geopolitical / trade event.

    Attributes:
        event_id: Stable identifier.
        date_start: Inclusive start (month-precision is fine for this POC).
        date_end: Inclusive end; None means open-ended / permanent step.
        category: One of :data:`EVENT_CATEGORIES`.
        severity: Ordinal 1-5 (5 = extreme).
        region_scope: One of :data:`REGION_SCOPES` or a free corridor tag.
        channels_affected: Transmission channels this event is expected to move.
        source: Provenance label (manual calendar, GPR spike, GDELT, ...).
        confidence: 0-1 curator confidence.
        narrative: Short human-readable description.
        nlp_severity: Optional continuous score from a news layer (Phase 5).
    """

    event_id: str
    date_start: str
    date_end: Optional[str]
    category: str
    severity: int
    region_scope: str
    channels_affected: Tuple[str, ...]
    source: str
    confidence: float = 1.0
    narrative: str = ""
    nlp_severity: Optional[float] = None

    def as_dict(self) -> Dict[str, object]:
        payload = asdict(self)
        payload["channels_affected"] = list(self.channels_affected)
        return payload


def validate_event(event: GeoEvent) -> None:
    """Raise ``ValueError`` if an event violates the controlled vocabularies."""
    if event.category not in EVENT_CATEGORIES:
        raise ValueError(
            f"unknown category '{event.category}'; expected one of {EVENT_CATEGORIES}"
        )
    if not 1 <= int(event.severity) <= 5:
        raise ValueError(f"severity must be in 1..5, got {event.severity}")
    if not 0.0 <= float(event.confidence) <= 1.0:
        raise ValueError(f"confidence must be in [0, 1], got {event.confidence}")
    for channel in event.channels_affected:
        if channel not in TRANSMISSION_CHANNELS:
            raise ValueError(
                f"unknown channel '{channel}'; expected one of {TRANSMISSION_CHANNELS}"
            )


def events_to_frame(events: Sequence[GeoEvent]) -> pd.DataFrame:
    """Serialise events to a DataFrame suitable for ``geo_events.csv``."""
    rows = []
    for event in events:
        validate_event(event)
        rows.append(
            {
                "event_id": event.event_id,
                "date_start": event.date_start,
                "date_end": event.date_end or "",
                "category": event.category,
                "severity": int(event.severity),
                "region_scope": event.region_scope,
                "channels_affected": "|".join(event.channels_affected),
                "source": event.source,
                "confidence": float(event.confidence),
                "narrative": event.narrative,
                "nlp_severity": (
                    "" if event.nlp_severity is None else float(event.nlp_severity)
                ),
            }
        )
    return pd.DataFrame(rows)


def frame_to_events(frame: pd.DataFrame) -> List[GeoEvent]:
    """Parse a ``geo_events`` table into typed events."""
    events: List[GeoEvent] = []
    for record in frame.to_dict("records"):
        channels_raw = str(record.get("channels_affected") or "")
        channels = tuple(c for c in channels_raw.split("|") if c)
        nlp_raw = record.get("nlp_severity", "")
        nlp_severity = None
        if nlp_raw not in ("", None) and not (isinstance(nlp_raw, float) and pd.isna(nlp_raw)):
            nlp_severity = float(nlp_raw)
        end_raw = record.get("date_end", "")
        date_end = None if end_raw in ("", None) or (isinstance(end_raw, float) and pd.isna(end_raw)) else str(end_raw)[:10]

        event = GeoEvent(
            event_id=str(record["event_id"]),
            date_start=str(record["date_start"])[:10],
            date_end=date_end,
            category=str(record["category"]),
            severity=int(record["severity"]),
            region_scope=str(record["region_scope"]),
            channels_affected=channels,
            source=str(record.get("source") or "manual"),
            confidence=float(record.get("confidence") or 1.0),
            narrative=str(record.get("narrative") or ""),
            nlp_severity=nlp_severity,
        )
        validate_event(event)
        events.append(event)
    return events


def framework_summary() -> Dict[str, object]:
    """Compact description for dashboards and reports."""
    return {
        "layers": [
            {
                "id": "events",
                "name": "Geopolitical layer",
                "items": list(EVENT_CATEGORIES),
            },
            {
                "id": "channels",
                "name": "Transmission channels",
                "items": list(TRANSMISSION_CHANNELS),
            },
            {
                "id": "exposure",
                "name": "Exposure layer",
                "items": [
                    "import_dependency",
                    "material_intensity",
                    "localisation",
                    "sourcing_corridor",
                ],
            },
            {
                "id": "price",
                "name": "Price target",
                "items": ["part_monthly_inr"],
            },
        ],
        "claim": (
            "Geopolitics moves mediators; mediator x exposure produces the "
            "part-level price effect. A lone geo regressor without channels "
            "is not a mechanism."
        ),
        "causalityNote": (
            "Observational monthly data supports association and "
            "channel-consistent identification, not RCT-grade causality."
        ),
    }
