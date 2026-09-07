"""Geopolitical mediators, indices and event calendar.

Supplies the public exogenous series that sit between geopolitical events and
part prices:

* commodity spots (steel/iron ore, aluminium, copper, energy/crude) — World Bank
  Pink Sheet when reachable, otherwise a deterministic offline path with planted spikes
* container / bulk freight — drop-in CSV, configured URL, or FRED Baltic Dry Index
  when reachable; otherwise offline with a Red Sea-era spike
* Caldara-Iacoviello GPR (threats / acts) when the export file is reachable
* shipping chokepoint intensity derived from the event calendar + freight
* dated ``geo_events`` calendar for discrete shocks

Fetch failures never stop the pipeline: every series has an offline fallback
flagged in provenance, matching the FX module's contract.
"""

from __future__ import annotations

import io
import json
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from .config import Config
from .geo_schema import (
    CATEGORY_MATERIAL_INTENSITY,
    MATERIAL_COMMODITY,
    GeoEvent,
    events_to_frame,
    frame_to_events,
    framework_summary,
)
from .logging_utils import get_logger

logger = get_logger(__name__)

GPR_EXPORT_URL = "https://www.matteoiacoviello.com/gpr_files/data_gpr_export.xls"
# World Bank Pink Sheet monthly historical (xlsx inside a zip on some mirrors;
# we also accept a direct xlsx URL configured in YAML).
PINK_SHEET_URL = (
    "https://thedocs.worldbank.org/en/doc/"
    "74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/related/"
    "CMO-Historical-Data-Monthly.xlsx"
)
PINK_SHEET_DISCOVER = "https://www.worldbank.org/en/research/commodity-markets"


def causal_expanding_zscore(series: pd.Series, min_periods: int = 3) -> pd.Series:
    """Standardise each point using only strictly earlier history."""
    series = pd.Series(series, copy=False)
    history = series.shift(1)
    mean = history.expanding(min_periods=min_periods).mean()
    std = history.expanding(min_periods=min_periods).std()
    denom = std.where(std > 1e-6)
    return (series - mean) / denom


@dataclass
class MediatorSeries:
    """One monthly exogenous series with provenance."""

    values: pd.Series
    name: str
    source: str
    unit: str = "index"

    @property
    def is_real(self) -> bool:
        return not self.source.startswith("offline")

    def normalized(self) -> pd.Series:
        base = float(self.values.iloc[0])
        if base == 0:
            return self.values * 0.0 + 1.0
        return self.values / base

    def log_return(self, periods: int = 1) -> pd.Series:
        return np.log(self.values.clip(lower=1e-9)).diff(periods)

    def total_move_pct(self) -> float:
        base = float(self.values.iloc[0])
        if abs(base) < 1e-12:
            return 0.0
        return float((self.values.iloc[-1] / base - 1.0) * 100)

    def describe(self) -> str:
        return f"{self.name} via {self.source}"


@dataclass
class GeoBundle:
    """Everything the geo layer contributes to a pipeline run."""

    commodities: Dict[str, MediatorSeries]
    freight: MediatorSeries
    gpr: Dict[str, MediatorSeries]
    chokepoint: MediatorSeries
    events: List[GeoEvent]

    def all_mediators(self) -> Dict[str, MediatorSeries]:
        out: Dict[str, MediatorSeries] = {}
        out.update(self.commodities)
        out["freight"] = self.freight
        out.update({f"gpr_{k}": v for k, v in self.gpr.items()})
        out["chokepoint"] = self.chokepoint
        return out


# --------------------------------------------------------------------------- #
# Cache helpers
# --------------------------------------------------------------------------- #


def _cache_is_fresh(path: Path, ttl_days: int) -> bool:
    if not path.is_file():
        return False
    return (time.time() - path.stat().st_mtime) / 86_400.0 <= ttl_days


