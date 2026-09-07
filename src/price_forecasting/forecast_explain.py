"""Plain-language AI-style explanations for part price forecasts.

Turns structured mediator + exposure signals into short sentences a
non-technical buyer can read. This is a deterministic narrative layer
(template AI), not a live LLM call — so demos stay offline and reproducible.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence


def _dir_word(direction: str) -> str:
    if direction == "up":
        return "pushing the price up"
    if direction == "down":
        return "pulling the price down"
    return "not moving the price much"


def _source_plain(is_real: bool, source: str) -> str:
    if is_real:
        return f"checked against a live/cached feed ({source})"
    return f"from an offline backup series ({source}) — verify before acting"


def _driver_plain(driver: Dict[str, object]) -> str:
    """One short sentence for a single driver."""
    label = str(driver.get("label") or "Market factor")
    direction = str(driver.get("direction") or "flat")
    evidence = str(driver.get("evidence") or "")
    is_real = bool(driver.get("isReal", False))
    source = str(driver.get("source") or "unknown")

    # Prefer a ready-made plain evidence line if present.
    if evidence and not any(c in evidence for c in ("=", "≈", "→")):
        base = evidence
    else:
        base = f"{label} is {_dir_word(direction)}."

    return f"{base} Source: {_source_plain(is_real, source)}."


def explain_part_forecast(
    *,
    part_name: str,
    category: str,
    change_pct: float,
    drivers: Sequence[Dict[str, object]],
    is_anomaly: bool = False,
    anomaly_type: str = "",
    confidence_level: str = "low",
) -> Dict[str, object]:
    """Build a simple AI-style reason block for one part.

    Returns:
        summary: 1–2 sentence headline a buyer can skim
        story: slightly longer plain-language explanation
        drivers: same drivers with plain ``evidence`` text
        tip: what to do next
    """
    abs_move = abs(float(change_pct))
    going_up = float(change_pct) >= 0
    move_word = "up" if going_up else "down"
    move_plain = (
        f"about {abs_move:.1f}% {move_word}"
        if abs_move >= 0.1
        else "almost flat"
    )

    name = part_name or "This part"
    cat = category or "this category"

    # Rank drivers that actually push/pull.
    active = [d for d in drivers if str(d.get("direction")) in ("up", "down")]
    active = sorted(active, key=lambda d: float(d.get("magnitude") or 0), reverse=True)

    if abs_move < 0.15 and not active:
        summary = (
            f"{name} is forecast nearly flat ({move_plain}). "
            "No strong market pressure stood out for this part."
        )
        story = (
            f"Over the forecast window, the model expects little change for this "
            f"{cat} part. That usually means costs and supply conditions look stable."
        )
    elif not active:
        summary = (
            f"{name} is forecast to go {move_word} ({move_plain}). "
            "The move is small relative to clear market drivers we can name."
        )
        story = (
            f"The model sees a modest {move_word} move for this {cat} part, but "
            "the main geo/commodity channels did not light up strongly for it. "
            "Treat the direction carefully if confidence is low."
        )
    else:
        top = active[0]
        top_label = str(top.get("label") or "a market factor")
        top_dir = str(top.get("direction") or "flat")
        same_way = (top_dir == "up" and going_up) or (top_dir == "down" and not going_up)

        if same_way:
            summary = (
                f"{name} is forecast to go {move_word} ({move_plain}), "
                f"mainly because of {top_label}."
            )
        else:
            summary = (
                f"{name} is forecast to go {move_word} ({move_plain}). "
                f"{top_label} is {_dir_word(top_dir)}, so other factors may also matter."
            )

        bits: List[str] = [
            f"Here is the simple story: this {cat} part is expected to move {move_plain}."
        ]
        for d in active[:3]:
            bits.append(_driver_plain(d))

        if len(active) > 1:
            second = active[1]
            bits.append(
                f"Next strongest factor: {second.get('label')} "
                f"({_dir_word(str(second.get('direction')))})."
            )

        story = " ".join(bits)

    if is_anomaly:
        break_name = (anomaly_type or "structural break").replace("_", " ")
        story += (
            f" Note: this part also has a known break ({break_name}), "
            "so the path may jump more than a normal part."
        )

    if confidence_level == "low":
        tip = (
            "Confidence is low — the predicted move is smaller than the model's "
            "usual error, so do not act on the direction alone."
        )
    elif confidence_level == "medium":
        tip = (
            "Confidence is medium — useful as a review flag, but double-check "
            "the top driver source before negotiating."
        )
    else:
        tip = (
            "Confidence is high — the move is large vs typical model error. "
            "Still verify any offline (fallback) data sources."
        )

    # Rewrite driver evidence into plain language for the UI.
    plain_drivers: List[Dict[str, object]] = []
    for d in drivers:
        plain = dict(d)
        direction = str(d.get("direction") or "flat")
        label = str(d.get("label") or "Factor")
        is_real = bool(d.get("isReal", False))
        source = str(d.get("source") or "unknown")
        plain["evidence"] = (
            f"{label} is {_dir_word(direction)}. "
            f"Source: {_source_plain(is_real, source)}."
        )
        plain_drivers.append(plain)

    return {
        "summary": summary,
        "story": story,
        "tip": tip,
        "drivers": plain_drivers,
        "causalityNote": (
            "Simple AI explanation from market channels and part exposure — "
            "a helpful guide, not proof of cause."
        ),
    }
