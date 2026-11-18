"""Builds demo/kushaq_aluminium.json: a real, small, explainable forecast of
aluminium (World Bank Pink Sheet) used for the SKODA Kushaq management demo."""
import json, re, pathlib, numpy as np, pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import RidgeCV
from sklearn.inspection import permutation_importance

ROOT = pathlib.Path(__file__).resolve().parents[1]
raw = pd.read_excel(ROOT/"data/raw/pink_sheet_monthly.xlsx", sheet_name="Monthly Prices", header=None)
names = [re.sub(r"\s*\(.*\)|\s*\*+", "", str(a)).strip() for a in raw.iloc[4]]
df = raw.iloc[6:].copy(); df.columns = names
df.index = pd.to_datetime(df.iloc[:,0].str.replace("M","-")+"-01"); df = df.iloc[:,1:]
df = df.apply(pd.to_numeric, errors="coerce")
cols = {"Aluminum":"Aluminium","Crude oil, Brent":"Brent crude oil","Natural gas, Europe":"European natural gas",
        "Coal, Australian":"Coal (power cost)","Copper":"Copper","Zinc":"Zinc","Iron ore, cfr spot":"Iron ore","Nickel":"Nickel"}
d = df[list(cols)].rename(columns=cols).loc["2001-01-01":].dropna()
last = d.index[-1]; H = 3  # forecast 3 months ahead per step, rolled to 6 below
lg = np.log(d)
F = pd.DataFrame(index=d.index)
for h in (1,3,6,12):
    F[f"Aluminium price change, last {h} mo"] = lg["Aluminium"].diff(h)
F["Aluminium vs its 12-month average"] = lg["Aluminium"] - lg["Aluminium"].rolling(12).mean()
for c,lab in [("Brent crude oil","Oil"),("European natural gas","European gas"),("Coal (power cost)","Coal"),
              ("Copper","Copper"),("Zinc","Zinc"),("Iron ore","Iron ore"),("Nickel","Nickel")]:
    F[f"{lab} price change, last 3 mo"] = lg[c].diff(3)
F["Calendar: month of year"] = d.index.month
F["Aluminium volatility (last 6 mo)"] = lg["Aluminium"].diff().rolling(6).std()

from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge
mk=lambda: make_pipeline(StandardScaler(),Ridge(alpha=1000))
def target(H): return lg["Aluminium"].shift(-H)-lg["Aluminium"]
res={"h":{}}; bt_rows=[]
mape=lambda e: float(np.mean(np.abs(np.exp(e)-1))*100)
for H in (1,2,3,4,5,6):
    data=F.join(target(H).rename("y")).dropna(); ml=[];ac=[];idx=[]
    for o in data.index[-96:]:
        tr=data.loc[:o-pd.DateOffset(months=H)]
        p=mk().fit(tr.drop(columns="y"),tr["y"]).predict(data.loc[[o]].drop(columns="y"))[0]
        ml.append(p);ac.append(data.loc[o,"y"]);idx.append(o)
    ml,ac=np.array(ml),np.array(ac)
    res["h"][H]={"model_mape":mape(ml-ac),"naive_mape":mape(0-ac),"dir_hit":float(np.mean(np.sign(ml)==np.sign(ac))*100),"n":len(ac)}
    if H==1:
        for o,pm,a in zip(idx[-36:],ml[-36:],ac[-36:]):
            b=d["Aluminium"].loc[o]
            bt_rows.append({"origin":o.strftime("%Y-%m"),"target":(o+pd.DateOffset(months=1)).strftime("%Y-%m"),
              "predicted":float(b*np.exp(pm)),"actual":float(b*np.exp(a)),"naive":float(b)})
fc=[];contrib={}
X_last=F.loc[[last]]
for H in range(1,7):
    data=F.join(target(H).rename("y")).dropna(); m=mk().fit(data.drop(columns="y"),data["y"])
    p=m.predict(X_last)[0]
    errs=[]
    for o in data.index[-96:]:
        tr=data.loc[:o-pd.DateOffset(months=H)]
        errs.append(data.loc[o,"y"]-mk().fit(tr.drop(columns="y"),tr["y"]).predict(data.loc[[o]].drop(columns="y"))[0])
    lo,hi=np.quantile(errs,[0.1,0.9]); base=d["Aluminium"].iloc[-1]
    fc.append({"month":(last+pd.DateOffset(months=H)).strftime("%Y-%m"),"forecast":float(base*np.exp(p)),
               "lower":float(base*np.exp(p+lo)),"upper":float(base*np.exp(p+hi)),"pct":float((np.exp(p)-1)*100)})
    sc,rg=m[0],m[1]; z=sc.transform(X_last)[0]; c=rg.coef_*z
    contrib[H]={"intercept":float(rg.intercept_),"parts":{k:float(v) for k,v in zip(F.columns,c)}}
c3=contrib[3]["parts"]; tot=sum(abs(v) for v in c3.values())
imp=sorted([{"feature":k,"share":round(abs(v)/tot*100,1),"push_pct":round((np.exp(v)-1)*100,2)} for k,v in c3.items()],key=lambda r:-r["share"])
res["importance"]=imp
hist=[{"month":i.strftime("%Y-%m"),"aluminium":float(v)} for i,v in d["Aluminium"].loc["2019-01-01":].items()]
# context series for the "what moved" slide
ctx={c:[{"month":i.strftime("%Y-%m"),"v":float(v)} for i,v in (d[c]/d[c].loc["2023-01-01"]*100).loc["2023-01-01":].items()] for c in ["Aluminium","Brent crude oil","European natural gas","Coal (power cost)","Copper"]}
fx=json.load(open(ROOT/"data/raw/fx_USDINR.json"))["rates"]
fxs=pd.Series({k:v["INR"] for k,v in fx.items()}); fxs.index=pd.to_datetime(fxs.index)
fxm=fxs.resample("MS").mean()
out={"asOf":last.strftime("%Y-%m"),"lastPrice":float(d["Aluminium"].iloc[-1]),"history":hist,"forecast":fc,
     "backtest":bt_rows,"metrics":res["h"],"importance":res["importance"],"contrib3":contrib[3],
     "context":ctx,"usdinr":{"first":float(fxm.iloc[0]),"last":float(fxm.iloc[-1]),"lastMonth":fxm.index[-1].strftime("%Y-%m"),
     "series":[{"month":i.strftime("%Y-%m"),"v":float(v)} for i,v in fxm.items()]},
     "nHistoryMonths":int(len(d)),"firstMonth":d.index[0].strftime("%Y-%m")}
(ROOT/"demo/kushaq_aluminium.json").write_text(json.dumps(out,indent=1))
print(json.dumps({k:out[k] for k in ["asOf","lastPrice","metrics","nHistoryMonths"]},indent=1))
print(out["forecast"]); print(out["importance"][:8]); print(out["usdinr"]["first"],out["usdinr"]["last"],out["usdinr"]["lastMonth"])

# inject data into the presentation page
tpl=(ROOT/"demo/kushaq_demo.template.html").read_text()
(ROOT/"demo/kushaq_demo.html").write_text(tpl.replace("__DATA__",json.dumps(out)))
