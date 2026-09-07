# Reasoning Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-built forecast-reason narrative with a model-attribution engine (XGBoost TreeSHAP), add quantile prediction intervals, and collapse the reasoning UI into one shared component plus a de-cluttered Geo tab.

**Architecture:** A new `attribution.py` runs native TreeSHAP on the shipped XGBoost boosters, groups per-feature contributions into eight human-readable buckets that sum back to the predicted move, and writes `data/processed/attribution.parquet`. `forecast_explain.py` shrinks to deterministic templating over those buckets. `export.py` and `geo_hitl.py` read the parquet instead of re-deriving drivers. `GlobalXGBModel` gains an optional quantile-regression interval head. The React app renders every reason surface through one `<ReasonBlock>` + `<ConfidenceHint>`, and the Geo tab folds its five diagnostic cards into one `<details>` disclosure.

**Tech Stack:** Python 3, xgboost 3.2.0 (native `pred_contribs` TreeSHAP + `reg:quantileerror`), pandas 2.3, pytest; React 18 + TypeScript + Tailwind, Recharts, Vite.

**Spec:** `docs/superpowers/specs/2026-09-07-reasoning-simplification-design.md`

## Global Constraints

- No new Python dependency. TreeSHAP via `booster.predict(dmatrix, pred_contribs=True)`; quantiles via `XGBRegressor(objective="reg:quantileerror", quantile_alpha=[...])`. xgboost pinned `==3.2.0` (`requirements.txt`), floor `>=2.0` (`pyproject.toml`).
- No hardcoded figures in the dashboard UI — every number rendered comes from `dashboard.json`.
- All numeric values in the `reason` payload are pre-rounded in Python: `sizePct` 1 dp, `sizeInr` 0 dp, `trust` ratio 1 dp, `changePct` 3 dp (matches existing `_round(change, 3)`).
- Reason payload MUST NOT contain the keys `summary`, `story`, `tip`, `causalityNote`. The causality disclaimer is a static UI constant.
- Config keys are exact-match (`config._build` rejects unknown AND missing keys) — every new dataclass field needs the same key added to `config.yaml`.
- `forecast_explain.py` stays deterministic and offline (no LLM call) — it is template text only.
- Frontend has no test runner; frontend tasks are verified by `tsc` (`npm run build`) and manual preview only.
- Commit after every task. Conventional Commit prefixes (`feat:`, `refactor:`, `test:`, `chore:`).

---

## File Structure

**Python — new**
- `src/price_forecasting/attribution.py` — feature→bucket map, `explain_forecasts()`, `save_attribution()`, `load_attribution()`. One responsibility: forecast → reconciling bucket breakdown.
- `tests/test_attribution.py` — reconciliation, bucket coverage, edge cases, determinism.

**Python — modified**
- `src/price_forecasting/forecast_explain.py` — full rewrite: `build_reason()` + `build_portfolio_reason()`, templating only (~175 → ~90 lines).
- `src/price_forecasting/export.py` — `_reason_for_part` gutted to a parquet lookup + `build_reason` call; heuristic driver code deleted.
- `src/price_forecasting/geo_hitl.py` — `explain_forecast_drivers` re-expressed on top of attribution buckets via `build_portfolio_reason`.
- `src/price_forecasting/modeling.py` — `GlobalXGBModel` gains `interval_models` + `predict_interval()`; `train_global_xgboost` fits a quantile head when enabled.
- `src/price_forecasting/forecasting.py` — computes + saves attribution; xgboost rows get quantile bands.
- `src/price_forecasting/evaluation.py` — coverage report handles quantile bands; `extrapolate_intervals` kept as fallback.
- `src/price_forecasting/config.py` + `config.yaml` — `modeling.interval_mode`, `modeling.interval_quantiles`.
- `tests/test_smoke.py` — schema assertions for the new `reason` shape + quantile band sanity.

**Frontend — new**
- `dashboard/src/components/reason/ReasonBlock.tsx` — renders the reason payload, `variant: "part" | "portfolio"`.
- `dashboard/src/components/reason/ConfidenceHint.tsx` — trust line + level pill, single source of confidence wording.

**Frontend — modified**
- `dashboard/src/types.ts` — new `ReasonDriver` / `Reason` types; `TreePart.reason`, `GeoHitlBlock.forecastDrivers`.
- `dashboard/src/components/DrillDownTree.tsx` — PartRow uses `<ReasonBlock>`; drop the duplicated confidence paragraph.
- `dashboard/src/components/GeoHitlPanel.tsx` — "Why prices moved" block uses `<ReasonBlock variant="portfolio">`.
- `dashboard/src/components/GeoScenarioPanel.tsx` — 7 cards → 3, diagnostics behind `<details>`.
- `dashboard/src/components/FaqPanel.tsx` — intervals answer rewrite; confidence answer references shared wording.
- `dashboard/src/App.tsx` — `TITLES.geo.subtitle` de-jargoned.

---

## Task 1: Bucket map + attribution core

**Files:**
- Create: `src/price_forecasting/attribution.py`
- Test: `tests/test_attribution.py`

**Interfaces:**
- Consumes: `GlobalXGBModel` from `modeling.py` (fields `models: Dict[int, XGBRegressor]`, `feature_columns: List[str]`, `target_mode: str`, method `align_categories(frame)`).
- Produces:
  - `BUCKETS: list[tuple[str, str, Callable[[str], bool]]]` — ordered `(bucket_name, group, predicate)`; `group` ∈ `{"external", "starting_point"}`.
  - `bucket_for(feature: str) -> tuple[str, str]` — returns `(bucket_name, group)`; raises `KeyError` if unmapped.
  - `explain_forecasts(model: GlobalXGBModel, origin_rows: pd.DataFrame, horizon: int) -> pd.DataFrame` — columns: `part_id, bucket, group, contrib_logret, contrib_pct, contrib_inr, direction`. One row per (part, bucket) that has a non-zero contribution, plus always the two starting-point buckets. `direction` ∈ `{"up","down","flat"}`. Parts whose `horizon` model is missing are simply absent from the frame.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_attribution.py
import numpy as np
import pandas as pd
import pytest

from price_forecasting import attribution
from price_forecasting.config import load_config
from price_forecasting.preprocessing import get_feature_columns


def _tiny_model(feature_columns):
    """A 1-horizon GlobalXGBModel trained on trivial data, target_mode='level'."""
    from xgboost import XGBRegressor
    from price_forecasting.modeling import GlobalXGBModel

    rng = np.random.default_rng(0)
    X = pd.DataFrame(rng.normal(size=(200, len(feature_columns))), columns=feature_columns)
    y = X.iloc[:, 0] * 2.0 + rng.normal(scale=0.1, size=200)
    reg = XGBRegressor(n_estimators=30, max_depth=3, random_state=0)
    reg.fit(X, y)
    m = GlobalXGBModel(feature_columns=list(feature_columns), target_mode="level")
    m.models[1] = reg
    return m, X


def test_every_feature_column_maps_to_exactly_one_bucket():
    frame = pd.read_parquet("data/processed/features.parquet")
    cols = get_feature_columns(frame)
    assert cols, "no feature columns resolved"
    for col in cols:
        name, group = attribution.bucket_for(col)  # must not raise
        assert group in ("external", "starting_point")


def test_contributions_reconcile_to_prediction():
    frame = pd.read_parquet("data/processed/features.parquet")
    cols = [c for c in get_feature_columns(frame) if frame[c].dtype != "category"]
    model, X = _tiny_model(cols)
    origin = X.head(10).copy()
    origin["part_id"] = [f"P{i}" for i in range(10)]
    origin["price"] = 100.0

    out = attribution.explain_forecasts(model, origin, horizon=1)
    raw = model.models[1].predict(origin[cols])
    for i, pid in enumerate(origin["part_id"]):
        got = out.loc[out.part_id == pid, "contrib_logret"].sum()
        # level mode: contrib_logret holds the raw margin contributions incl. bias
        assert got == pytest.approx(float(raw[i]), abs=1e-4)


