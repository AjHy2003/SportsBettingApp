"""Temporary probe round 2: pbpstats fields and per-date totals; ffopportunity and NHL fields."""
import csv, io, json
import requests
UA = {"User-Agent": "Mozilla/5.0 (PickLab data pipeline; +https://github.com/AjHy2003/SportsBettingApp)"}
out = {}
def j(url):
    r = requests.get(url, headers=UA, timeout=60); r.raise_for_status(); return r.json()
try:
    d = j("https://api.pbpstats.com/get-totals/nba?Season=2026-27&SeasonType=Regular%2BSeason&Type=Player&FromDate=2026-10-28&ToDate=2026-10-28")
    rows = d.get("multi_row_table_data", [])
    out["pbp_date_rows"] = len(rows)
    out["pbp_keys"] = sorted(rows[0].keys()) if rows else []
    out["pbp_sample"] = {k: rows[0][k] for k in list(rows[0])[:200]} if rows else {}
except Exception as e:
    out["pbp_err"] = str(e)[:300]
try:
    d = j("https://api.pbpstats.com/get-game-logs/nba?Season=2026-27&SeasonType=Regular%2BSeason&EntityId=1628983&EntityType=Player")
    rows = d.get("multi_row_table_data", [])
    out["pbp_gamelog_rows"] = len(rows)
    out["pbp_gamelog_keys"] = sorted(rows[0].keys()) if rows else []
except Exception as e:
    out["pbp_gamelog_err"] = str(e)[:300]
r = requests.get("https://github.com/ffverse/ffopportunity/releases/download/latest-data/ep_weekly_2026.csv", headers=UA, timeout=60)
rd = list(csv.DictReader(io.StringIO(r.text)))
out["ffopp_cols"] = list(rd[0].keys())
out["ffopp_weeks"] = sorted({x["week"] for x in rd}, key=int)
out["ffopp_sample"] = [x for x in rd if x["position"] == "WR"][:2]
pbp = j("https://api-web.nhle.com/v1/gamecenter/2026020200/play-by-play")
types = {}
for p in pbp.get("plays", []):
    types.setdefault(p.get("typeDescKey"), p.get("details", {}))
out["nhl_play_types"] = {k: sorted(v.keys()) for k, v in types.items()}
out["nhl_roster_sample"] = pbp.get("rosterSpots", [])[:2]
json.dump(out, open("probe-potential.json", "w"), indent=1)
print(json.dumps({k: (v if not isinstance(v, (list, dict)) else (v[:60] if isinstance(v, list) else list(v)[:40])) for k, v in out.items()}, indent=1)[:6000])
