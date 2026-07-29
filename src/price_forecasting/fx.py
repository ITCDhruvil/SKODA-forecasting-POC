"""Foreign exchange rates - the second real-data anchor.

Automotive components are priced in the assembly plant's currency (INR for a
SKODA Kushaq built at Pune), but a large share of input cost is not. Semiconductors,
LED dies, bearings and specialty polymers are imported and invoiced in EUR or
USD; steel, copper and oil-linked polymers are locally bought but priced off
globally-traded benchmarks. When the rupee weakens, both channels push component
prices up - at different speeds and by different amounts.

This module supplies the real rates that drive that mechanism:

* ``EUR/INR`` - direct import invoicing from European tier-1 suppliers.
* ``USD/INR`` - the commodity channel, since steel, copper and crude are quoted
  in dollars regardless of where they are bought.

Source is the ECB reference rate via Frankfurter, which needs no API key. Daily
rates are aggregated to a monthly average rather than a month-end snapshot,
because a procurement contract repricing over a month is exposed to the average
rate, not to whatever the rate happened to be on the last business day.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from .config import Config
from .logging_utils import get_logger

logger = get_logger(__name__)


@dataclass
class FxSeries:
    """One currency pair's monthly average rate, with provenance.

    Attributes:
        values: Monthly average rate, indexed by month start, ascending.
        pair: e.g. ``"EURINR"``.
        base: Foreign currency being bought, e.g. ``"EUR"``.
        quote: Domestic currency, e.g. ``"INR"``.
        source: ``"ecb-live"``, ``"ecb-cache"`` or ``"offline-fallback"``.
        observed_start: First month backed by real observations.
        extrapolated_months: Months back-filled because the API did not reach
            far enough.
    """

    values: pd.Series
    pair: str
    base: str
    quote: str
    source: str
    observed_start: Optional[pd.Timestamp]
    extrapolated_months: int

    @property
    def is_real(self) -> bool:
        return self.source in ("ecb-live", "ecb-cache")

    def normalized(self) -> pd.Series:
        """Rate rebased so the first month equals 1.0.

        A rise means the domestic currency has weakened, so imported input costs
        have risen - which is the direction that matters for pricing.
        """
        return self.values / self.values.iloc[0]

    def log_return(self, periods: int = 1) -> pd.Series:
        """Month-over-month log change. The natural scale for pass-through."""
        return np.log(self.values).diff(periods)

    def describe(self) -> str:
        detail = f"{self.pair} via {self.source}"
        if self.extrapolated_months:
            detail += f" (+{self.extrapolated_months} months back-extrapolated)"
        return detail

    def total_move_pct(self) -> float:
        return float((self.values.iloc[-1] / self.values.iloc[0] - 1) * 100)


# --------------------------------------------------------------------------- #
# Fetching
# --------------------------------------------------------------------------- #


def _cache_path(config: Config, pair: str) -> Path:
    return config.paths.data_raw / f"fx_{pair}.json"


def _cache_is_fresh(path: Path, ttl_days: int) -> bool:
    if not path.is_file():
        return False
    return (time.time() - path.stat().st_mtime) / 86_400.0 <= ttl_days


def _parse_frankfurter(payload: dict, base: str, quote: str) -> pd.Series:
    """Aggregate Frankfurter's daily rates into a monthly average.

    Raises:
        ValueError: If the payload has no usable rates.
    """
    rates = payload.get("rates")
    if not rates:
        raise ValueError(f"FX payload for {base}/{quote} contained no rates")

    records: List[Tuple[pd.Timestamp, float]] = []
    for day, quotes in rates.items():
        value = quotes.get(quote)
        if value is None:
            continue
        try:
            records.append((pd.Timestamp(day), float(value)))
        except (TypeError, ValueError):
            continue

    if not records:
        raise ValueError(f"no {quote} quotes found in {base} payload")

    daily = pd.Series(dict(records)).sort_index()
    # Month average: a contract repricing across a month is exposed to the
    # average rate, not to the closing snapshot.
    monthly = daily.resample("MS").mean()
    monthly.name = f"{base}{quote}"
    return monthly.dropna()


def fetch_fx_pair(
    config: Config, base: str, quote: str, start: pd.Timestamp, end: pd.Timestamp
) -> Tuple[pd.Series, str]:
    """Fetch one currency pair, preferring a fresh local cache.

    Returns:
        ``(monthly_series, source)`` where source is ``"ecb-cache"`` or
        ``"ecb-live"``.

    Raises:
        ValueError / URLError: If neither cache nor network yields usable data.
    """
    pair = f"{base}{quote}"
    cache_file = _cache_path(config, pair)

    if _cache_is_fresh(cache_file, config.sourcing.cache_ttl_days):
        logger.info("using cached FX payload for %s", pair)
        try:
            payload = json.loads(cache_file.read_text(encoding="utf-8"))
            return _parse_frankfurter(payload, base, quote), "ecb-cache"
        except (json.JSONDecodeError, ValueError) as exc:
            logger.warning("cached FX payload for %s unusable (%s); refetching", pair, exc)

    url = (
        f"{config.fx.api_base}/{start.date()}..{end.date()}"
        f"?from={base}&to={quote}"
    )
    logger.info("fetching FX %s from %s", pair, url)

    request = urllib.request.Request(
        url, headers={"User-Agent": "price-forecasting-poc/0.1 (+research)"}
    )
    with urllib.request.urlopen(
        request, timeout=config.sourcing.request_timeout_seconds
    ) as response:
        body = response.read().decode("utf-8")

    payload = json.loads(body)
    series = _parse_frankfurter(payload, base, quote)

    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(body, encoding="utf-8")
    logger.info(
        "fetched %d monthly %s observations (%s to %s); cached",
        len(series),
        pair,
        series.index.min().date(),
        series.index.max().date(),
    )
    return series, "ecb-live"


def _back_extrapolate(series: pd.Series, target_start: pd.Timestamp) -> Tuple[pd.Series, int]:
    """Extend backwards at the observed mean log drift, never by repeating."""
    if series.index.min() <= target_start:
        return series, 0

    missing = pd.date_range(target_start, series.index.min(), freq="MS", inclusive="left")
    if len(missing) == 0:
        return series, 0

    mean_step = float(np.diff(np.log(series.to_numpy())).mean())
    first = float(series.iloc[0])
    steps_back = np.arange(len(missing), 0, -1)
    prefix = pd.Series(first * np.exp(-mean_step * steps_back), index=missing, name=series.name)

    logger.warning(
        "FX %s starts %s but %s required; back-extrapolating %d month(s) at the "
        "observed drift. These months are synthetic.",
        series.name,
        series.index.min().date(),
        target_start.date(),
        len(missing),
    )
    return pd.concat([prefix, series]), len(missing)


def _offline_fallback(
    months: pd.DatetimeIndex, base: str, quote: str, start_rate: float, seed: int
) -> pd.Series:
    """Deterministic random-walk FX path, used only when the API is unreachable.

    FX really is close to a random walk, so this is a defensible stand-in - but
    it is flagged everywhere it is used so nobody mistakes it for real data.
    """
    rng = np.random.default_rng(seed)
    steps = rng.normal(0.0015, 0.015, size=len(months))
    steps[0] = 0.0
    values = start_rate * np.exp(np.cumsum(steps))
    logger.warning(
        "USING OFFLINE FX FALLBACK for %s%s: synthetic random walk, not real "
        "rates. FX-driven results in this run are not grounded in reality.",
        base,
        quote,
    )
    return pd.Series(values, index=months, name=f"{base}{quote}")


def load_fx_series(
    config: Config, months: pd.DatetimeIndex
) -> Dict[str, FxSeries]:
    """Load every configured currency pair over the requested month window.

    Returns:
        ``{pair: FxSeries}`` covering exactly ``months``.
    """
    start = months.min()
    end = months.max() + pd.offsets.MonthEnd(1)
    result: Dict[str, FxSeries] = {}

    for spec in config.fx.pairs:
        base, quote = spec["base"], spec["quote"]
        pair = f"{base}{quote}"

        try:
            series, source = fetch_fx_pair(config, base, quote, start, end)
            observed_start = series.index.min()
            series, n_extrapolated = _back_extrapolate(series, start)
            window = series.reindex(
                pd.date_range(series.index.min(), max(series.index.max(), end), freq="MS")
            ).interpolate().reindex(months)

            if window.isna().any():
                window = window.ffill().bfill()
                logger.warning("%s required forward-fill to cover the window", pair)

            result[pair] = FxSeries(
                values=window,
                pair=pair,
                base=base,
                quote=quote,
                source=source,
                observed_start=observed_start,
                extrapolated_months=n_extrapolated,
            )
            logger.info(
                "FX %s ready: %.4f -> %.4f (%+.2f%% over %d months)",
                pair,
                window.iloc[0],
                window.iloc[-1],
                (window.iloc[-1] / window.iloc[0] - 1) * 100,
                len(window),
            )

        except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
            logger.warning("could not fetch FX %s (%s); using offline fallback", pair, exc)
            result[pair] = FxSeries(
                values=_offline_fallback(
                    months, base, quote, float(spec.get("fallback_rate", 90.0)),
                    config.project.random_seed,
                ),
                pair=pair,
                base=base,
                quote=quote,
                source="offline-fallback",
                observed_start=None,
                extrapolated_months=len(months),
            )

    return result


def fx_provenance(fx: Dict[str, FxSeries]) -> Dict[str, object]:
    """Provenance block for the report and dashboard."""
    return {
        "pairs": [
            {
                "pair": series.pair,
                "base": series.base,
                "quote": series.quote,
                "source": series.source,
                "isReal": series.is_real,
                "extrapolatedMonths": series.extrapolated_months,
                "firstRate": round(float(series.values.iloc[0]), 4),
                "lastRate": round(float(series.values.iloc[-1]), 4),
                "totalMovePct": round(series.total_move_pct(), 3),
                "observedStart": (
                    series.observed_start.strftime("%Y-%m")
                    if series.observed_start is not None
                    else None
                ),
            }
            for series in fx.values()
        ],
        "allReal": all(series.is_real for series in fx.values()),
    }