def test_missing_horizon_yields_empty_frame():
    frame = pd.read_parquet("data/processed/features.parquet")
    cols = [c for c in get_feature_columns(frame) if frame[c].dtype != "category"]
    model, X = _tiny_model(cols)
    origin = X.head(3).copy()
    origin["part_id"] = ["A", "B", "C"]
    origin["price"] = 100.0
    out = attribution.explain_forecasts(model, origin, horizon=6)
    assert out.empty
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_attribution.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'price_forecasting.attribution'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/price_forecasting/attribution.py
"""Model feature attribution -> human-readable driver buckets.

Runs native TreeSHAP (``pred_contribs``) on the shipped XGBoost boosters and
groups per-feature contributions into eight buckets whose signed sizes add
back up to the forecasted move. The reason the dashboard shows is therefore
the forecast, decomposed - it cannot disagree with the number.
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable, List, Tuple

import numpy as np
import pandas as pd

from .logging_utils import get_logger

logger = get_logger(__name__)

_FLAT_EPS = 0.05  # % move below which a bucket direction is "flat"

# Ordered (bucket, group, predicate). First match wins.
BUCKETS: List[Tuple[str, str, Callable[[str], bool]]] = [
    ("FX", "external", lambda c: c.startswith(("fx_eurinr", "fx_usdinr"))),
    ("Sector inflation", "external", lambda c: c.startswith("macro_")),
    ("Freight", "external", lambda c: c.startswith("freight_")),
    ("Material costs", "external",
     lambda c: c.startswith(("cmd_", "material_intensity"))),
    ("Geopolitics", "external",
     lambda c: c.startswith(("gpr_", "chokepoint_", "geo_event_"))),
    ("Seasonality", "external",
     lambda c: c in ("month_sin", "month_cos", "month_of_year")),
    ("Recent trend", "starting_point",
     lambda c: c.startswith(("price_lag_", "price_roll_", "price_mom", "price_yoy",
                             "price_expanding", "price_vs_expanding"))
     or c == "months_since_start"),
]
_STRUCTURAL = ("Part / vendor structural", "starting_point")

STARTING_POINT_BUCKETS = ("Recent trend", "Part / vendor structural")
EXTERNAL_BUCKETS = tuple(b for b, g, _ in BUCKETS if g == "external")


def bucket_for(feature: str) -> Tuple[str, str]:
    """Map a raw feature column to ``(bucket_name, group)``.

    Anything not matched by an explicit rule (hierarchy encodings, raw
    categoricals, part characteristics) falls into the structural bucket.
    """
    for name, group, pred in BUCKETS:
        if pred(feature):
            return name, group
    return _STRUCTURAL


def explain_forecasts(
    model: "GlobalXGBModel",  # noqa: F821 - avoid import cycle
    origin_rows: pd.DataFrame,
    horizon: int,
) -> pd.DataFrame:
    """Decompose the horizon-``horizon`` XGBoost forecast per part into buckets.

    Returns a tidy frame: ``part_id, bucket, group, contrib_logret,
    contrib_pct, contrib_inr, direction``. Empty if that horizon was not
    trained.
    """
    if horizon not in getattr(model, "models", {}):
        return pd.DataFrame(
            columns=["part_id", "bucket", "group", "contrib_logret",
                     "contrib_pct", "contrib_inr", "direction"]
        )

    cols = list(model.feature_columns)
    aligned = model.align_categories(origin_rows)
    booster = model.models[horizon].get_booster()

    import xgboost as xgb

    dm = xgb.DMatrix(aligned[cols], enable_categorical=True)
    contribs = booster.predict(dm, pred_contribs=True)  # (n_parts, n_features + 1)

    part_ids = origin_rows["part_id"].to_numpy()
    prices = origin_rows["price"].to_numpy(dtype=float)
    feat_names = cols + ["__bias__"]

    # feature index -> (bucket, group)
    fb = [bucket_for(f) if f != "__bias__" else _STRUCTURAL for f in feat_names]

    rows = []
    for i, pid in enumerate(part_ids):
        # Sum contributions per bucket (log-return / margin units).
        agg: dict[tuple[str, str], float] = {}
        for j, (bucket, group) in enumerate(fb):
            agg[(bucket, group)] = agg.get((bucket, group), 0.0) + float(contribs[i, j])
        # Guarantee both starting-point buckets always exist.
        for b in STARTING_POINT_BUCKETS:
            agg.setdefault((b, "starting_point"), 0.0)

        total_logret = sum(agg.values())
        for (bucket, group), v in agg.items():
            # Convert this bucket's share to % and INR of the total move.
            if model.target_mode == "level":
                contrib_pct = np.nan
                contrib_inr = np.nan
            else:
                move_frac = np.expm1(np.clip(total_logret, -0.7, 0.7))
                share = (v / total_logret) if abs(total_logret) > 1e-9 else 0.0
                contrib_pct = round(move_frac * 100.0 * share, 1)
                contrib_inr = round(prices[i] * move_frac * share, 0)
            direction = (
                "up" if (contrib_pct or 0) > _FLAT_EPS
                else "down" if (contrib_pct or 0) < -_FLAT_EPS
                else "flat"
            )
            rows.append({
                "part_id": pid, "bucket": bucket, "group": group,
                "contrib_logret": round(float(v), 6),
                "contrib_pct": contrib_pct, "contrib_inr": contrib_inr,
                "direction": direction,
            })

    out = pd.DataFrame(rows)
    _assert_reconciles(model, aligned[cols], horizon, out, part_ids)
    return out


def _assert_reconciles(model, feat_frame, horizon, out, part_ids) -> None:
    """Bucket sums (margin units) must equal the raw booster output per part."""
    raw = model.models[horizon].predict(feat_frame)
    by_part = out.groupby("part_id")["contrib_logret"].sum()
    for i, pid in enumerate(part_ids):
        got = float(by_part.get(pid, 0.0))
        if abs(got - float(raw[i])) > 1e-3:
            logger.warning(
                "attribution does not reconcile for %s: buckets=%.5f raw=%.5f",
                pid, got, float(raw[i]),
            )


def save_attribution(path: Path, frame: pd.DataFrame) -> Path:
    """Persist the attribution frame next to the other processed artifacts."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        frame.to_parquet(path, index=False)
    except (ImportError, ValueError):
        path = path.with_suffix(".csv")
        frame.to_csv(path, index=False)
    logger.info("wrote attribution for %d parts to %s",
                frame["part_id"].nunique() if not frame.empty else 0, path)
    return path