def _http_get(url: str, timeout: float) -> bytes:
    request = urllib.request.Request(
        url, headers={"User-Agent": "price-forecasting-poc/0.1 (+research)"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _align_to_months(series: pd.Series, months: pd.DatetimeIndex) -> pd.Series:
    """Reindex a monthly series onto the panel grid with ffill/bfill."""
    series = series.copy()
    series.index = pd.to_datetime(series.index).to_period("M").to_timestamp()
    series = series[~series.index.duplicated(keep="last")].sort_index()
    window = series.reindex(
        pd.date_range(min(series.index.min(), months.min()), max(series.index.max(), months.max()), freq="MS")
    ).interpolate(limit_direction="both")
    aligned = window.reindex(months)
    if aligned.isna().any():
        aligned = aligned.ffill().bfill()
    return aligned


# --------------------------------------------------------------------------- #
# Offline fallbacks (deterministic, with planted geo footprints)
# --------------------------------------------------------------------------- #


def _offline_commodity(
    months: pd.DatetimeIndex, name: str, start: float, seed: int
) -> pd.Series:
    """Random-walk commodity with planted Ukraine / steel spikes."""
    rng = np.random.default_rng(seed)
    steps = rng.normal(0.001, 0.035, size=len(months))
    steps[0] = 0.0
    bump = {"steel": 0.08, "aluminium": 0.05, "copper": 0.04, "energy": 0.10}.get(
        name, 0.03
    )
    for i, month in enumerate(months):
        if pd.Timestamp("2022-02-01") <= month <= pd.Timestamp("2022-05-01"):
            steps[i] += bump
        if month == pd.Timestamp("2022-08-01") and name == "steel":
            steps[i] -= 0.10
    values = start * np.exp(np.cumsum(steps))
    return pd.Series(values, index=months, name=name)


def _offline_freight(months: pd.DatetimeIndex, seed: int) -> pd.Series:
    """Freight index with COVID-era elevation and a Red Sea spike."""
    rng = np.random.default_rng(seed + 3)
    base = 100.0
    values = np.empty(len(months), dtype=float)
    level = base
    for i, month in enumerate(months):
        shock = rng.normal(0.0, 0.04)
        # Mild post-COVID normalisation early in sample
        if month < pd.Timestamp("2023-01-01"):
            shock -= 0.01
        # Red Sea disruption
        if pd.Timestamp("2023-12-01") <= month <= pd.Timestamp("2024-05-01"):
            shock += 0.12 if month == pd.Timestamp("2023-12-01") else 0.03
        level = max(40.0, level * np.exp(shock))
        values[i] = level
    return pd.Series(values, index=months, name="freight")


def _offline_gpr(months: pd.DatetimeIndex, seed: int) -> Dict[str, pd.Series]:
    """GPR-like paths with spikes at known conflict dates."""
    rng = np.random.default_rng(seed + 11)
    threat = np.empty(len(months))
    act = np.empty(len(months))
    t_level, a_level = 100.0, 80.0
    for i, month in enumerate(months):
        t_shock = rng.normal(0.0, 0.08)
        a_shock = rng.normal(0.0, 0.10)
        if month == pd.Timestamp("2022-02-01"):
            t_shock += 1.2
            a_shock += 1.6
        if month == pd.Timestamp("2023-10-01"):
            t_shock += 0.9
            a_shock += 0.7
        t_level = max(40.0, t_level * np.exp(t_shock * 0.15))
        a_level = max(30.0, a_level * np.exp(a_shock * 0.15))
        # Mild mean reversion toward 100 / 80
        t_level = 0.85 * t_level + 0.15 * 100.0
        a_level = 0.85 * a_level + 0.15 * 80.0
        threat[i] = t_level
        act[i] = a_level
    overall = 0.55 * threat + 0.45 * act
    return {
        "overall": pd.Series(overall, index=months, name="gpr"),
        "threat": pd.Series(threat, index=months, name="gpr_threat"),
        "act": pd.Series(act, index=months, name="gpr_act"),
    }


# --------------------------------------------------------------------------- #
# Live fetchers
# --------------------------------------------------------------------------- #


def _parse_gpr_xls(payload: bytes, months: pd.DatetimeIndex) -> Dict[str, pd.Series]:
    """Parse the Caldara-Iacoviello export workbook."""
    frame = pd.read_excel(io.BytesIO(payload))
    # Column names vary slightly across releases; match case-insensitively.
    cols = {str(c).strip().lower(): c for c in frame.columns}
    date_col = next((cols[k] for k in cols if "month" in k or k == "date"), None)
    if date_col is None:
        date_col = frame.columns[0]
    frame["_month"] = pd.to_datetime(frame[date_col]).dt.to_period("M").dt.to_timestamp()

    def pick(*candidates: str) -> Optional[str]:
        for name in candidates:
            if name in cols:
                return cols[name]
        return None

    gpr_col = pick("gpr", "gprh", "gprc")
    threat_col = pick("gprt", "gpt", "gpr_threat", "threat")
    act_col = pick("gpra", "gpa", "gpr_act", "act")
    if gpr_col is None:
        raise ValueError("GPR workbook missing a GPR column")

    monthly = frame.groupby("_month")[gpr_col].mean()
    threat = (
        frame.groupby("_month")[threat_col].mean()
        if threat_col
        else monthly * 0.9
    )
    act = (
        frame.groupby("_month")[act_col].mean()
        if act_col
        else monthly * 0.7
    )
    return {
        "overall": _align_to_months(monthly, months).rename("gpr"),
        "threat": _align_to_months(threat, months).rename("gpr_threat"),
        "act": _align_to_months(act, months).rename("gpr_act"),
    }


def fetch_gpr(
    config: Config, months: pd.DatetimeIndex
) -> Tuple[Dict[str, MediatorSeries], str]:
    """Load GPR overall / threat / act covering ``months``."""
    cache = config.paths.data_raw / "gpr_export.xls"
    ttl = config.geo.cache_ttl_days
    url = config.geo.gpr_url or GPR_EXPORT_URL

    try:
        if _cache_is_fresh(cache, ttl):
            payload = cache.read_bytes()
            source = "gpr-cache"
        else:
            payload = _http_get(url, config.sourcing.request_timeout_seconds)
            cache.write_bytes(payload)
            source = "gpr-live"
        parsed = _parse_gpr_xls(payload, months)
        return {
            key: MediatorSeries(values=series, name=series.name, source=source, unit="index")
            for key, series in parsed.items()
        }, source
    except Exception as exc:  # noqa: BLE001 - offline fallback is the contract
        logger.warning("GPR fetch failed (%s); using offline fallback", exc)
        offline = _offline_gpr(months, config.project.random_seed)
        return {
            key: MediatorSeries(
                values=series, name=series.name, source="offline-fallback", unit="index"
            )
            for key, series in offline.items()
        }, "offline-fallback"


def _workbook_bytes(payload: bytes) -> bytes:
    """Return spreadsheet bytes, unwrapping an outer zip-of-workbook if needed.

    An ``.xlsx`` file *is* a ZIP (starts with ``PK``) containing ``xl/``. Treating
    every PK payload as a zip-of-xlsx wrongly looks for a nested ``.xlsx`` entry
    and fails with ``StopIteration``.
    """
    if payload[:2] != b"PK":
        return payload
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as zf:
            names = zf.namelist()
            if any(
                n == "[Content_Types].xml" or n.startswith("xl/") for n in names
            ):
                return payload
            nested = next(
                (n for n in names if n.lower().endswith((".xlsx", ".xls"))),
                None,
            )
            if nested is not None:
                return zf.read(nested)
    except zipfile.BadZipFile:
        pass
    return payload


def _parse_cmo_months(values: pd.Series) -> pd.Series:
    """Parse Pink Sheet period labels like ``2024M03`` (and ordinary dates)."""
    text = values.astype(str).str.strip()
    parsed = pd.to_datetime(text, format="%YM%m", errors="coerce")
    still_missing = parsed.isna()
    if still_missing.any():
        parsed = parsed.copy()
        parsed.loc[still_missing] = pd.to_datetime(
            text.loc[still_missing], errors="coerce"
        )
    return parsed


def _parse_pink_sheet(payload: bytes, months: pd.DatetimeIndex) -> Dict[str, pd.Series]:
    """Extract steel / aluminium / copper / energy monthly series from Pink Sheet."""
    payload = _workbook_bytes(payload)
    xl = pd.ExcelFile(io.BytesIO(payload))
    sheet = next(
        (
            s
            for s in xl.sheet_names
            if "monthly" in s.lower() and "price" in s.lower()
        ),
        next(
            (s for s in xl.sheet_names if "monthly" in s.lower()),
            xl.sheet_names[0],
        ),
    )
    raw = pd.read_excel(xl, sheet_name=sheet, header=None)
    # Find the header row containing metals / crude labels
    header_row = None
    for i in range(min(20, len(raw))):
        row_vals = " ".join(str(v).lower() for v in raw.iloc[i].tolist())
        if "aluminum" in row_vals or "aluminium" in row_vals or "copper" in row_vals:
            header_row = i
            break
    if header_row is None:
        raise ValueError("could not locate Pink Sheet header row")

    frame = pd.read_excel(xl, sheet_name=sheet, header=header_row)
    frame = frame.replace({"…": np.nan, "...": np.nan, "—": np.nan, "-": np.nan})
    date_col = frame.columns[0]
    frame["_month"] = _parse_cmo_months(frame[date_col])
    frame = frame.dropna(subset=["_month"])
    frame["_month"] = frame["_month"].dt.to_period("M").dt.to_timestamp()

    def find_col(*needles: str) -> Optional[str]:
        for col in frame.columns:
            label = str(col).lower()
            if any(n in label for n in needles):
                return col
        return None

    # Prefer iron ore as the steel-channel proxy (Pink Sheet has no HRC series).
    mapping = {
        "steel": find_col("iron ore") or find_col("steel"),
        "aluminium": find_col("aluminum", "aluminium"),
        "copper": find_col("copper"),
        "energy": find_col("crude oil, average")
        or find_col("crude oil, brent")
        or find_col("crude oil"),
    }
    out: Dict[str, pd.Series] = {}
    for name, col in mapping.items():
        if col is None:
            continue
        series = pd.to_numeric(frame.set_index("_month")[col], errors="coerce").dropna()
        if series.empty:
            continue
        out[name] = _align_to_months(series, months).rename(name)
    if len(out) < 2:
        raise ValueError("Pink Sheet parse yielded too few commodity series")
    return out


def _discover_pink_sheet_url(config: Config) -> Optional[str]:
    """Scrape the World Bank commodity-markets page for the current monthly xlsx."""
    discover = config.geo.pink_sheet_discover_url or PINK_SHEET_DISCOVER
    try:
        html = _http_get(discover, config.sourcing.request_timeout_seconds).decode(
            "utf-8", errors="ignore"
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Pink Sheet discovery failed (%s)", exc)
        return None

    # Prefer thedocs.worldbank.org monthly historical workbook links
    import re

    pattern = re.compile(
        r"https://thedocs\.worldbank\.org/en/doc/[^\"'\s]+CMO-Historical-Data-Monthly\.xlsx",
        re.IGNORECASE,
    )
    matches = pattern.findall(html)
    if matches:
        logger.info("discovered Pink Sheet URL: %s", matches[0])
        return matches[0]
    # Some pages use relative /doc/.../related/ links
    rel = re.compile(
        r"(/en/doc/[^\"'\s]+CMO-Historical-Data-Monthly\.xlsx)",
        re.IGNORECASE,
    )
    rel_matches = rel.findall(html)
    if rel_matches:
        url = "https://thedocs.worldbank.org" + rel_matches[0]
        logger.info("discovered Pink Sheet URL: %s", url)
        return url
    return None


def fetch_commodities(
    config: Config, months: pd.DatetimeIndex
) -> Dict[str, MediatorSeries]:
    """Load steel / aluminium / copper / energy monthly prices."""
    cache = config.paths.data_raw / "pink_sheet_monthly.xlsx"
    ttl = config.geo.cache_ttl_days
    configured = config.geo.pink_sheet_url or PINK_SHEET_URL
    starts = {"steel": 700.0, "aluminium": 2200.0, "copper": 8500.0, "energy": 80.0}

    def _from_payload(payload: bytes, source: str) -> Dict[str, MediatorSeries]:
        parsed = _parse_pink_sheet(payload, months)
        return {
            name: MediatorSeries(values=series, name=name, source=source, unit="usd")
            for name, series in parsed.items()
        }

    if _cache_is_fresh(cache, ttl):
        try:
            result = _from_payload(cache.read_bytes(), "pink-sheet-cache")
            if len(result) >= 2:
                return result
        except Exception as exc:  # noqa: BLE001
            logger.warning("commodity cache unusable (%s); refetching", exc)

    urls: List[str] = [configured]
    discovered = _discover_pink_sheet_url(config)
    if discovered and discovered not in urls:
        urls.append(discovered)

    for url in urls:
        try:
            payload = _http_get(url, max(config.sourcing.request_timeout_seconds, 60))
            result = _from_payload(payload, "pink-sheet-live")
            cache.write_bytes(_workbook_bytes(payload))
            logger.info(
                "fetched Pink Sheet commodities from %s (%s)",
                url[:70],
                ", ".join(sorted(result)),
            )
            return result
        except Exception as exc:  # noqa: BLE001
            logger.warning("commodity fetch via %s failed (%s)", url[:70], exc)

    logger.warning("commodity fetch failed; using offline fallback")
    return {
        name: MediatorSeries(
            values=_offline_commodity(months, name, start, config.project.random_seed + i),
            name=name,
            source="offline-fallback",
            unit="usd",
        )
        for i, (name, start) in enumerate(starts.items())
    }


FRED_FREIGHT_CSV = (
    # Transportation Services Index: Freight (BTS via FRED). Baltic Dry (BDIY)
    # is no longer published on FRED without an API key / returns 404.
    "https://fred.stlouisfed.org/graph/fredgraph.csv?id=TSIFRGHT"
)


def _parse_freight_frame(frame: pd.DataFrame) -> pd.Series:
    """Normalise a freight CSV/JSON frame to a monthly Series."""
    renamed = {c.lower().strip(): c for c in frame.columns}
    date_col = next(
        (
            renamed[k]
            for k in ("month", "date", "observation_date", "time", "period")
            if k in renamed
        ),
        frame.columns[0],
    )
    value_col = next(
        (
            renamed[k]
            for k in ("value", "freight", "bdi", "index", "price", "close")
            if k in renamed
        ),
        frame.columns[1] if len(frame.columns) > 1 else frame.columns[0],
    )
    months = pd.to_datetime(frame[date_col], errors="coerce")
    values = pd.to_numeric(frame[value_col], errors="coerce")
    series = pd.Series(values.to_numpy(), index=months).dropna()
    series = series[series > 0]
    if series.empty:
        raise ValueError("freight series empty after parse")
    # Daily BDI → month-end mean
    series = series.groupby(series.index.to_period("M")).mean()
    series.index = series.index.to_timestamp()
    return series.rename("freight")


def _write_freight_cache(
    path: Path, series: pd.Series, source: str, note: str = ""
) -> None:
    path.write_text(
        json.dumps(
            {
                "source": source,
                "note": note,
                "months": [m.strftime("%Y-%m-%d") for m in series.index],
                "values": [float(v) for v in series.to_numpy()],
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def fetch_freight(config: Config, months: pd.DatetimeIndex) -> MediatorSeries:
    """Load a freight / shipping-cost proxy (BDI or user CSV).

    Preference order:
    1. Fresh *real* JSON cache from a prior successful fetch
    2. Drop-in ``freight_monthly.csv`` under data/raw
    3. Configured ``freight_url`` CSV
    4. FRED Baltic Dry Index (``BDIY``) CSV export
    5. Offline fallback (deterministic Red Sea spike)
    """
    json_cache = config.paths.data_raw / "freight_monthly.json"
    csv_path = config.paths.data_raw / config.geo.freight_filename

    # 1. Real cache only — never treat offline JSON as authoritative forever.
    if _cache_is_fresh(json_cache, config.geo.cache_ttl_days):
        try:
            payload = json.loads(json_cache.read_text(encoding="utf-8"))
            source = str(payload.get("source") or "freight-cache")
            if not source.startswith("offline"):
                series = pd.Series(
                    payload["values"], index=pd.to_datetime(payload["months"])
                )
                series = _align_to_months(series, months).rename("freight")
                return MediatorSeries(
                    values=series,
                    name="freight",
                    source=source if source.endswith("-cache") else f"{source}-cache",
                    unit="index",
                )
        except (json.JSONDecodeError, KeyError, ValueError, TypeError) as exc:
            logger.warning("freight cache unusable (%s); refetching", exc)

    # 2. User drop-in CSV
    if csv_path.is_file():
        try:
            frame = pd.read_csv(csv_path)
            series = _align_to_months(_parse_freight_frame(frame), months)
            _write_freight_cache(
                json_cache,
                series,
                "freight-csv",
                note=f"Loaded from {csv_path.name}",
            )
            logger.info("loaded freight from %s", csv_path.name)
            return MediatorSeries(
                values=series, name="freight", source="freight-csv", unit="index"
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("freight CSV %s unusable (%s)", csv_path.name, exc)

    # 3–4. Live CSV URLs
    urls: List[Tuple[str, str]] = []
    if (config.geo.freight_url or "").strip():
        urls.append(("freight-url", config.geo.freight_url.strip()))
    urls.append(("fred-tsi-freight", FRED_FREIGHT_CSV))

    timeout = max(config.sourcing.request_timeout_seconds, 90)
    for label, url in urls:
        try:
            payload = _http_get(url, timeout)
            frame = pd.read_csv(io.BytesIO(payload))
            series = _align_to_months(_parse_freight_frame(frame), months)
            _write_freight_cache(
                json_cache,
                series,
                label,
                note=f"Fetched from {url[:80]}",
            )
            logger.info("fetched freight (%s) from %s", label, url[:70])
            return MediatorSeries(
                values=series, name="freight", source=label, unit="index"
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("freight fetch %s failed (%s)", label, exc)

    logger.warning("freight fetch failed; using offline fallback")
    series = _offline_freight(months, config.project.random_seed)
    _write_freight_cache(
        json_cache,
        series,
        "offline-fallback",
        note=(
            "Deterministic freight path with Red Sea spike. Drop "
            f"{config.geo.freight_filename} or set geo.freight_url to a BDI CSV."
        ),
    )
    return MediatorSeries(
        values=series, name="freight", source="offline-fallback", unit="index"
    )


# --------------------------------------------------------------------------- #
# Event calendar
# --------------------------------------------------------------------------- #


def default_seed_events() -> List[GeoEvent]:
    """Built-in calendar used when ``geo_events.csv`` is absent."""
    from .geo_schema import GeoEvent as GE

    return [
        GE(
            "ukraine_invasion_2022",
            "2022-02-01",
            "2022-12-01",
            "conflict",
            5,
            "UA-EU",
            ("fx", "commodity:energy", "commodity:steel", "freight", "insurance"),
            "manual_calendar",
            1.0,
            "Russia's invasion of Ukraine: multi-channel shock.",
        ),
        GE(
            "red_sea_houthi_2023",
            "2023-12-01",
            "2024-06-01",
            "chokepoint",
            4,
            "RED-SEA",
            ("freight", "insurance"),
            "manual_calendar",
            1.0,
            "Red Sea diversions: transit delay and freight spike.",
        ),
        GE(
            "india_budget_duty_2023",
            "2023-02-01",
            "2023-02-01",
            "tariff",
            3,
            "IN-DOMESTIC",
            ("duty",),
            "manual_calendar",
            0.9,
            "Union Budget customs adjustments on selected auto lines.",
        ),
        GE(
            "israel_hamas_2023",
            "2023-10-01",
            "2024-03-01",
            "conflict",
            4,
            "ME-GLOBAL",
            ("fx", "commodity:energy", "freight", "insurance"),
            "manual_calendar",
            0.95,
            "Middle East escalation after 7 Oct 2023.",
        ),
        GE(
            "eu_cbam_phasein_2023",
            "2023-10-01",
            None,
            "trade_agreement",
            2,
            "EU-IN",
            ("duty", "commodity:steel"),
            "manual_calendar",
            0.8,
            "EU CBAM transitional phase begins.",
        ),
        GE(
            "india_auto_duty_review_2024",
            "2024-07-01",
            "2024-07-01",
            "tariff",
            3,
            "IN-DOMESTIC",
            ("duty",),
            "manual_calendar",
            0.85,
            "Illustrative mid-2024 customs review on selected imported auto components.",
        ),
    ]


def load_geo_events(config: Config) -> List[GeoEvent]:
    """Load the curated event calendar from disk, seeding if missing."""
    path = config.paths.data_raw / config.geo.events_filename
    if not path.is_file():
        events = default_seed_events()
        path.parent.mkdir(parents=True, exist_ok=True)
        events_to_frame(events).to_csv(path, index=False)
        logger.info("seeded geo event calendar at %s (%d events)", path, len(events))
        return events

    frame = pd.read_csv(path)
    events = frame_to_events(frame)
    logger.info("loaded %d geo event(s) from %s", len(events), path)
    return events


def event_monthly_features(
    events: Sequence[GeoEvent], months: pd.DatetimeIndex, decay_half_life: float = 3.0
) -> pd.DataFrame:
    """Expand dated events into monthly dummy / decay / severity features."""
    rows = []
    for month in months:
        row: Dict[str, float] = {"month": month}
        for category in ("conflict", "tariff", "chokepoint", "sanction", "trade_agreement"):
            row[f"geo_event_{category}"] = 0.0
            row[f"geo_event_{category}_severity"] = 0.0
            row[f"geo_event_{category}_decay"] = 0.0
        row["geo_event_any"] = 0.0
        row["geo_event_max_severity"] = 0.0

        for event in events:
            start = pd.Timestamp(event.date_start).to_period("M").to_timestamp()
            end = (
                pd.Timestamp(event.date_end).to_period("M").to_timestamp()
                if event.date_end
                else start
            )
            # Active window
            active = start <= month <= end
            months_since = (month.year - start.year) * 12 + (month.month - start.month)
            if months_since < 0:
                continue
            decay = float(np.exp(-np.log(2) * months_since / max(decay_half_life, 0.5)))
            severity = float(event.severity)
            # Prefer NLP severity when present (Phase 5 hook)
            if event.nlp_severity is not None:
                severity = float(event.nlp_severity)

            key = event.category if event.category in (
                "conflict", "tariff", "chokepoint", "sanction", "trade_agreement"
            ) else "conflict"
            if active:
                row[f"geo_event_{key}"] = 1.0
                row[f"geo_event_{key}_severity"] = max(
                    row[f"geo_event_{key}_severity"], severity
                )
                row["geo_event_any"] = 1.0
                row["geo_event_max_severity"] = max(row["geo_event_max_severity"], severity)
            if months_since <= 12:
                row[f"geo_event_{key}_decay"] = max(
                    row[f"geo_event_{key}_decay"], decay * severity / 5.0
                )
        rows.append(row)
    return pd.DataFrame(rows)


def chokepoint_intensity(
    events: Sequence[GeoEvent], freight: MediatorSeries, months: pd.DatetimeIndex
) -> MediatorSeries:
    """Combine event-window chokepoint flags with freight z-scores."""
    event_feat = event_monthly_features(events, months)
    freight_z = causal_expanding_zscore(freight.values)
    intensity = (
        0.6 * event_feat.set_index("month")["geo_event_chokepoint_decay"].reindex(months).fillna(0.0)
        + 0.4 * freight_z.clip(lower=0.0) / 3.0
    )
    intensity = intensity.clip(lower=0.0).rename("chokepoint")
    source = "event+freight"
    if not freight.is_real:
        source = "event+freight-offline"
    return MediatorSeries(values=intensity, name="chokepoint", source=source, unit="intensity")


# --------------------------------------------------------------------------- #
# Bundle loader
# --------------------------------------------------------------------------- #


def load_geo_bundle(config: Config, months: pd.DatetimeIndex) -> GeoBundle:
    """Fetch every geo mediator covering the panel month window."""
    if not config.geo.enabled:
        # Zeroed stubs so feature code can stay uniform.
        zero = pd.Series(0.0, index=months)
        empty_events: List[GeoEvent] = []
        return GeoBundle(
            commodities={
                n: MediatorSeries(zero.rename(n), n, "disabled")
                for n in ("steel", "aluminium", "copper", "energy")
            },
            freight=MediatorSeries(zero.rename("freight"), "freight", "disabled"),
            gpr={
                k: MediatorSeries(zero.rename(k), k, "disabled")
                for k in ("overall", "threat", "act")
            },
            chokepoint=MediatorSeries(zero.rename("chokepoint"), "chokepoint", "disabled"),
            events=empty_events,
        )

    commodities = fetch_commodities(config, months)
    # Ensure core channels exist even if Pink Sheet only returned a subset
    defaults = {"steel": 700.0, "aluminium": 2200.0, "copper": 8500.0, "energy": 80.0}
    for i, (name, start) in enumerate(defaults.items()):
        if name not in commodities:
            commodities[name] = MediatorSeries(
                values=_offline_commodity(
                    months, name, start, config.project.random_seed + i
                ),
                name=name,
                source="offline-fallback",
                unit="usd",
            )

    freight = fetch_freight(config, months)
    gpr, _ = fetch_gpr(config, months)
    events = load_geo_events(config)
    choke = chokepoint_intensity(events, freight, months)

    logger.info(
        "geo bundle ready: commodities=%s freight=%s gpr=%s events=%d",
        {k: v.source for k, v in commodities.items()},
        freight.source,
        {k: v.source for k, v in gpr.items()},
        len(events),
    )
    return GeoBundle(
        commodities=commodities,
        freight=freight,
        gpr=gpr,
        chokepoint=choke,
        events=events,
    )


def geo_provenance(bundle: GeoBundle) -> Dict[str, object]:
    """Provenance block for report / dashboard."""
    mediators = []
    for name, series in bundle.all_mediators().items():
        mediators.append(
            {
                "name": name,
                "source": series.source,
                "isReal": series.is_real,
                "unit": series.unit,
                "first": round(float(series.values.iloc[0]), 4),
                "last": round(float(series.values.iloc[-1]), 4),
                "totalMovePct": round(series.total_move_pct(), 3),
            }
        )
    return {
        "mediators": mediators,
        "nEvents": len(bundle.events),
        "events": [e.as_dict() for e in bundle.events],
        "framework": framework_summary(),
        "commoditiesReal": all(
            m["isReal"]
            for m in mediators
            if m["name"] in ("steel", "aluminium", "copper", "energy")
        ),
        "freightReal": next(
            (bool(m["isReal"]) for m in mediators if m["name"] == "freight"), False
        ),
        "gprReal": all(
            m["isReal"] for m in mediators if str(m["name"]).startswith("gpr")
        ),
        "allReal": all(
            m["isReal"]
            for m in mediators
            if not str(m["name"]).startswith("chokepoint")
        ),
    }


def material_intensity_series(frame: pd.DataFrame) -> pd.Series:
    """Map each row's category to a [0, 1] material-intensity weight."""
    if "category_code" in frame.columns:
        return frame["category_code"].map(CATEGORY_MATERIAL_INTENSITY).fillna(0.5).astype(float)
    return pd.Series(0.5, index=frame.index, dtype=float)


# Display names written into the panel by the generator.
_MATERIAL_DISPLAY_TO_CMD = {
    "Steel": "steel",
    "Cast iron": "steel",
    "Aluminium": "aluminium",
    "Polymer": "energy",
    "Copper": "copper",
    "Polycarbonate": "copper",
    "Silicon": "copper",
}

_CATEGORY_TO_CMD = {
    "FST": "steel",
    "BDY": "steel",
    "CHS": "steel",
    "ITR": "energy",
    "BRK": "steel",
    "PWT": "aluminium",
    "HVC": "aluminium",
    "ELC": "copper",
    "LGT": "copper",
    "SNS": "copper",
}


def commodity_key_for_row(frame: pd.DataFrame) -> pd.Series:
    """Which commodity channel applies to each part row."""
    if "category_code" in frame.columns:
        return frame["category_code"].map(_CATEGORY_TO_CMD).fillna("steel")
    if "material" in frame.columns:
        return frame["material"].map(
            lambda m: _MATERIAL_DISPLAY_TO_CMD.get(str(m), MATERIAL_COMMODITY.get(str(m), "steel"))
        ).fillna("steel")
    return pd.Series("steel", index=frame.index)
