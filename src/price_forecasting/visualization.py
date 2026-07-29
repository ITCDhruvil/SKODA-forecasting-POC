"""Figures for the summary report.

All output goes to ``reports/figures``. Matplotlib runs on the non-interactive
Agg backend so the pipeline works headless.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Sequence

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

from .config import Config
from .data_sourcing import MacroSeries
from .logging_utils import get_logger

logger = get_logger(__name__)

MODEL_COLORS = {
    "xgboost": "#2274A5",
    "sarima": "#D1495B",
    "seasonal_naive": "#8D99AE",
    "category_median_fallback": "#7B9E89",
}


def apply_style(config: Config) -> None:
    """Set a consistent seaborn/matplotlib style for every figure."""
    sns.set_theme(style=config.visualization.style, palette=config.visualization.palette)
    plt.rcParams.update(
        {
            "figure.dpi": config.visualization.dpi,
            "savefig.dpi": config.visualization.dpi,
            "savefig.bbox": "tight",
            "axes.titlesize": 11,
            "axes.labelsize": 9,
            "xtick.labelsize": 8,
            "ytick.labelsize": 8,
            "legend.fontsize": 8,
        }
    )


def _save(fig: plt.Figure, config: Config, name: str) -> Path:
    config.paths.figures.mkdir(parents=True, exist_ok=True)
    path = config.paths.figures / name
    fig.savefig(path)
    plt.close(fig)
    logger.info("wrote figure %s (%.0f KB)", path.name, path.stat().st_size / 1024)
    return path


def _select_grid_parts(
    panel: pd.DataFrame, forecasts: pd.DataFrame, n: int
) -> List[str]:
    """Choose parts for the side-by-side grid.

    Deliberately mixes anomaly parts with normal ones spanning the price range,
    so the grid shows both the easy and the hard cases rather than a flattering
    selection.
    """
    anomalies = panel.loc[panel["is_anomaly_part"], "part_id"].unique().tolist()
    covered = set(forecasts["part_id"].unique())
    anomalies = [p for p in anomalies if p in covered]

    normals = (
        panel[~panel["is_anomaly_part"] & panel["part_id"].isin(covered)]
        .groupby("part_id")["price"]
        .mean()
        .sort_values()
    )
    if normals.empty:
        return anomalies[:n]

    remaining = max(n - len(anomalies), 0)
    # Spread across the price distribution rather than taking the cheapest.
    positions = np.linspace(0, len(normals) - 1, num=min(remaining, len(normals)))
    picked = [normals.index[int(round(p))] for p in positions]

    seen: set[str] = set()
    ordered = []
    for part_id in anomalies + picked:
        if part_id not in seen:
            seen.add(part_id)
            ordered.append(part_id)
    return ordered[:n]


# --------------------------------------------------------------------------- #
# Figure 1 - the required side-by-side forecast grid
# --------------------------------------------------------------------------- #


def plot_forecast_grid(
    config: Config,
    panel: pd.DataFrame,
    holdout: pd.DataFrame,
    forecasts: pd.DataFrame,
    model: str = "xgboost",
) -> Path:
    """Multiple parts side by side: history, holdout fit, and forward forecast.

    Each panel shows the observed series, the model's predictions over the
    held-out window (so the reader can judge the fit against truth), and the
    forward forecast with its interval.
    """
    apply_style(config)
    n = config.visualization.grid_parts
    part_ids = _select_grid_parts(panel, forecasts[forecasts["model"] == model], n)

    ncols = 3
    nrows = int(np.ceil(len(part_ids) / ncols))
    fig, axes = plt.subplots(
        nrows,
        ncols,
        figsize=(config.visualization.figure_width, 3.1 * nrows),
        sharex=True,
    )
    axes = np.atleast_1d(axes).ravel()

    model_holdout = holdout[holdout["model"] == model]
    model_forecast = forecasts[forecasts["model"] == model]

    for ax, part_id in zip(axes, part_ids):
        history = panel[panel["part_id"] == part_id].sort_values("month")
        ax.plot(
            history["month"],
            history["price"],
            color="#2B2D42",
            linewidth=1.5,
            label="Actual",
            zorder=3,
        )

        fitted = model_holdout[model_holdout["part_id"] == part_id].sort_values(
            "target_month"
        )
        if not fitted.empty:
            ax.plot(
                fitted["target_month"],
                fitted["prediction"],
                color=MODEL_COLORS.get(model, "#2274A5"),
                linestyle="--",
                marker="o",
                markersize=3,
                linewidth=1.3,
                label="Holdout prediction",
                zorder=4,
            )

        future = model_forecast[model_forecast["part_id"] == part_id].sort_values(
            "target_month"
        )
        if not future.empty:
            last_month = history["month"].max()
            last_price = history["price"].iloc[-1]
            months = [last_month] + future["target_month"].tolist()
            values = [last_price] + future["prediction"].tolist()

            ax.plot(
                months,
                values,
                color="#F18F01",
                marker="s",
                markersize=3,
                linewidth=1.6,
                label="Forward forecast",
                zorder=5,
            )
            if future["lower"].notna().all():
                ax.fill_between(
                    future["target_month"],
                    future["lower"],
                    future["upper"],
                    color="#F18F01",
                    alpha=0.20,
                    linewidth=0,
                    label=f"{int(config.evaluation.prediction_interval*100)}% interval",
                    zorder=2,
                )
            ax.axvline(last_month, color="#adb5bd", linestyle=":", linewidth=1)

        is_anomaly = bool(history["is_anomaly_part"].iloc[0])
        anomaly_type = history["anomaly_type"].iloc[0]
        title = f"{part_id} - {history['category'].iloc[0]}"
        if is_anomaly and anomaly_type:
            title += f"\n[{anomaly_type}]"
        ax.set_title(title, color="#D1495B" if is_anomaly else "#2B2D42")
        ax.set_ylabel("Price (USD)")
        ax.tick_params(axis="x", rotation=45)

    for ax in axes[len(part_ids) :]:
        ax.set_visible(False)

    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="lower center", ncol=4, frameon=False)
    fig.suptitle(
        f"Monthly price forecasts - {model} "
        f"(dotted line marks end of observed history)",
        fontsize=13,
    )
    fig.tight_layout(rect=(0, 0.04, 1, 0.97))
    return _save(fig, config, "forecast_grid.png")


# --------------------------------------------------------------------------- #
# Figure 2 - anomaly parts
# --------------------------------------------------------------------------- #


def plot_anomaly_parts(
    config: Config, panel: pd.DataFrame, holdout: pd.DataFrame
) -> Optional[Path]:
    """Show every structural-break part and how each model handled it."""
    apply_style(config)
    anomaly_ids = panel.loc[panel["is_anomaly_part"], "part_id"].unique().tolist()
    if not anomaly_ids:
        return None

    ncols = 2
    nrows = int(np.ceil(len(anomaly_ids) / ncols))
    fig, axes = plt.subplots(
        nrows, ncols, figsize=(config.visualization.figure_width, 3.4 * nrows)
    )
    axes = np.atleast_1d(axes).ravel()

    for ax, part_id in zip(axes, anomaly_ids):
        history = panel[panel["part_id"] == part_id].sort_values("month")
        ax.plot(
            history["month"],
            history["price"],
            color="#2B2D42",
            linewidth=1.6,
            label="Actual",
            zorder=3,
        )

        for model in ("xgboost", "sarima", "seasonal_naive"):
            subset = holdout[
                (holdout["model"] == model) & (holdout["part_id"] == part_id)
            ].sort_values("target_month")
            if subset.empty:
                continue
            ax.plot(
                subset["target_month"],
                subset["prediction"],
                linestyle="--",
                marker="o",
                markersize=3,
                linewidth=1.2,
                color=MODEL_COLORS[model],
                label=model,
                zorder=4,
            )

        ax.set_title(
            f"{part_id} - {history['category'].iloc[0]}\n"
            f"{history['anomaly_type'].iloc[0]}"
        )
        ax.set_ylabel("Price (USD)")
        ax.tick_params(axis="x", rotation=45)

    for ax in axes[len(anomaly_ids) :]:
        ax.set_visible(False)

    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="lower center", ncol=4, frameon=False)
    fig.suptitle("Structural-break parts: model behaviour under regime change", fontsize=13)
    fig.tight_layout(rect=(0, 0.05, 1, 0.96))
    return _save(fig, config, "anomaly_parts.png")


# --------------------------------------------------------------------------- #
# Figure 3 - model comparison
# --------------------------------------------------------------------------- #


def plot_model_comparison(config: Config, metrics: pd.DataFrame) -> Path:
    """Bar chart of MAE / RMSE / MAPE per model on the common part set."""
    apply_style(config)
    fig, axes = plt.subplots(1, 3, figsize=(config.visualization.figure_width, 4.0))

    for ax, metric, label in zip(
        axes, ("mae", "rmse", "mape"), ("MAE (USD)", "RMSE (USD)", "MAPE (%)")
    ):
        ordered = metrics.sort_values(metric)
        colors = [MODEL_COLORS.get(m, "#888888") for m in ordered["model"]]
        bars = ax.bar(ordered["model"], ordered[metric], color=colors)
        ax.set_title(label)
        ax.tick_params(axis="x", rotation=20)
        ax.bar_label(bars, fmt="%.2f", padding=2, fontsize=8)
        ax.margins(y=0.15)

    fig.suptitle(
        "Model comparison on the common part set (lower is better)", fontsize=13
    )
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    return _save(fig, config, "model_comparison.png")


# --------------------------------------------------------------------------- #
# Figure 4 - backtest stability
# --------------------------------------------------------------------------- #


def plot_backtest_stability(config: Config, backtest_metrics: pd.DataFrame) -> Path:
    """MAE and MAPE per backtest fold - is accuracy stable across origins?"""
    apply_style(config)
    fig, axes = plt.subplots(1, 2, figsize=(config.visualization.figure_width, 4.0))

    for ax, metric, label in zip(axes, ("mae", "mape"), ("MAE (USD)", "MAPE (%)")):
        for model, group in backtest_metrics.groupby("model"):
            group = group.sort_values("fold")
            ax.plot(
                group["fold"],
                group[metric],
                marker="o",
                linewidth=1.6,
                label=str(model),
                color=MODEL_COLORS.get(str(model), "#888888"),
            )
        ax.set_xlabel("Backtest fold (expanding window)")
        ax.set_ylabel(label)
        ax.set_title(f"{label} by fold")
        ax.set_xticks(sorted(backtest_metrics["fold"].unique()))

    axes[0].legend(frameon=False)
    fig.suptitle("Forecast stability across rolling origins", fontsize=13)
    fig.tight_layout(rect=(0, 0, 1, 0.93))
    return _save(fig, config, "backtest_stability.png")


# --------------------------------------------------------------------------- #
# Figure 5 - category trajectories
# --------------------------------------------------------------------------- #


def plot_category_trajectories(config: Config, panel: pd.DataFrame) -> Path:
    """Indexed mean price path per category over the focus window.

    Indexed to 100 at the window start, because categories differ by an order of
    magnitude in absolute price and raw levels would hide the seasonal shapes.
    """
    apply_style(config)
    focus_start = panel["month"].max() - pd.DateOffset(
        months=config.generation.focus_months - 1
    )
    focus = panel[panel["month"] >= focus_start]

    mean_price = focus.groupby(["category", "month"])["price"].mean().reset_index()
    fig, ax = plt.subplots(figsize=(config.visualization.figure_width, 5.0))

    for category, group in mean_price.groupby("category"):
        group = group.sort_values("month")
        indexed = 100.0 * group["price"] / group["price"].iloc[0]
        ax.plot(group["month"], indexed, marker="o", markersize=3, linewidth=1.5, label=category)

    ax.axhline(100.0, color="#adb5bd", linestyle=":", linewidth=1)
    ax.set_ylabel(f"Mean price, indexed to 100 at {focus_start.date()}")
    ax.set_xlabel("Month")
    ax.set_title(
        f"Category price trajectories over the most recent {config.generation.focus_months} months"
    )
    ax.legend(frameon=False, ncol=4, fontsize=8)
    fig.tight_layout()
    return _save(fig, config, "category_trajectories.png")


# --------------------------------------------------------------------------- #
# Figure 6 - macro anchor validation
# --------------------------------------------------------------------------- #


def plot_macro_anchor(
    config: Config, panel: pd.DataFrame, macro: MacroSeries
) -> Path:
    """Real BLS index against the synthetic panel mean.

    A validation plot, not decoration: if the synthetic panel did not track the
    real index, the anchoring step silently failed and every downstream trend
    claim would be unfounded.
    """
    apply_style(config)
    panel_mean = panel.groupby("month")["price"].mean()
    panel_indexed = 100.0 * panel_mean / panel_mean.iloc[0]
    macro_indexed = 100.0 * macro.values / macro.values.iloc[0]

    fig, ax = plt.subplots(figsize=(config.visualization.figure_width, 5.0))
    ax.plot(
        macro_indexed.index,
        macro_indexed.to_numpy(),
        color="#D1495B",
        linewidth=2.2,
        label=f"Real BLS index ({macro.series_id})",
    )
    ax.plot(
        panel_indexed.index,
        panel_indexed.to_numpy(),
        color="#2274A5",
        linewidth=1.8,
        linestyle="--",
        label="Synthetic panel mean price",
    )

    if macro.observed_start is not None and macro.extrapolated_months:
        ax.axvspan(
            macro.values.index.min(),
            macro.observed_start,
            color="#ffd6a5",
            alpha=0.45,
            linewidth=0,
            label="Back-extrapolated (not measured)",
        )

    # The honest validation is whether the *shape* transfers, not whether the
    # levels coincide. They should not coincide: the panel carries a part-level
    # drift term on top of the macro index, so it is expected to run ahead of it
    # by roughly drift_mu * n_months. Correlating month-over-month changes tests
    # the thing that actually matters - did the real signal propagate?
    macro_changes = macro.values.pct_change().dropna()
    panel_changes = panel_mean.pct_change().dropna()
    aligned = pd.concat([macro_changes, panel_changes], axis=1, join="inner").dropna()
    correlation = float(aligned.corr().iloc[0, 1]) if len(aligned) > 2 else float("nan")

    macro_total = (macro.values.iloc[-1] / macro.values.iloc[0] - 1) * 100
    panel_total = (panel_mean.iloc[-1] / panel_mean.iloc[0] - 1) * 100
    expected_drift = config.generation.drift_mu * len(macro.values) * 100

    ax.set_ylabel("Index (start month = 100)")
    ax.set_xlabel("Month")
    ax.set_title(
        "Anchor validation: the real BLS signal propagates into the synthetic panel\n"
        f"month-over-month correlation r = {correlation:.2f}   |   "
        f"BLS {macro_total:+.2f}% vs panel {panel_total:+.2f}%\n"
        f"the level gap is expected: part-level drift adds ~{expected_drift:+.1f}% "
        f"on top of the macro index",
        fontsize=11,
    )
    ax.legend(frameon=False, loc="upper left")
    fig.tight_layout()
    return _save(fig, config, "macro_anchor.png")


def generate_all_figures(
    config: Config,
    panel: pd.DataFrame,
    holdout: pd.DataFrame,
    backtest_metrics: pd.DataFrame,
    comparison: pd.DataFrame,
    forecasts: pd.DataFrame,
    macro: MacroSeries,
) -> Dict[str, Path]:
    """Render every report figure. Returns ``{key: path}``."""
    figures: Dict[str, Path] = {}
    figures["forecast_grid"] = plot_forecast_grid(config, panel, holdout, forecasts)

    anomaly_figure = plot_anomaly_parts(config, panel, holdout)
    if anomaly_figure is not None:
        figures["anomaly_parts"] = anomaly_figure

    if not comparison.empty:
        figures["model_comparison"] = plot_model_comparison(config, comparison)
    if not backtest_metrics.empty:
        figures["backtest_stability"] = plot_backtest_stability(config, backtest_metrics)

    figures["category_trajectories"] = plot_category_trajectories(config, panel)
    figures["macro_anchor"] = plot_macro_anchor(config, panel, macro)

    logger.info("generated %d figures in %s", len(figures), config.paths.figures)
    return figures
