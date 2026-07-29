"""Automotive spare parts monthly price forecasting - proof of concept.

Pipeline stages, in dependency order:

    data_sourcing   -> fetch the real BLS price index used as a macro anchor
    data_generation -> build the synthetic SKU-level price panel around it
    preprocessing   -> clean, flag outliers, engineer leak-free features
    modeling        -> seasonal-naive baseline, per-part SARIMA, global XGBoost
    evaluation      -> metrics, time-based splits, rolling-origin backtest
    visualization   -> figures
    report          -> reports/report.md

Orchestrated by ``price_forecasting.pipeline``.
"""

__version__ = "0.1.0"
