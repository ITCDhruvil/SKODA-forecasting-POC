"""Optional news / NLP severity layer feeding the same ``geo_events`` schema.

Phase 5 of the geopolitical framework. This is deliberately thin: a lexicon
scorer over event narratives (and optional GDELT-style headline CSV) that
writes ``nlp_severity`` onto the curated calendar. It does **not** invent a
parallel feature set — continuous indices and dated events remain the model
inputs; NLP only enriches severity when present.

Enable by placing a CSV at ``data/raw/geo_headlines.csv`` with columns
``event_id,headline,tone`` (tone in [-1, 1]) or by calling
:func:`enrich_events_with_nlp` which scores ``narrative`` text in-place.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Sequence

import pandas as pd

from .config import Config
from .geo_schema import GeoEvent, events_to_frame, frame_to_events
from .logging_utils import get_logger

logger = get_logger(__name__)

# Simple severity lexicon — illustrative, not a production NLP stack.
_SEVERITY_WEIGHTS: Dict[str, float] = {
    "invasion": 1.0,
    "war": 0.95,
    "attack": 0.85,
    "sanction": 0.8,
    "blockade": 0.8,
    "diversion": 0.55,
    "disruption": 0.5,
    "tariff": 0.45,
    "duty": 0.4,
    "tension": 0.35,
    "threat": 0.4,
    "agreement": 0.15,
    "phase": 0.1,
}


def score_narrative(text: str) -> float:
    """Map free text to a continuous severity in roughly [1, 5].

    Returns a value comparable to the ordinal ``severity`` field so it can
    substitute in event-decay features when present.
    """
    if not text:
        return 2.0
    tokens = text.lower().replace("/", " ").replace("-", " ").split()
    hits = [_SEVERITY_WEIGHTS[t] for t in tokens if t in _SEVERITY_WEIGHTS]
    if not hits:
        return 2.0
    # Blend max hit with mean; scale into 1..5
    raw = 0.6 * max(hits) + 0.4 * (sum(hits) / len(hits))
    return float(max(1.0, min(5.0, 1.0 + raw * 4.0)))


def load_headline_scores(path: Path) -> Dict[str, float]:
    """Optional external headlines CSV → ``{event_id: nlp_severity}``."""
    if not path.is_file():
        return {}
    frame = pd.read_csv(path)
    if "event_id" not in frame.columns:
        logger.warning("geo_headlines.csv missing event_id; ignored")
        return {}

    scores: Dict[str, float] = {}
    for event_id, group in frame.groupby("event_id"):
        if "tone" in group.columns:
            # GDELT-style tone is typically negative for conflict; invert & scale
            tone = float(group["tone"].mean())
            severity = max(1.0, min(5.0, 3.0 - tone * 2.0))
        else:
            headlines = " ".join(str(h) for h in group.get("headline", []))
            severity = score_narrative(headlines)
        scores[str(event_id)] = severity
    logger.info("loaded NLP severity for %d event(s) from %s", len(scores), path)
    return scores


def enrich_events_with_nlp(
    events: Sequence[GeoEvent],
    config: Config,
    headlines_filename: str = "geo_headlines.csv",
) -> List[GeoEvent]:
    """Attach ``nlp_severity`` from headlines file and/or narrative lexicon.

    Persists the enriched calendar back to ``geo_events.csv`` so subsequent
    stages see the same scores.
    """
    headline_scores = load_headline_scores(
        config.paths.data_raw / headlines_filename
    )
    enriched: List[GeoEvent] = []
    for event in events:
        nlp = headline_scores.get(event.event_id)
        if nlp is None:
            nlp = score_narrative(event.narrative)
        enriched.append(
            GeoEvent(
                event_id=event.event_id,
                date_start=event.date_start,
                date_end=event.date_end,
                category=event.category,
                severity=event.severity,
                region_scope=event.region_scope,
                channels_affected=event.channels_affected,
                source=event.source,
                confidence=event.confidence,
                narrative=event.narrative,
                nlp_severity=round(float(nlp), 3),
            )
        )

    out_path = config.paths.data_raw / config.geo.events_filename
    events_to_frame(enriched).to_csv(out_path, index=False)
    logger.info(
        "enriched %d geo event(s) with nlp_severity; wrote %s",
        len(enriched),
        out_path,
    )
    return enriched


def maybe_enrich_from_disk(config: Config) -> Optional[List[GeoEvent]]:
    """If a headlines file exists, re-load events and enrich; else None."""
    headlines = config.paths.data_raw / "geo_headlines.csv"
    events_path = config.paths.data_raw / config.geo.events_filename
    if not headlines.is_file() or not events_path.is_file():
        # Still score narratives so nlp_severity is never blank in demos
        if events_path.is_file():
            events = frame_to_events(pd.read_csv(events_path))
            if any(e.nlp_severity is None for e in events):
                return enrich_events_with_nlp(events, config)
        return None
    events = frame_to_events(pd.read_csv(events_path))
    return enrich_events_with_nlp(events, config)
