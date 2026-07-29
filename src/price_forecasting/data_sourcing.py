"""Real-world price data sourcing, plus the record of why it looks like this.

Search summary (see :func:`write_dataset_audit` for the full artifact): there is
no public dataset giving *monthly prices per automotive SKU*. Candidate Kaggle
sets are cross-sectional; Hyndman's ``carparts`` is intermittent demand, not
price. Real, public, monthly automotive price data exists only as an industry
aggregate index.

So this module fetches that aggregate index - the BLS CPI series for "Motor
Vehicle Parts and Equipment" - and hands it to :mod:`data_generation`, which
uses it to drive the trend component of a synthetic SKU panel. The macro signal
is real; the per-part structure around it is simulated.

The BLS public API v1 requires no registration key but returns only the most
recent ~3 years, which can fall short of the requested history. The shortfall is
back-extrapolated and reported explicitly - never silently padded.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

from .config import Config
from .logging_utils import get_logger

logger = get_logger(__name__)

# Documented in the audit artifact and the final report. Kept as data so the
# report and the code cannot drift apart.
DATASET_SEARCH_RECORD = [
    {
        "source": "Kaggle - shorooq77/car-parts-price-estimation",
        "type": "Cross-sectional",
        "verdict": "Rejected",
        "reason": "Maps part attributes to a single price. No date column, so no "
                  "temporal dimension to forecast.",
    },
    {
        "source": "Kaggle - qubdidata/auto-parts-dataset",
        "type": "Cross-sectional",
        "verdict": "Rejected",
        "reason": "Marketplace listing snapshot; one observation per part.",
    },
    {
        "source": "Kaggle - huseyincot/vehicle-spare-parts-index",
        "type": "Aggregate index",
        "verdict": "Redundant",
        "reason": "Re-publication of the BLS index this module fetches live at "
                  "source, with provenance intact.",
    },
    {
        "source": "Hyndman expsmooth - carparts (2,674 parts, monthly)",
        "type": "Panel time series",
        "verdict": "Rejected",
        "reason": "Intermittent monthly demand counts, not prices. Right shape, "
                  "wrong target variable.",
    },
    {
        "source": "FRED - PCU336310336310, PCU423100423100",
        "type": "Aggregate index",
        "verdict": "Unreachable",
        "reason": "Correct data, but fredgraph.csv times out from this "
                  "environment (verified twice at 60s). BLS serves the same "
                  "underlying series directly.",
    },
    {
        "source": "BLS public API v1 - CUUR0000SETC",
        "type": "Aggregate index",
        "verdict": "ADOPTED as macro anchor",
        "reason": "CPI, Motor Vehicle Parts and Equipment, US city average, NSA, "
                  "1982-84=100. Monthly, no API key, verified returning 32 "
                  "observations. Industry aggregate rather than per-SKU, so it "
                  "anchors the trend but cannot supply the panel by itself.",
    },
]


@dataclass
class MacroSeries:
    """The macro price index used to anchor synthetic part trajectories.

    Attributes:
        values: Monthly index, indexed by month-start timestamps, ascending.
        series_id: BLS series identifier, or ``"offline-fallback"``.
        source: One of ``"bls-live"``, ``"bls-cache"``, ``"offline-fallback"``.
        observed_start: First month that came from real data (``None`` if offline).
        extrapolated_months: Count of months back-filled by extrapolation.
    """

    values: pd.Series
    series_id: str
    source: str
    observed_start: Optional[pd.Timestamp]
    extrapolated_months: int

    @property
    def is_real(self) -> bool:
        """True when at least part of the series came from the BLS API."""
        return self.source in ("bls-live", "bls-cache")

    def normalized(self) -> pd.Series:
        """Index rebased so the first month equals 1.0.

        The generator multiplies base prices by this, so what matters is the
        *shape* of the inflation path, not the 1982-84 base.
        """
        return self.values / self.values.iloc[0]

    def describe(self) -> str:
        """One-line provenance summary for logs and the report."""
        detail = f"{self.series_id} via {self.source}"
        if self.extrapolated_months:
            detail += f" (+{self.extrapolated_months} months back-extrapolated)"
        return detail


# --------------------------------------------------------------------------- #
# BLS API access
# --------------------------------------------------------------------------- #


def _cache_path(config: Config, series_id: str) -> Path:
    return config.paths.data_raw / f"bls_{series_id}.json"


def _cache_is_fresh(path: Path, ttl_days: int) -> bool:
    if not path.is_file():
        return False
    age_days = (time.time() - path.stat().st_mtime) / 86_400.0
    return age_days <= ttl_days


def _parse_bls_payload(payload: dict, series_id: str) -> pd.Series:
    """Turn a BLS API response into an ascending monthly Series.

    Raises:
        ValueError: If the payload reports failure or contains no monthly rows.
    """
    status = payload.get("status")
    if status != "REQUEST_SUCCEEDED":
        message = "; ".join(payload.get("message", [])) or "no message"
        raise ValueError(f"BLS request for {series_id} returned {status}: {message}")

    series_list = payload.get("Results", {}).get("series", [])
    if not series_list:
        raise ValueError(f"BLS response for {series_id} contained no series")

    rows = series_list[0].get("data", [])
    if not rows:
        raise ValueError(f"BLS series {series_id} returned zero observations")

    records = []
    for row in rows:
        period = row.get("period", "")
        # M01-M12 are months; M13 is an annual average and must be dropped or it
        # would appear as a spurious 13th observation for the year.
        if not period.startswith("M") or period == "M13":
            continue
        try:
            month = pd.Timestamp(year=int(row["year"]), month=int(period[1:]), day=1)
            records.append((month, float(row["value"])))
        except (KeyError, ValueError) as exc:
            logger.debug("skipping unparseable BLS row %s: %s", row, exc)

    if not records:
        raise ValueError(f"BLS series {series_id} yielded no usable monthly rows")

    frame = pd.DataFrame(records, columns=["month", "value"])
    series = frame.set_index("month")["value"].sort_index()
    series = series[~series.index.duplicated(keep="first")]
    series.name = series_id
    return series


def fetch_bls_series(config: Config, series_id: str) -> tuple[pd.Series, str]:
    """Fetch one BLS series, preferring a fresh local cache.

    Args:
        config: Pipeline configuration.
        series_id: BLS series identifier, e.g. ``"CUUR0000SETC"``.

    Returns:
        ``(series, source)`` where source is ``"bls-cache"`` or ``"bls-live"``.

    Raises:
        ValueError: If neither the cache nor the network yields usable data.
    """
    cache_file = _cache_path(config, series_id)

    if _cache_is_fresh(cache_file, config.sourcing.cache_ttl_days):
        logger.info("using cached BLS payload for %s (%s)", series_id, cache_file.name)
        try:
            payload = json.loads(cache_file.read_text(encoding="utf-8"))
            return _parse_bls_payload(payload, series_id), "bls-cache"
        except (json.JSONDecodeError, ValueError) as exc:
            logger.warning("cached payload for %s unusable (%s); refetching", series_id, exc)

    url = f"{config.sourcing.bls_api_base}/{series_id}"
    logger.info("fetching BLS series %s from %s", series_id, url)

    request = urllib.request.Request(
        url,
        headers={"User-Agent": "price-forecasting-poc/0.1 (+research)"},
    )
    with urllib.request.urlopen(
        request, timeout=config.sourcing.request_timeout_seconds
    ) as response:
        body = response.read().decode("utf-8")

    payload = json.loads(body)
    series = _parse_bls_payload(payload, series_id)

    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(body, encoding="utf-8")
    logger.info(
        "fetched %d monthly observations for %s (%s to %s); cached to %s",
        len(series),
        series_id,
        series.index.min().date(),
        series.index.max().date(),
        cache_file.name,
    )
    return series, "bls-live"


# --------------------------------------------------------------------------- #
# Gap handling and fallback
# --------------------------------------------------------------------------- #


def _back_extrapolate(series: pd.Series, target_start: pd.Timestamp) -> tuple[pd.Series, int]:
    """Extend a series backwards to ``target_start`` using its mean log drift.

    The BLS v1 API caps history at roughly three years, which can be a few
    months short of the window we need. Rather than repeating the first value
    (which would fabricate a flat stretch and bias the trend estimate toward
    zero), extend by the average month-over-month log change actually observed.

    Returns:
        ``(extended_series, n_extrapolated_months)``.
    """
    if series.index.min() <= target_start:
        return series, 0

    missing = pd.date_range(target_start, series.index.min(), freq="MS", inclusive="left")
    if len(missing) == 0:
        return series, 0

    mean_log_step = float(np.diff(np.log(series.to_numpy())).mean())
    first_value = float(series.iloc[0])

    # Walk backwards from the first real observation.
    steps_back = np.arange(len(missing), 0, -1)
    extrapolated = first_value * np.exp(-mean_log_step * steps_back)

    prefix = pd.Series(extrapolated, index=missing, name=series.name)
    logger.warning(
        "BLS history starts %s but %s is required; back-extrapolating %d month(s) "
        "at the observed mean drift of %.4f/month. These months are synthetic.",
        series.index.min().date(),
        target_start.date(),
        len(missing),
        mean_log_step,
    )
    return pd.concat([prefix, series]), len(missing)


def _offline_fallback(config: Config, months: pd.DatetimeIndex) -> pd.Series:
    """Deterministic inflation curve used when the BLS API cannot be reached.

    Keeps the pipeline runnable with no network. Flagged everywhere it is used
    so no reader mistakes it for real data.
    """
    monthly_rate = (1.0 + config.sourcing.offline_annual_inflation) ** (1 / 12) - 1.0
    values = 100.0 * (1.0 + monthly_rate) ** np.arange(len(months))
    logger.warning(
        "USING OFFLINE FALLBACK: no real BLS data available. Macro anchor is a "
        "synthetic %.1f%%/yr inflation curve. Results are not grounded in real "
        "price data.",
        config.sourcing.offline_annual_inflation * 100,
    )
    return pd.Series(values, index=months, name="offline-fallback")


def load_macro_anchor(config: Config) -> MacroSeries:
    """Obtain the macro price index covering the configured history window.

    Tries the primary BLS series, then the fallback series, then a synthetic
    offline curve. Whichever path is taken is recorded on the returned object
    and surfaced in the final report.
    """
    end_month = pd.Timestamp(config.generation.end_month + "-01")
    months = pd.date_range(
        end=end_month, periods=config.generation.history_months, freq="MS"
    )
    start_month = months[0]

    for series_id in (config.sourcing.series_id, config.sourcing.fallback_series_id):
        try:
            series, source = fetch_bls_series(config, series_id)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            logger.warning("network failure fetching %s: %s", series_id, exc)
            continue
        except (ValueError, json.JSONDecodeError) as exc:
            logger.warning("unusable response for %s: %s", series_id, exc)
            continue

        # Trim anything after our window, then fill any interior gaps.
        series = series[series.index <= end_month]
        if series.empty:
            logger.warning(
                "series %s has no observations at or before %s", series_id, end_month.date()
            )
            continue

        observed_start = series.index.min()
        series, n_extrapolated = _back_extrapolate(series, start_month)
        series = series.reindex(
            pd.date_range(series.index.min(), series.index.max(), freq="MS")
        ).interpolate(method="linear")

        window = series.reindex(months)
        if window.isna().any():
            # Most likely the series ends before our requested end_month.
            n_missing = int(window.isna().sum())
            logger.warning(
                "series %s does not cover %d month(s) of the requested window; "
                "carrying the last observation forward",
                series_id,
                n_missing,
            )
            window = window.ffill().bfill()

        logger.info(
            "macro anchor ready: %s, %d months, %s to %s",
            series_id,
            len(window),
            window.index.min().date(),
            window.index.max().date(),
        )
        return MacroSeries(
            values=window,
            series_id=series_id,
            source=source,
            observed_start=observed_start,
            extrapolated_months=n_extrapolated,
        )

    return MacroSeries(
        values=_offline_fallback(config, months),
        series_id="offline-fallback",
        source="offline-fallback",
        observed_start=None,
        extrapolated_months=len(months),
    )


# --------------------------------------------------------------------------- #
# Audit artifact
# --------------------------------------------------------------------------- #


def write_dataset_audit(config: Config, macro: MacroSeries) -> Path:
    """Write ``reports/dataset_audit.md`` documenting the dataset search.

    The brief asks for the search process to be documented and the choice
    justified. Generating it from :data:`DATASET_SEARCH_RECORD` keeps the
    written justification tied to the code that acts on it.
    """
    config.paths.reports.mkdir(parents=True, exist_ok=True)
    out_path = config.paths.reports / "dataset_audit.md"

    lines = [
        "# Dataset Sourcing Audit",
        "",
        f"_Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}_",
        "",
        "## Question",
        "",
        "Is there a publicly available dataset of **monthly prices per automotive "
        "spare part** suitable for time-series forecasting?",
        "",
        "## Sources evaluated",
        "",
        "| Source | Type | Verdict | Reasoning |",
        "|---|---|---|---|",
    ]
    for entry in DATASET_SEARCH_RECORD:
        lines.append(
            f"| {entry['source']} | {entry['type']} | **{entry['verdict']}** | {entry['reason']} |"
        )

    lines += [
        "",
        "## Conclusion",
        "",
        "**No public dataset provides per-SKU monthly price trajectories for "
        "automotive spare parts.** Real public data in this domain exists only as "
        "industry-level aggregate indices. Two failure modes were available:",
        "",
        "1. Force-fit a cross-sectional dataset and pretend it is a time series.",
        "2. Generate a fully synthetic panel with an invented inflation curve.",
        "",
        "Both were rejected. The chosen approach is a **hybrid**: the real BLS "
        "index supplies the macro trend, and a synthetic SKU layer supplies the "
        "per-part structure (category seasonality, idiosyncratic drift, "
        "autocorrelated noise, structural breaks) that no public source offers.",
        "",
        "This means the inflation path the models learn is genuine; the "
        "part-level variation around it is simulated to specification. That "
        "boundary is stated plainly rather than blurred.",
        "",
        "## Anchor actually used in this run",
        "",
        f"- **Series**: `{macro.series_id}`",
        f"- **Retrieval path**: `{macro.source}`",
        f"- **Real data**: {'yes' if macro.is_real else 'NO - offline fallback curve'}",
        f"- **Window**: {macro.values.index.min().date()} to {macro.values.index.max().date()} "
        f"({len(macro.values)} months)",
        f"- **First real observation**: "
        f"{macro.observed_start.date() if macro.observed_start is not None else 'n/a'}",
        f"- **Back-extrapolated months**: {macro.extrapolated_months}",
        f"- **Total change across window**: "
        f"{(macro.values.iloc[-1] / macro.values.iloc[0] - 1) * 100:+.2f}%",
        "",
    ]

    if macro.extrapolated_months:
        lines += [
            f"> **Caveat**: the BLS public API v1 caps history at roughly three "
            f"years, {macro.extrapolated_months} month(s) short of the requested "
            f"window. Those months were extended backwards at the observed mean "
            f"log drift rather than padded with a repeated value. They are "
            f"synthetic and should not be read as measured prices.",
            "",
        ]

    if not macro.is_real:
        lines += [
            "> **Warning**: this run did **not** reach the BLS API. The macro "
            "anchor is a synthetic inflation curve, so nothing in this run is "
            "grounded in real price data.",
            "",
        ]

    out_path.write_text("\n".join(lines), encoding="utf-8")
    logger.info("wrote dataset audit to %s", out_path)
    return out_path
