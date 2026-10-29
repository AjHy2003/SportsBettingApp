"""Probe ESPN team ATS / over-under record endpoints (with a browser Origin)."""
import json, os, urllib.request
OUT = "probe-ats"; os.makedirs(OUT, exist_ok=True)
notes = []
def get(url, name=None):
    req = urllib.request.Request(url, headers={"Origin": "https://ajhy2003.github.io", "User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read(); h = {k.lower(): v for k, v in r.headers.items()}
            notes.append({"url": url, "status": r.status, "acao": h.get("access-control-allow-origin"), "len": len(body)})
            if name: open(os.path.join(OUT, name), "wb").write(body)
            return json.loads(body)
    except Exception as e:
        notes.append({"url": url, "error": repr(e)[:160]}); return None
C = "https://sports.core.api.espn.com/v2/sports"
for path, season, team, tag in [("football/leagues/nfl", 2026, 9, "nfl"), ("basketball/leagues/nba", 2027, 1, "nba"), ("football/leagues/college-football", 2026, 333, "ncaaf"), ("hockey/leagues/nhl", 2027, 1, "nhl")]:
    for t in (2, 0):
        d = get(f"{C}/{path}/seasons/{season}/types/{t}/teams/{team}/ats", f"ats_{tag}_{t}.json")
        if d: break
    get(f"{C}/{path}/seasons/{season}/types/2/teams/{team}/odds-records", f"oddsrec_{tag}.json")
get(f"{C}/football/leagues/nfl/seasons/2026/types/2/teams/9/records", "records_nfl.json")
json.dump(notes, open(os.path.join(OUT, "notes.json"), "w"), indent=1)
for n in notes: print(n)
