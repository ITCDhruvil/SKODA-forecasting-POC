"""Logging setup and reproducibility banner.

Two jobs:

1. Configure a single console handler for the whole pipeline.
2. Record the exact library versions and random seed at the top of every run,
   so a result can be traced back to the environment that produced it.
"""

from __future__ import annotations

import importlib
import logging
import platform
import sys
from typing import Dict, Optional

# Libraries whose versions materially affect results and are worth pinning in
# the run log and the final report.
TRACKED_PACKAGES = (
    "numpy",
    "pandas",
    "scipy",
    "sklearn",
    "statsmodels",
    "xgboost",
    "matplotlib",
    "seaborn",
    "yaml",
)

_CONFIGURED = False


def configure_logging(
    level: str = "INFO",
    fmt: str = "%(asctime)s | %(levelname)-8s | %(name)-28s | %(message)s",
    datefmt: str = "%H:%M:%S",
) -> None:
    """Install a single stdout handler on the root logger.

    Safe to call repeatedly; only the first call takes effect, so importing a
    module twice does not produce duplicated log lines.
    """
    global _CONFIGURED
    if _CONFIGURED:
        return

    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(logging.Formatter(fmt=fmt, datefmt=datefmt))

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # statsmodels emits a convergence warning per part during SARIMA fitting.
    # Those are handled explicitly by the fallback ladder in modeling.py, so
    # keep them out of the console and let our own messages carry the signal.
    logging.getLogger("statsmodels").setLevel(logging.ERROR)

    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """Return a module-scoped logger."""
    return logging.getLogger(name)


def collect_versions() -> Dict[str, str]:
    """Return ``{package: version}`` for every tracked library.

    Missing packages are recorded as ``"not installed"`` rather than raising,
    so the banner still prints in a partial environment.
    """
    versions: Dict[str, str] = {"python": platform.python_version()}
    for package in TRACKED_PACKAGES:
        try:
            module = importlib.import_module(package)
            versions[package] = getattr(module, "__version__", "unknown")
        except ImportError:
            versions[package] = "not installed"
    return versions


def log_run_banner(logger: logging.Logger, seed: Optional[int] = None) -> Dict[str, str]:
    """Log the environment fingerprint and return it for inclusion in the report."""
    versions = collect_versions()
    logger.info("-" * 78)
    logger.info("Automotive parts price forecasting - run environment")
    logger.info("platform : %s", platform.platform())
    if seed is not None:
        logger.info("seed     : %s", seed)
    logger.info(
        "versions : %s",
        ", ".join(f"{name}={version}" for name, version in versions.items()),
    )
    logger.info("-" * 78)
    return versions