def load_attribution(path: Path) -> pd.DataFrame:
    """Read back the attribution frame; empty frame if absent."""
    for p in (path, path.with_suffix(".csv")):
        if p.is_file():
            return pd.read_parquet(p) if p.suffix == ".parquet" else pd.read_csv(p)
    return pd.DataFrame(
        columns=["part_id", "bucket", "group", "contrib_logret",
                 "contrib_pct", "contrib_inr", "direction"]
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_attribution.py -q`
Expected: PASS (3 tests). If `features.parquet` is absent, first run `python -m price_forecasting.pipeline --stage preprocess`.

- [ ] **Step 5: Commit**

```bash
git add src/price_forecasting/attribution.py tests/test_attribution.py
git commit -m "feat: add model-attribution bucket engine"
```

---

## Task 2: Persist attribution from the forecast stage

**Files:**
- Modify: `src/price_forecasting/forecasting.py:68-95` (inside `generate_forward_forecasts`, the XGBoost block)
- Modify: `src/price_forecasting/forecasting.py` imports
- Test: `tests/test_attribution.py` (append)

**Interfaces:**
- Consumes: `attribution.explain_forecasts`, `attribution.save_attribution` (Task 1); `config.paths.data_processed` (a `Path`).
- Produces: file `data/processed/attribution.parquet` written during `--stage forecast` / `--stage all`, for the max trained horizon only.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_attribution.py  (append)
def test_forecast_stage_writes_attribution_parquet(tmp_path):
    import subprocess, sys, json, os
    from price_forecasting.attribution import load_attribution
    from price_forecasting.config import load_config

    cfg = load_config("config.yaml")
    path = cfg.paths.data_processed / "attribution.parquet"
    if path.exists():
        path.unlink()
    subprocess.run(
        [sys.executable, "-m", "price_forecasting.pipeline", "--stage", "forecast"],
        check=True, env={**os.environ, "PYTHONPATH": "src"},
    )
    df = load_attribution(path)
    assert not df.empty
    assert set(df.columns) >= {"part_id", "bucket", "group", "contrib_logret"}
    # structural buckets present for every part
    per_part = df.groupby("part_id")["bucket"].agg(set)
    assert all("Recent trend" in s and "Part / vendor structural" in s
               for s in per_part)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_attribution.py::test_forecast_stage_writes_attribution_parquet -q`
Expected: FAIL — file not written / `df.empty`.

- [ ] **Step 3: Write minimal implementation**

In `forecasting.py`, add import near the top:

```python
from . import attribution
```

Inside `generate_forward_forecasts`, immediately after the `for h in horizons:` XGBoost loop that appends prediction frames (right before the `# --- Per-part SARIMA` comment, ~line 96), insert:

```python
    # --- Model attribution for the shipped (max) horizon -------------------
    shipped_h = max(xgb_model.models) if xgb_model.models else None
    if shipped_h is not None:
        attrib = attribution.explain_forecasts(xgb_model, origin_rows, shipped_h)
        attribution.save_attribution(
            config.paths.data_processed / "attribution.parquet", attrib
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_attribution.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/price_forecasting/forecasting.py tests/test_attribution.py
git commit -m "feat: write attribution.parquet during forecast stage"
```

---

## Task 3: Rewrite `forecast_explain.py` as bucket templating

**Files:**
- Modify (full rewrite): `src/price_forecasting/forecast_explain.py`
- Test: `tests/test_forecast_explain.py` (new)

**Interfaces:**
- Consumes: bucket rows shaped like `attribution.explain_forecasts` output, filtered to one part: a list of dicts with `bucket, group, contrib_pct, contrib_inr, direction`.
- Produces:
  - `build_reason(*, change_pct: float, change_inr: float, direction: str, buckets: list[dict], trust_level: str, expected_error_ratio: float, available: bool = True) -> dict` — returns the payload in Spec §3 (`available, headline, direction, changePct, changeInr, drivers, startingPoint, trust, breakdown, sourcesNote`). `drivers[i]` = `{bucket, direction, sizePct, sizeInr, weight, sourcesVerified}`.
  - `build_portfolio_reason(*, period_label: str, portfolio_mom_pct: float | None, buckets: list[dict]) -> dict` — same shape minus `trust`, plus `periodLabel`, `portfolioMomPct`.
  - `CAUSALITY_NOTE: str` — module constant (not per-part).
- Each `bucket` dict passed in may carry `sources_verified: bool` (defaults `True` when absent).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_forecast_explain.py
from price_forecasting.forecast_explain import build_reason, build_portfolio_reason


def _b(bucket, group, pct, inr, direction, sources_verified=True):
    return {"bucket": bucket, "group": group, "contrib_pct": pct,
            "contrib_inr": inr, "direction": direction,
            "sources_verified": sources_verified}


def test_headline_names_top_external_bucket():
    buckets = [
        _b("Geopolitics", "external", 6.1, 244, "up"),
        _b("Freight", "external", -1.8, -72, "down", sources_verified=False),
        _b("Recent trend", "starting_point", 4.0, 160, "up"),
        _b("Part / vendor structural", "starting_point", 1.6, 63, "up"),
    ]
    r = build_reason(change_pct=9.9, change_inr=395, direction="up",
                     buckets=buckets, trust_level="high", expected_error_ratio=3.3)
    assert r["available"] is True
    assert "Geopolitics" in r["headline"]
    assert [d["bucket"] for d in r["drivers"]] == ["Geopolitics", "Freight"]
    assert r["drivers"][0]["weight"] in ("large", "medium", "small")
    assert r["startingPoint"].lower().startswith("mostly carryover")
    assert "backup data" in r["sourcesNote"]
    # breakdown reconciles to change_pct within rounding
    assert abs(sum(x["sizePct"] for x in r["breakdown"]) - 9.9) < 0.6
    for k in ("summary", "story", "tip", "causalityNote"):
        assert k not in r


def test_tiny_move_is_flat_with_no_drivers():
    r = build_reason(change_pct=0.05, change_inr=2, direction="flat",
                     buckets=[_b("Recent trend", "starting_point", 0.03, 1, "flat"),
                              _b("Part / vendor structural", "starting_point", 0.02, 1, "flat")],
                     trust_level="low", expected_error_ratio=0.1)
    assert r["headline"] == "Forecast roughly flat."
    assert r["drivers"] == []


def test_unavailable_passthrough():
    r = build_reason(change_pct=0.0, change_inr=0, direction="flat", buckets=[],
                     trust_level="low", expected_error_ratio=0.0, available=False)
    assert r["available"] is False
    assert "trend and seasonality projection only" in r["headline"]


def test_portfolio_reason_has_no_trust():
    r = build_portfolio_reason(
        period_label="May 2026 to Jun 2026", portfolio_mom_pct=0.84,
        buckets=[_b("Geopolitics", "external", -0.5, -20, "down"),
                 _b("Recent trend", "starting_point", 0.9, 36, "up"),
                 _b("Part / vendor structural", "starting_point", 0.4, 16, "up")])
    assert "trust" not in r
    assert r["periodLabel"] == "May 2026 to Jun 2026"
    assert r["drivers"][0]["bucket"] == "Geopolitics"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_forecast_explain.py -q`
Expected: FAIL — `ImportError: cannot import name 'build_reason'`.

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `src/price_forecasting/forecast_explain.py`:

```python
"""Plain-language forecast reasons, built from model attribution buckets.

Deterministic template text only - no LLM call, so demos stay offline and
reproducible. Input is the per-bucket contribution breakdown from
``attribution.explain_forecasts``; output is the ``reason`` payload the
dashboard renders (Spec section 3).
"""
from __future__ import annotations

from typing import Dict, List, Optional

CAUSALITY_NOTE = (
    "Reasons are the model's own forecast, split by input - a guide to what "
    "moved the number, not proof of cause."
)

_STARTING = ("Recent trend", "Part / vendor structural")


def _weight(abs_pct: float, ranked_abs: List[float]) -> str:
    """large / medium / small by tertile of this part's bucket magnitudes."""
    if not ranked_abs:
        return "small"
    hi = ranked_abs[0]
    if hi <= 0:
        return "small"
    frac = abs_pct / hi
    return "large" if frac >= 0.66 else "medium" if frac >= 0.33 else "small"


def _external(buckets: List[Dict]) -> List[Dict]:
    ext = [b for b in buckets if b.get("group") == "external"
           and b.get("direction") in ("up", "down")]
    ext.sort(key=lambda b: abs(float(b.get("contrib_pct") or 0)), reverse=True)
    return ext[:3]


def _starting_line(buckets: List[Dict], overall_direction: str) -> str:
    net = sum(float(b.get("contrib_pct") or 0)
              for b in buckets if b.get("bucket") in _STARTING)
    ext_net = sum(abs(float(b.get("contrib_pct") or 0))
                  for b in buckets if b.get("group") == "external")
    if abs(net) >= ext_net and abs(net) > 0.15:
        way = "upward" if net > 0 else "downward"
        return f"Mostly carryover from an existing {way} trend."
    return "Starting point contributes little; the move is driven by the factors above."


def _sources_note(drivers: List[Dict]) -> str:
    backup = [d for d in drivers if not d["sourcesVerified"]]
    if not backup:
        return "All external drivers use verified sources."
    names = ", ".join(d["bucket"].lower() for d in backup)
    return (f"{len(backup)} of {len(drivers)} external drivers use backup data - "
            f"verify {names} before acting.")


def _driver_rows(ext: List[Dict]) -> List[Dict]:
    ranked = sorted((abs(float(b.get("contrib_pct") or 0)) for b in ext), reverse=True)
    rows = []
    for b in ext:
        pct = round(float(b.get("contrib_pct") or 0), 1)
        rows.append({
            "bucket": b["bucket"],
            "direction": b["direction"],
            "sizePct": pct,
            "sizeInr": round(float(b.get("contrib_inr") or 0)),
            "weight": _weight(abs(pct), ranked),
            "sourcesVerified": bool(b.get("sources_verified", True)),
        })
    return rows


def _breakdown(buckets: List[Dict]) -> List[Dict]:
    return [{"bucket": b["bucket"], "sizePct": round(float(b.get("contrib_pct") or 0), 1)}
            for b in sorted(buckets,
                            key=lambda x: abs(float(x.get("contrib_pct") or 0)),
                            reverse=True)]


def _trust_line(level: str, ratio: float) -> str:
    r = round(float(ratio), 1)
    if level == "high":
        return f"Move is {r}x the model's typical error - direction is worth acting on."
    if level == "medium":
        return f"Move is about {r}x the model's typical error - treat as a soft signal."
    return "Move sits inside the model's typical error - do not act on the direction."


def build_reason(
    *,
    change_pct: float,
    change_inr: float,
    direction: str,
    buckets: List[Dict],
    trust_level: str,
    expected_error_ratio: float,
    available: bool = True,
) -> Dict[str, object]:
    if not available:
        return {
            "available": False,
            "headline": ("Not enough history for a driver breakdown - this forecast "
                         "is a trend and seasonality projection only."),
            "direction": direction,
            "changePct": round(float(change_pct), 3),
            "changeInr": round(float(change_inr)),
            "drivers": [], "startingPoint": "", "trust": None,
            "breakdown": [], "sourcesNote": "",
        }

    if abs(float(change_pct)) < 0.15:
        return {
            "available": True, "headline": "Forecast roughly flat.",
            "direction": "flat", "changePct": round(float(change_pct), 3),
            "changeInr": round(float(change_inr)), "drivers": [],
            "startingPoint": "", "trust": {
                "level": trust_level,
                "line": _trust_line(trust_level, expected_error_ratio),
            },
            "breakdown": _breakdown(buckets), "sourcesNote": "",
        }

    ext = _external(buckets)
    drivers = _driver_rows(ext)
    arrow = "+" if float(change_pct) >= 0 else ""
    if drivers:
        lead = " and ".join(d["bucket"].lower() for d in drivers[:2])
        headline = (f"Forecast {arrow}{round(float(change_pct), 1)}% "
                    f"({arrow}₹{round(float(change_inr))}). Mostly {lead}.")
    else:
        headline = (f"Forecast {arrow}{round(float(change_pct), 1)}% "
                    f"({arrow}₹{round(float(change_inr))}). No single external "
                    "factor stands out.")
    return {
        "available": True,
        "headline": headline,
        "direction": direction,
        "changePct": round(float(change_pct), 3),
        "changeInr": round(float(change_inr)),
        "drivers": drivers,
        "startingPoint": _starting_line(buckets, direction),
        "trust": {"level": trust_level,
                  "line": _trust_line(trust_level, expected_error_ratio)},
        "breakdown": _breakdown(buckets),
        "sourcesNote": _sources_note(drivers) if drivers else "",
    }


def build_portfolio_reason(
    *,
    period_label: str,
    portfolio_mom_pct: Optional[float],
    buckets: List[Dict],
) -> Dict[str, object]:
    ext = _external(buckets)
    drivers = _driver_rows(ext)
    mom = portfolio_mom_pct
    lead = " and ".join(d["bucket"].lower() for d in drivers[:2]) if drivers else "no single factor"
    headline = (
        f"{period_label}: portfolio "
        + (f"{'+' if (mom or 0) >= 0 else ''}{round(mom, 1)}%. " if mom is not None else "")
        + f"Mostly {lead}."
    )
    return {
        "available": bool(drivers) or portfolio_mom_pct is not None,
        "headline": headline,
        "periodLabel": period_label,
        "portfolioMomPct": round(mom, 3) if mom is not None else None,
        "direction": "up" if (mom or 0) >= 0 else "down",
        "drivers": drivers,
        "startingPoint": _starting_line(buckets, "up" if (mom or 0) >= 0 else "down"),
        "breakdown": _breakdown(buckets),
        "sourcesNote": _sources_note(drivers) if drivers else "",
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_forecast_explain.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/price_forecasting/forecast_explain.py tests/test_forecast_explain.py
git commit -m "refactor: rebuild forecast_explain as attribution templating"
```

---

## Task 4: Rewire `export._reason_for_part` + portfolio driver report

**Files:**
- Modify: `src/price_forecasting/export.py` — `_reason_for_part` (~585-722), `_build_tree` (add attribution load ~518), imports (~23-30)
- Modify: `src/price_forecasting/geo_hitl.py` — `explain_forecast_drivers` (335-451)
- Test: `tests/test_smoke.py` (append schema check — see Task 11 for the full assertion; add a minimal one here)

**Interfaces:**
- Consumes: `attribution.load_attribution`, `forecast_explain.build_reason`, `forecast_explain.build_portfolio_reason`, `forecast_explain.CAUSALITY_NOTE`; existing `_confidence_for(change, expected_error)` returning `{level, signalToErrorRatio, expectedErrorPct}`.
- Produces: `tree[...].parts[].reason` in the Spec §3 shape; `geoAnalysis.hitl.forecastDrivers` in the `build_portfolio_reason` shape.
- The per-bucket `sources_verified` flag is derived here: a bucket is verified unless any mediator series feeding it is an offline fallback. Use the existing `mediator_moves` map (`export.py:520`, keyed by mediator name with `isReal`). Mapping: `Freight`→`freight`, `Material costs`→`steel`/`aluminium`/`copper`/`energy`, `Geopolitics`→`gpr_overall`, `FX`→always `True` (ECB cache), `Sector inflation`/`Seasonality`/starting-point→`True`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_smoke.py  (append)
def test_reason_payload_uses_new_schema():
    import json, subprocess, sys, os
    subprocess.run(
        [sys.executable, "-m", "price_forecasting.pipeline", "--stage", "export"],
        check=True, env={**os.environ, "PYTHONPATH": "src"},
    )
    data = json.load(open("dashboard/public/dashboard.json", encoding="utf-8"))
    seen = 0
    for proj in data["tree"]:
        for v in proj["vendors"]:
            for c in v["categories"]:
                for p in c["parts"]:
                    r = p.get("reason") or {}
                    assert "story" not in r and "summary" not in r and "tip" not in r
                    if r.get("available"):
                        assert "headline" in r and "drivers" in r and "breakdown" in r
                        assert "trust" in r
                        seen += 1
    assert seen > 0, "no available reason blocks in payload"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_smoke.py::test_reason_payload_uses_new_schema -q`
Expected: FAIL — old payload still has `summary`/`story`.

- [ ] **Step 3: Write minimal implementation**

`export.py` imports — add:

```python
from . import attribution
from .forecast_explain import build_reason, build_portfolio_reason, CAUSALITY_NOTE
```

In `_build_tree`, after `latest = panel[panel["month"] == latest_month]` (~519), load the attribution once:

```python
    attrib = attribution.load_attribution(
        config.paths.data_processed / "attribution.parquet"
    ) if config is not None else attribution.load_attribution(
        Path("data/processed/attribution.parquet")
    )
    attrib_by_part = {pid: g.to_dict("records")
                      for pid, g in attrib.groupby("part_id")} if not attrib.empty else {}
```

> `_build_tree` currently has no `config` param. Add `config: Optional[Config] = None` to its signature and pass `state.config` from the caller at `export.py:1092` (`"tree": _build_tree(panel, forecasts, future_test, geo_analysis=geo_analysis, config=config)` — `build_dashboard_payload` already receives `config`).

Replace the body of `_reason_for_part` with:

```python
    _BUCKET_MEDIATOR = {
        "Freight": ("freight",),
        "Material costs": ("steel", "aluminium", "copper", "energy"),
        "Geopolitics": ("gpr_overall",),
    }

    def _sources_verified(bucket: str) -> bool:
        keys = _BUCKET_MEDIATOR.get(bucket)
        if not keys:
            return True
        return all(
            bool(mediator_moves.get(k, {}).get("isReal", True))
            for k in keys if k in mediator_moves
        )

    def _reason_for_part(part_row, change_pct, confidence):
        recs = attrib_by_part.get(part_row.get("part_id"))
        if not recs:
            return build_reason(
                change_pct=float(change_pct),
                change_inr=float(part_row["prediction"] - part_row["price"]),
                direction="up" if change_pct >= 0 else "down",
                buckets=[], trust_level=str(confidence.get("level") or "low"),
                expected_error_ratio=float(confidence.get("signalToErrorRatio") or 0),
                available=False,
            )
        buckets = [
            {**r, "sources_verified": _sources_verified(r["bucket"])}
            for r in recs
        ]
        return build_reason(
            change_pct=float(change_pct),
            change_inr=float(part_row["prediction"] - part_row["price"]),
            direction="up" if change_pct >= 0 else "down",
            buckets=buckets,
            trust_level=str(confidence.get("level") or "low"),
            expected_error_ratio=float(confidence.get("signalToErrorRatio") or 0),
        )
```

Delete: `_push`, the `candidates` list building, the `_reason_for_part` early-return that referenced `mediator_moves` emptiness (the new one handles empty via `available=False`), and the now-unused `CATEGORY_MATERIAL_INTENSITY` / `MATERIAL_COMMODITY` imports **only if** `grep -n "CATEGORY_MATERIAL_INTENSITY\|MATERIAL_COMMODITY" src/price_forecasting/export.py` shows no other use.

`geo_hitl.py` — replace `explain_forecast_drivers` body's return (the `return {...}` at 440-451) so it delegates:

```python
    from . import attribution
    from .forecast_explain import build_portfolio_reason

    attrib = attribution.load_attribution(
        config.paths.data_processed / "attribution.parquet"
    )
    if attrib.empty:
        return {"available": False, "reason": "no attribution artifact"}
    agg = (attrib.groupby("bucket")
           .agg(contrib_pct=("contrib_pct", "mean"),
                contrib_inr=("contrib_inr", "mean"),
                group=("group", "first"))
           .reset_index())
    agg["direction"] = agg["contrib_pct"].apply(
        lambda p: "up" if p > 0.05 else "down" if p < -0.05 else "flat")
    buckets = agg.to_dict("records")

    payload = build_portfolio_reason(
        period_label=f"{prior.strftime('%b %Y')} to {current.strftime('%b %Y')}",
        portfolio_mom_pct=price_mom,
        buckets=buckets,
    )
    return payload
```

Keep the `months` / `current` / `prior` / `price_mom` computation above it; delete the `driver_specs` loop and the old `summary` string builder.

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_smoke.py::test_reason_payload_uses_new_schema tests/test_forecast_explain.py tests/test_attribution.py -q`
Expected: PASS. (Run `--stage geoscenario` then `--stage export` if `dashboard.json` lacks `geoAnalysis`.)

- [ ] **Step 5: Commit**

```bash
git add src/price_forecasting/export.py src/price_forecasting/geo_hitl.py tests/test_smoke.py
git commit -m "refactor: build forecast reasons from attribution buckets"
```

---

## Task 5: Quantile interval head on `GlobalXGBModel`

**Files:**
- Modify: `src/price_forecasting/config.py:201-207` (`ModelingConfig`), `config.yaml:149-172` (`modeling:`)
- Modify: `src/price_forecasting/modeling.py:199-248` (`GlobalXGBModel`), `251-326` (`train_global_xgboost`)
- Test: `tests/test_modeling_intervals.py` (new)

**Interfaces:**
- Consumes: `config.modeling.interval_mode: str` (`"quantile"` | `"empirical_ratio"`), `config.modeling.interval_quantiles: list[float]` (length 2, e.g. `[0.1, 0.9]`).
- Produces:
  - `GlobalXGBModel.interval_models: Dict[int, object]` — one multi-quantile `XGBRegressor` per horizon (empty when mode is `empirical_ratio`).
  - `GlobalXGBModel.predict_interval(frame: pd.DataFrame, horizon: int) -> tuple[np.ndarray, np.ndarray]` — `(lower_price, upper_price)`, reconstructed to level identically to `predict`. Raises `KeyError` if no interval model for the horizon.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_modeling_intervals.py
import numpy as np
import pandas as pd

from price_forecasting.config import load_config
from price_forecasting.modeling import train_global_xgboost
from price_forecasting.preprocessing import get_feature_columns


def test_quantile_head_produces_ordered_widening_bands():
    cfg = load_config("config.yaml")
    assert cfg.modeling.interval_mode == "quantile"
    feats = pd.read_parquet("data/processed/features.parquet")
    origin = feats["month"].max()
    horizons = [1, 2, 3]
    model = train_global_xgboost(feats, cfg, origin, horizons,
                                 feature_columns=get_feature_columns(feats))
    rows = feats[feats["month"] == origin]
    prev_width = None
    for h in horizons:
        if h not in model.interval_models:
            continue
        lo, hi = model.predict_interval(rows, h)
        pt = model.predict(rows, h)
        assert np.all(lo <= pt + 1e-6) and np.all(pt <= hi + 1e-6)
        width = float(np.mean((hi - lo) / pt))
        if prev_width is not None:
            assert width >= prev_width - 1e-3  # non-decreasing with horizon
        prev_width = width
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_modeling_intervals.py -q`
Expected: FAIL — `AttributeError: 'ModelingConfig' object has no attribute 'interval_mode'`.

- [ ] **Step 3: Write minimal implementation**

`config.py` — add to `ModelingConfig`:

```python
    interval_mode: str = "quantile"
    interval_quantiles: List[float] = field(default_factory=lambda: [0.1, 0.9])
```

(add `from dataclasses import field` if not already imported; `List` is already imported).

`config.yaml` — under `modeling:` (after `xgboost_target_mode: log_return`):

```yaml
  # 'quantile' fits a reg:quantileerror head for prediction bands; 'empirical_ratio'
  # falls back to backtest residual-ratio bands (see evaluation.extrapolate_intervals).
  interval_mode: quantile
  interval_quantiles: [0.1, 0.9]
```

`config._validate` — add near the other `mod.` checks (~427):

```python
    if mod.interval_mode not in ("quantile", "empirical_ratio"):
        raise ConfigError(
            f"modeling.interval_mode must be 'quantile' or 'empirical_ratio', "
            f"got '{mod.interval_mode}'"
        )
    if len(mod.interval_quantiles) != 2 or not (
        0.0 < mod.interval_quantiles[0] < mod.interval_quantiles[1] < 1.0
    ):
        raise ConfigError("modeling.interval_quantiles must be two ascending values in (0, 1)")
```

`modeling.py` — `GlobalXGBModel`: add field after `models`:

```python
    interval_models: Dict[int, object] = field(default_factory=dict)
```

Add method after `predict`:

```python
    def predict_interval(self, frame: pd.DataFrame, horizon: int):
        """Return ``(lower_price, upper_price)`` from the quantile head."""
        if horizon not in self.interval_models:
            raise KeyError(f"no interval model for horizon {horizon}")
        aligned = self.align_categories(frame)
        q = self.interval_models[horizon].predict(aligned[self.feature_columns])
        # q shape: (n, 2) -> columns are the two configured quantiles ascending
        lo_raw, hi_raw = q[:, 0], q[:, 1]
        if self.target_mode == "level":
            lo, hi = lo_raw, hi_raw
        else:
            anchor = frame["price"].to_numpy(dtype=float)
            lo = anchor * np.exp(np.clip(lo_raw, -0.7, 0.7))
            hi = anchor * np.exp(np.clip(hi_raw, -0.7, 0.7))
        # Guard against quantile crossing.
        lo, hi = np.minimum(lo, hi), np.maximum(lo, hi)
        return lo, hi
```

`train_global_xgboost` — inside the `for h in horizons:` loop, after `model.models[h] = regressor`, add:

```python
        if config.modeling.interval_mode == "quantile":
            try:
                qreg = XGBRegressor(
                    objective="reg:quantileerror",
                    quantile_alpha=np.array(config.modeling.interval_quantiles),
                    enable_categorical=True, tree_method="hist", **params,
                )
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    qreg.fit(train[cols], train["target"])
                model.interval_models[h] = qreg
            except Exception as exc:  # pragma: no cover - xgboost version guard
                logger.warning("quantile head failed for h=%d (%s); "
                               "bands will fall back to empirical ratios", h, exc)
```

(add `import numpy as np` to `modeling.py` if absent — it is already imported.)

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_modeling_intervals.py tests/test_smoke.py -q`
Expected: PASS. If `_validate` needs `interval_quantiles` present in an alternate test config, update that fixture too (`grep -rn "interval_mode\|ModelingConfig(" tests/`).

- [ ] **Step 5: Commit**

```bash
git add src/price_forecasting/config.py config.yaml src/price_forecasting/modeling.py tests/test_modeling_intervals.py
git commit -m "feat: add xgboost quantile-regression interval head"
```

---

## Task 6: Ship quantile bands from the forecast stage; keep ratio fallback

**Files:**
- Modify: `src/price_forecasting/forecasting.py:78-95` (XGBoost prediction loop)
- Modify: `src/price_forecasting/evaluation.py` — `coverage_report` (~488) to treat quantile-band rows the same (no ratio needed)
- Test: `tests/test_smoke.py` (append band sanity)

**Interfaces:**
- Consumes: `GlobalXGBModel.predict_interval` (Task 5), existing `extrapolate_intervals(ratios, horizons)` fallback.
- Produces: `forecasts` rows where `model == "xgboost"` carry `lower`/`upper` from the quantile head when available, else the ratio band. No payload shape change.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_smoke.py  (append)
def test_xgboost_forward_bands_are_ordered():
    import pandas as pd
    df = pd.read_csv("data/processed/forecasts.csv")
    x = df[(df.model == "xgboost") & df.lower.notna() & df.upper.notna()]
    assert len(x) > 0
    assert (x.lower <= x.prediction + 1e-6).all()
    assert (x.prediction <= x.upper + 1e-6).all()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_smoke.py::test_xgboost_forward_bands_are_ordered -q`
Expected: may PASS already on the old ratio bands OR FAIL if `forecasts.csv` is stale — regardless, proceed; the point is wiring quantiles.

- [ ] **Step 3: Write minimal implementation**

`forecasting.py` — replace the band assignment in the `for h in horizons:` XGBoost loop:

```python
    for h in horizons:
        if h not in xgb_model.models:
            continue
        point = xgb_model.predict(origin_rows, h)
        band = ratios[h]
        if h in xgb_model.interval_models:
            lower, upper = xgb_model.predict_interval(origin_rows, h)
        else:
            lower = point * band["lower_ratio"]
            upper = point * band["upper_ratio"]
        frames.append(
            pd.DataFrame(
                {
                    "model": "xgboost",
                    "part_id": origin_rows["part_id"].to_numpy(),
                    "horizon": h,
                    "target_month": origin + pd.DateOffset(months=h),
                    "prediction": point,
                    "lower": lower,
                    "upper": upper,
                }
            )
        )
```

`evaluation.coverage_report` — no code change needed if it only reads `lower`/`upper`/actual columns. Verify with `grep -n "lower_ratio\|upper_ratio" src/price_forecasting/evaluation.py`; those are only in `empirical_prediction_intervals` / `extrapolate_intervals`, which stay. Add a one-line log in `generate_forward_forecasts` after the loop:

```python
    logger.info("xgboost bands: %s",
                "quantile" if xgb_model.interval_models else "empirical-ratio fallback")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m price_forecasting.pipeline --stage forecast && python -m pytest tests/test_smoke.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/price_forecasting/forecasting.py src/price_forecasting/evaluation.py tests/test_smoke.py
git commit -m "feat: ship xgboost quantile bands with ratio fallback"
```

---

## Task 7: Frontend types + `ConfidenceHint`

**Files:**
- Modify: `dashboard/src/types.ts:521-559`
- Create: `dashboard/src/components/reason/ConfidenceHint.tsx`

**Interfaces:**
- Produces (TS):
  ```ts
  export interface ReasonDriver {
    bucket: string;
    direction: 'up' | 'down' | 'flat';
    sizePct: number;
    sizeInr: number;
    weight: 'large' | 'medium' | 'small';
    sourcesVerified: boolean;
  }
  export interface ReasonTrust { level: 'high' | 'medium' | 'low'; line: string; }
  export interface Reason {
    available: boolean;
    headline: string;
    direction: 'up' | 'down' | 'flat';
    changePct: number;
    changeInr: number;
    drivers: ReasonDriver[];
    startingPoint: string;
    trust: ReasonTrust | null;
    breakdown: { bucket: string; sizePct: number }[];
    sourcesNote: string;
    // portfolio variant extras:
    periodLabel?: string;
    portfolioMomPct?: number | null;
  }
  ```
- `<ConfidenceHint trust={ReasonTrust | null} />` — renders a pill + the `line`.

- [ ] **Step 1: Write the failing check**

Run: `cd dashboard && npx tsc --noEmit`
Expected once types are wrong: errors in `DrillDownTree.tsx` / `GeoHitlPanel.tsx` referencing old `ForecastReason`. (No unit test runner; `tsc` is the gate.)

- [ ] **Step 2: Implement types**

In `types.ts`, replace `ForecastReasonDriver` + `ForecastReason` with the `ReasonDriver` / `ReasonTrust` / `Reason` interfaces above. Keep `Confidence` (still used for the pill level on `TreePart`). Update:

```ts
export interface TreePart {
  // ...unchanged fields...
  confidence: Confidence;
  reason?: Reason;
}
export interface GeoHitlBlock {
  available: boolean;
  policy?: string;
  alerts?: GeoAlert[];
  forecastDrivers?: Reason;   // was ForecastDriverReport
}
```

Remove `ForecastDriverReport` / `ForecastReasonDriver` / `ForecastReason` and any now-dead references (`grep -n "ForecastReason\|ForecastDriverReport" dashboard/src`).

- [ ] **Step 3: Implement `ConfidenceHint.tsx`**

```tsx
import clsx from 'clsx';
import type { ReasonTrust } from '../../types';

const STYLE: Record<ReasonTrust['level'], string> = {
  high: 'bg-emerald-100 text-emerald-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-slate-100 text-slate-500',
};

export function ConfidenceHint({ trust }: { trust: ReasonTrust | null }) {
  if (!trust) return null;
  return (
    <div className="mt-3 flex items-start gap-2 rounded-md bg-slate-50 px-3 py-2">
      <span className={clsx('pill shrink-0 text-[10px] uppercase', STYLE[trust.level])}>
        {trust.level}
      </span>
      <span className="text-[12px] leading-relaxed text-slate-600">{trust.line}</span>
    </div>
  );
}
```

- [ ] **Step 4: Verify**

Run: `cd dashboard && npx tsc --noEmit`
Expected: only errors remaining are in `DrillDownTree.tsx` / `GeoHitlPanel.tsx` (fixed in Task 9). No errors in `types.ts` / `ConfidenceHint.tsx`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/types.ts dashboard/src/components/reason/ConfidenceHint.tsx
git commit -m "feat: reason payload types + shared ConfidenceHint"
```

---

## Task 8: `ReasonBlock` component

**Files:**
- Create: `dashboard/src/components/reason/ReasonBlock.tsx`

**Interfaces:**
- Consumes: `Reason`, `ReasonDriver` (Task 7), `<ConfidenceHint>` (Task 7), `formatSigned` from `../../lib/format`.
- Produces: `<ReasonBlock reason={Reason | undefined} variant="part" | "portfolio" />`.

- [ ] **Step 1: Implement**

```tsx
import clsx from 'clsx';
import type { Reason, ReasonDriver } from '../../types';
import { ConfidenceHint } from './ConfidenceHint';

const CAUSALITY =
  "Reasons are the model's own forecast, split by input - a guide to what moved the number, not proof of cause.";

function DriverRow({ d }: { d: ReasonDriver }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'text-[13px]',
            d.direction === 'up' ? 'text-red-600' : d.direction === 'down' ? 'text-emerald-600' : 'text-slate-500',
          )}
        >
          {d.direction === 'up' ? '↑' : d.direction === 'down' ? '↓' : '→'}
        </span>
        <span className="text-[13px] font-medium text-slate-800">{d.bucket}</span>
        <span className="pill bg-slate-100 text-[10px] text-slate-500">{d.weight}</span>
        {!d.sourcesVerified && (
          <span className="pill bg-amber-100 text-[10px] text-amber-700">backup data</span>
        )}
      </div>
      <span
        className={clsx(
          'text-[12px] tabular-nums',
          d.sizeInr >= 0 ? 'text-red-600' : 'text-emerald-600',
        )}
      >
        {d.sizeInr >= 0 ? '+' : ''}₹{Math.round(d.sizeInr)}
      </span>
    </div>
  );
}

