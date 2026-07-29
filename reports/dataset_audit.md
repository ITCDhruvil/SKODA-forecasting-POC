# Dataset Sourcing Audit

_Generated 2026-07-28 11:22 UTC_

## Question

Is there a publicly available dataset of **monthly prices per automotive spare part** suitable for time-series forecasting?

## Sources evaluated

| Source | Type | Verdict | Reasoning |
|---|---|---|---|
| Kaggle - shorooq77/car-parts-price-estimation | Cross-sectional | **Rejected** | Maps part attributes to a single price. No date column, so no temporal dimension to forecast. |
| Kaggle - qubdidata/auto-parts-dataset | Cross-sectional | **Rejected** | Marketplace listing snapshot; one observation per part. |
| Kaggle - huseyincot/vehicle-spare-parts-index | Aggregate index | **Redundant** | Re-publication of the BLS index this module fetches live at source, with provenance intact. |
| Hyndman expsmooth - carparts (2,674 parts, monthly) | Panel time series | **Rejected** | Intermittent monthly demand counts, not prices. Right shape, wrong target variable. |
| FRED - PCU336310336310, PCU423100423100 | Aggregate index | **Unreachable** | Correct data, but fredgraph.csv times out from this environment (verified twice at 60s). BLS serves the same underlying series directly. |
| BLS public API v1 - CUUR0000SETC | Aggregate index | **ADOPTED as macro anchor** | CPI, Motor Vehicle Parts and Equipment, US city average, NSA, 1982-84=100. Monthly, no API key, verified returning 32 observations. Industry aggregate rather than per-SKU, so it anchors the trend but cannot supply the panel by itself. |

## Conclusion

**No public dataset provides per-SKU monthly price trajectories for automotive spare parts.** Real public data in this domain exists only as industry-level aggregate indices. Two failure modes were available:

1. Force-fit a cross-sectional dataset and pretend it is a time series.
2. Generate a fully synthetic panel with an invented inflation curve.

Both were rejected. The chosen approach is a **hybrid**: the real BLS index supplies the macro trend, and a synthetic SKU layer supplies the per-part structure (category seasonality, idiosyncratic drift, autocorrelated noise, structural breaks) that no public source offers.

This means the inflation path the models learn is genuine; the part-level variation around it is simulated to specification. That boundary is stated plainly rather than blurred.

## Anchor actually used in this run

- **Series**: `CUUR0000SETC`
- **Retrieval path**: `bls-cache`
- **Real data**: yes
- **Window**: 2023-07-01 to 2026-06-01 (36 months)
- **First real observation**: 2024-01-01
- **Back-extrapolated months**: 6
- **Total change across window**: +4.92%

> **Caveat**: the BLS public API v1 caps history at roughly three years, 6 month(s) short of the requested window. Those months were extended backwards at the observed mean log drift rather than padded with a repeated value. They are synthetic and should not be read as measured prices.
