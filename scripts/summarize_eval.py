import json
from pathlib import Path

r = json.loads(Path("data/processed/evaluation_report.json").read_text(encoding="utf-8"))
print("nGeoFeatures", r["meta"]["nGeoFeatures"], "nFeatures", r["meta"]["nFeatures"])
print(
    "mediators:",
    [
        (m["name"], m["source"], m["isReal"])
        for m in r["meta"]["dataLayers"]["geo"]["mediators"]
        if m["name"] in ("steel", "aluminium", "copper", "freight", "gpr_overall")
    ],
)
print("--- verdicts ---")
for v in r["verdicts"]:
    print(f"[{v['verdict']}] {v['axis']}")
    print(" ", v["summary"][:160])
print("--- geo ablation arms ---")
for name, arm in r["geoAblation"]["arms"].items():
    recovery = arm.get("freightBetaRecovery") or {}
    print(
        f"  {name:7s} nGeo={arm['nGeoFeatures']:3d} "
        f"mape={arm['xgboostTestMape']} "
        f"freightSpearman={recovery.get('spearman')} ({recovery.get('verdict', 'n/a')})"
    )
print("  lifts", r["geoAblation"]["liftPctByArm"], "best", r["geoAblation"]["bestArm"])
print(
    "freight",
    {k: r["geoMechanism"]["freightBetaRecovery"].get(k) for k in ("spearman", "verdict")},
)
print(
    "mediation",
    {
        k: r["geoMechanism"]["mediation"].get(k)
        for k in ("totalCorrGprPrice", "partialCorrGprPriceGivenMediators")
    },
)
snr = r["geoMechanism"].get("signalToNoise") or {}
print("--- geo identifiability ---")
print("  category-mean noise %:", snr.get("categoryMeanNoisePct"))
for channel, stats in (snr.get("channels") or {}).items():
    print(
        f"  {channel:8s} signal={stats['signalPct']}% snr={stats['snr']} "
        f"identifiable={stats['identifiable']}"
    )
collin = r["geoMechanism"].get("collinearity") or {}
print("  separable from trend:", collin.get("separable"))
for row in collin.get("mediators", []):
    print(f"  {row['mediator']:10s} vsTime={row['cumulativeVsTime']}")
print("future", [(s["model"], s["mape"]) for s in r["futureTest"]["scores"]])
print("fx learn", r["fxIdentification"]["learning"].get("spearman"), r["fxIdentification"]["learning"].get("verdict"))