export function ReasonBlock({
  reason,
  variant = 'part',
}: {
  reason?: Reason;
  variant?: 'part' | 'portfolio';
}) {
  if (!reason) return null;

  if (!reason.available) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-[13px] text-slate-600">
        {reason.headline}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-[14px] font-medium leading-snug text-slate-900">{reason.headline}</p>

      {reason.drivers.length > 0 && (
        <>
          <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            What's pushing it
          </div>
          <div className="mt-1.5 space-y-1.5">
            {reason.drivers.map((d) => (
              <DriverRow key={d.bucket} d={d} />
            ))}
          </div>
        </>
      )}

      {reason.startingPoint && (
        <p className="mt-2 text-[12px] italic text-slate-500">{reason.startingPoint}</p>
      )}

      {variant === 'part' && <ConfidenceHint trust={reason.trust} />}

      {reason.breakdown.length > 0 && (
        <details className="mt-3 group">
          <summary className="cursor-pointer text-[12px] font-medium text-slate-600 hover:text-slate-900">
            See full breakdown
          </summary>
          <div className="mt-2 space-y-1">
            {reason.breakdown.map((b) => (
              <div key={b.bucket} className="flex items-center justify-between text-[12px]">
                <span className="text-slate-600">{b.bucket}</span>
                <span
                  className={clsx(
                    'tabular-nums',
                    b.sizePct >= 0 ? 'text-red-600' : 'text-emerald-600',
                  )}
                >
                  {b.sizePct >= 0 ? '+' : ''}
                  {b.sizePct.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      {reason.sourcesNote && (
        <p className="mt-2 text-[11px] text-slate-500">{reason.sourcesNote}</p>
      )}
      <p className="mt-2 text-[11px] text-slate-400">{CAUSALITY}</p>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `cd dashboard && npx tsc --noEmit`
Expected: no new errors in `ReasonBlock.tsx`.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/reason/ReasonBlock.tsx
git commit -m "feat: shared ReasonBlock component"
```

---

## Task 9: Wire `ReasonBlock` into DrillDownTree + GeoHitlPanel

**Files:**
- Modify: `dashboard/src/components/DrillDownTree.tsx:298-437` (`PartRow`), `:92-100` (confidence paragraph)
- Modify: `dashboard/src/components/GeoHitlPanel.tsx:246-299` ("Why prices moved" block)

**Interfaces:**
- Consumes: `<ReasonBlock>` (Task 8).

- [ ] **Step 1: DrillDownTree**

In `PartRow`, replace the whole `{reasonOpen && part.reason?.available && ( <div ...> ... </div> )}` block (lines ~365-434) with:

```tsx
      {reasonOpen && (
        <div className="ml-0 mr-5 mt-1" style={{ paddingLeft: 20 + 2 * 44 }}>
          <ReasonBlock reason={part.reason} variant="part" />
        </div>
      )}
```

Change the "Why?" button `disabled` guard to `disabled={!part.reason}` (an unavailable reason still renders its one-line explanation).

Add import: `import { ReasonBlock } from './reason/ReasonBlock';`

Delete the confidence explainer `<p className="mt-3 rounded-md bg-slate-50 ...">` block at lines ~92-99 (the "Confidence is a signal-to-error ratio, not a probability" paragraph) — it now lives in `ConfidenceHint`. Keep the `minConfidence` filter `<label>` above it.

- [ ] **Step 2: GeoHitlPanel**

Replace the entire `{/* Why the forecast moved */}` card (lines ~246-299) with:

```tsx
      {drivers?.available && (
        <div className="card px-5 py-4">
          <h3 className="text-[15px] font-semibold text-slate-900">
            Why prices moved{drivers.periodLabel ? ` — ${drivers.periodLabel}` : ''}
          </h3>
          <div className="mt-3">
            <ReasonBlock reason={drivers} variant="portfolio" />
          </div>
        </div>
      )}
```

`drivers` is already `hitl?.forecastDrivers`; its type is now `Reason` (Task 7). Add import `import { ReasonBlock } from './reason/ReasonBlock';`. Remove the now-unused `formatSigned` import only if nothing else in the file uses it (`AlertCard` still does — keep it).

- [ ] **Step 3: Verify**

Run: `cd dashboard && npx tsc --noEmit && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Manual preview**

Start preview (`preview_start` name `dashboard` or `npm run dev`), open the Hierarchy tab, expand a part, click "Why?" — confirm headline + drivers + confidence hint + "See full breakdown" render. Open the Geo tab — confirm "Why prices moved" shows the ReasonBlock.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/DrillDownTree.tsx dashboard/src/components/GeoHitlPanel.tsx
git commit -m "refactor: render part + portfolio reasons through ReasonBlock"
```

---

## Task 10: Geo tab consolidation + FAQ + de-jargon

**Files:**
- Modify: `dashboard/src/components/GeoScenarioPanel.tsx` (whole render body, ~75-343)
- Modify: `dashboard/src/App.tsx:56-60` (`TITLES.geo`)
- Modify: `dashboard/src/components/FaqPanel.tsx` — the "Are the prediction intervals trustworthy?" answer (~296-303) and the confidence answer (~330-338)

**Interfaces:** none new.

- [ ] **Step 1: GeoScenarioPanel — fold diagnostics into one `<details>`**

Keep cards 1 (`<GeoHitlPanel>` — which now contains the review queue + ReasonBlock) as-is at the top. Wrap the **Mechanism claim**, **Mediation**, **Event studies**, **Counterfactuals**, and **Mediator provenance** cards in a single collapsed disclosure:

```tsx
      <details className="card px-5 py-4">
        <summary className="cursor-pointer text-[15px] font-semibold text-slate-900">
          Method &amp; diagnostics
        </summary>
        <p className="mt-2 text-[12px] text-slate-500">
          How the geopolitical channel is estimated: the mechanism it assumes, a
          check on whether that mechanism holds in the data, past episodes, and
          what-if shocks. Optional detail — the review queue above is the
          day-to-day view.
        </p>
        <div className="mt-4 flex flex-col gap-4">
          {/* existing framework card JSX */}
          {/* existing mediation card JSX */}
          {/* existing event-studies card JSX */}
          {/* existing counterfactuals card JSX */}
          {/* existing mediator-provenance card JSX */}
        </div>
      </details>
```

Move the five existing card `<div className="card ...">` blocks verbatim inside that `<div className="mt-4 flex flex-col gap-4">`, changing their outer `card` class to `rounded-lg border border-slate-200` (they are now nested, not top-level cards). Reword headings: "Event studies" → "Past episodes", "Counterfactual shocks" → "What-if shocks", "Mediation diagnostic" → "Does the mechanism hold?", "Mediator provenance" → "Data sources". In the `FAMILIES` / tooltip strings replace "GPR" → "World risk", "MoM" → "month over month" where present.

- [ ] **Step 2: App.tsx geo subtitle**

```tsx
  geo: {
    title: 'Geopolitical Risk',
    subtitle:
      'Recent world-risk signals, checked source by source. Confirm one to see its price impact — nothing is applied automatically.',
  },
```

- [ ] **Step 3: FaqPanel intervals answer**

Replace the body string of the "Are the prediction intervals trustworthy?" FAQ with:

```
Partly, and it is measured rather than asserted.

XGBoost bands now come from quantile regression — three heads (10th, 50th, 90th percentile) trained directly on the target, so the band is what the model actually predicts for the spread, not a residual ratio bolted on afterwards. They widen with horizon because the quantile spread does.

SARIMA still uses analytic intervals, which on real data covered ${val?.backtests?.find((b) => b.coverage_pct !== null)?.coverage_pct ?? '—'}% against an 80% target — too narrow, because they propagate residual variance but not parameter uncertainty. Treat any interval here as a guide, not a guarantee.
```

For the confidence answer ("What does the confidence flag on each part mean?"), leave the text but append one line:

```
The same wording now appears inline wherever a forecast is shown (the "Why?" panel), so the meaning travels with the number.
```

- [ ] **Step 4: Verify**

Run: `cd dashboard && npx tsc --noEmit && npm run build`
Expected: build succeeds. Preview the Geo tab — five diagnostic cards are collapsed under "Method & diagnostics"; expanding shows them intact with the reworded headings.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/GeoScenarioPanel.tsx dashboard/src/App.tsx dashboard/src/components/FaqPanel.tsx
git commit -m "refactor: collapse Geo diagnostics; de-jargon reason UI"
```

---

## Task 11: Full pipeline run + smoke assertions + manual verification

**Files:**
- Modify: `tests/test_smoke.py` — consolidate reason-schema + band checks
- Modify: `dashboard/public/dashboard.json` (regenerated artifact — commit it, the repo tracks it)

- [ ] **Step 1: Add the consolidated schema test**

```python
# tests/test_smoke.py  (append)
REASON_KEYS = {"available", "headline", "direction", "changePct", "changeInr",
               "drivers", "startingPoint", "trust", "breakdown", "sourcesNote"}
BANNED = {"summary", "story", "tip", "causalityNote"}


def test_full_reason_schema_and_reconciliation():
    import json
    data = json.load(open("dashboard/public/dashboard.json", encoding="utf-8"))
    parts = [p for proj in data["tree"] for v in proj["vendors"]
             for c in v["categories"] for p in c["parts"]]
    assert parts
    for p in parts:
        r = p.get("reason") or {}
        assert not (BANNED & r.keys()), f"banned keys in {p['partId']}"
        if not r.get("available"):
            continue
        assert REASON_KEYS <= r.keys()
        assert len(r["drivers"]) <= 3
        for d in r["drivers"]:
            assert d["weight"] in ("large", "medium", "small")
            assert isinstance(d["sourcesVerified"], bool)
        # breakdown reconciles to changePct within rounding slack
        total = sum(b["sizePct"] for b in r["breakdown"])
        assert abs(total - r["changePct"]) < max(1.0, abs(r["changePct"]) * 0.15)

    gd = (data.get("geoAnalysis") or {}).get("hitl", {}).get("forecastDrivers")
    if gd and gd.get("available"):
        assert "trust" not in gd or gd["trust"] is None
        assert "periodLabel" in gd
```

- [ ] **Step 2: Run the full pipeline**

Run:
```bash
python -m price_forecasting.pipeline --config config.yaml --stage all
```
Expected: completes without error; writes `data/processed/attribution.parquet` and `dashboard/public/dashboard.json`.

- [ ] **Step 3: Run the whole test suite**

Run: `python -m pytest tests/ -q`
Expected: all pass. Fix any smoke test that asserted the old reason shape (`grep -n "story\|summary\|causalityNote\|\.tip" tests/test_smoke.py`).

- [ ] **Step 4: Frontend build + manual walkthrough**

Run: `cd dashboard && npm run build`
Then `preview_start` and check:
- Hierarchy → expand part → "Why?": headline reads as one sentence; ≤3 external drivers with ₹ figures; "Starting point" line; confidence hint; "See full breakdown" reconciles.
- Geo tab: review queue + "Why prices moved" ReasonBlock on top; "Method & diagnostics" collapsed below.
- No raw `magnitude`/`signalToErrorRatio` numbers visible anywhere in the reason UI.

- [ ] **Step 5: Commit**

```bash
git add tests/test_smoke.py data/processed/attribution.parquet dashboard/public/dashboard.json data/processed/forecasts.csv
git commit -m "test: full reason-schema + interval smoke checks; regenerate artifacts"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §1 Architecture / `attribution.py` / `attribution.parquet` | Tasks 1, 2 |
| §2 Bucket map (8 buckets, coverage test) | Task 1 (`BUCKETS`, `bucket_for`, coverage test) |
| §3 Reason payload contract (`headline`/`drivers`/`weight`/`startingPoint`/`trust`/`breakdown`/`sourcesNote`; removed keys) | Tasks 3, 4, 11 |
| §3 Portfolio version, identical shape minus trust | Tasks 3 (`build_portfolio_reason`), 4 (geo_hitl rewire) |
| §4 `forecast_explain.py` rewrite; `export._reason_for_part` gutted; delete heuristic block + unused imports | Tasks 3, 4 |
| §5 SARIMA/thin-history → `available:false`; reconciliation guard; tiny-move flat; bug fold-ins | Task 1 (`_assert_reconciles`), Task 3 (flat + unavailable), Task 4 (no-attrib path) |
| §6 Quantile interval head; config keys; ratio fallback; coverage scoring; FAQ rewrite | Tasks 5, 6, 10 |
| §7 `ReasonBlock` + `ConfidenceHint`; DrillDownTree + GeoHitlPanel wiring; types; de-jargon | Tasks 7, 8, 9, 10 |
| §8 Geo tab 7→3, `<details>` "Method & diagnostics" | Task 10 |
| §9 `test_attribution.py`, smoke extensions, full run | Tasks 1, 2, 3, 5, 6, 11 |

No gaps.

**2. Placeholder scan** — no "TBD"/"handle edge cases"/"similar to Task N". Each code step carries full source. The five nested Geo cards in Task 10 Step 1 are referenced as "existing … JSX" with an explicit verbatim-move instruction rather than reproduced — acceptable because they are unchanged existing code being relocated, and the reword list is explicit.

**3. Type consistency**
- `explain_forecasts` output columns `part_id, bucket, group, contrib_logret, contrib_pct, contrib_inr, direction` — same in Tasks 1, 2, 4.
- `build_reason` / `build_portfolio_reason` signatures identical in Task 3 definition and Task 4 call sites.
- `predict_interval` returns `(lower, upper)` price arrays — Task 5 defines, Task 6 consumes as `lower, upper`.
- TS `Reason` / `ReasonDriver` / `ReasonTrust` — defined Task 7, consumed Tasks 8, 9; `GeoHitlBlock.forecastDrivers: Reason` consistent.
- `ConfidenceHint` prop `trust: ReasonTrust | null` — matches `Reason.trust` type and `reason.trust` pass in Task 8.

Fixed inline during review: Task 4 now passes `config` into `_build_tree` (originally omitted), and `_reason_for_part`'s empty-mediator early return is explicitly deleted in favour of the `available=False` path.
