"""Probe: DraftKings alt/milestone props, box score layouts, venue + weather, Open-Meteo CORS."""
import collections, datetime as dt, json, os, re, urllib.request, urllib.parse

OUT = "probe-live"
os.makedirs(OUT, exist_ok=True)
ORIGIN = "https://ajhy2003.github.io"
notes = []

def get(url, name=None):
    req = urllib.request.Request(url, headers={"Origin": ORIGIN, "User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
            h = {k.lower(): v for k, v in r.headers.items()}
            notes.append({"url": url[:160], "status": r.status, "acao": h.get("access-control-allow-origin")})
            if name:
                open(os.path.join(OUT, name), "wb").write(body)
            return json.loads(body)
    except Exception as e:
        notes.append({"url": url[:160], "error": repr(e)[:200]})
        return None

W = "https://site.web.api.espn.com/apis/site/v2/sports"
CORE = "https://sports.core.api.espn.com/v2/sports"

def props(sport, league, ev, tag):
    base = f"{CORE}/{sport}/leagues/{league}/events/{ev}/competitions/{ev}/odds/100/propBets?limit=500"
    first = get(base)
    if not first: return
    items = list(first.get("items", []))
    for p in range(2, (first.get("pageCount") or 1) + 1):
        d = get(f"{base}&page={p}")
        items += (d or {}).get("items", [])
    json.dump(items, open(os.path.join(OUT, f"props_{tag}.json"), "w"))
    types = collections.Counter(it.get("type", {}).get("name") for it in items)
    by = collections.defaultdict(list)
    for it in items:
        m = re.search(r"athletes/(\d+)", it.get("athlete", {}).get("$ref", ""))
        if not m: continue
        by[(m.group(1), it["type"]["name"])].append((it.get("current", {}).get("target", {}).get("value"), it.get("odds", {}).get("american", {}).get("value")))
    multi = {f"{k[0]}|{k[1]}": v for k, v in by.items() if len({x[0] for x in v}) > 1}
    notes.append({"props": tag, "items": len(items), "types": types.most_common(60), "athleteMarkets": len(by), "multiLine": len(multi), "examples": dict(list(multi.items())[:6])})

def et(d): return (d - dt.timedelta(hours=4)).strftime("%Y%m%d")
now = dt.datetime.utcnow()

# NBA: today's games (props) and last night's finished game (box score layout)
sb = get(f"{W}/basketball/nba/scoreboard?dates={et(now)}") or {}
pre = [e for e in sb.get("events", []) if e["status"]["type"]["state"] == "pre"]
if pre: props("basketball", "nba", pre[0]["id"], "nba")
sby = get(f"{W}/basketball/nba/scoreboard?dates={et(now - dt.timedelta(days=1))}") or {}
post = [e for e in sby.get("events", []) if e["status"]["type"]["state"] == "post"]
if post: get(f"{W}/basketball/nba/summary?event={post[0]['id']}", "box_nba.json")

# NFL: this week's games (props, venue, weather) and last week's finished game (box score)
sbn = get(f"{W}/football/nfl/scoreboard", "sb_nfl.json") or {}
evs = sbn.get("events", [])
if evs:
    props("football", "nfl", evs[-1]["id"], "nfl")
    for e in evs[:16]:
        c = e["competitions"][0]
        notes.append({"nfl_venue": c.get("venue"), "weather": e.get("weather"), "indoor": c.get("venue", {}).get("indoor"), "date": e["date"], "name": e.get("shortName")})
    get(f"{W}/football/nfl/summary?event={evs[0]['id']}", "summary_nfl_pre.json")
wk = sbn.get("week", {}).get("number")
if wk and wk > 1:
    prev = get(f"{W}/football/nfl/scoreboard?week={wk - 1}&seasontype={sbn.get('season', {}).get('type', 2)}") or {}
    done = [e for e in prev.get("events", []) if e["status"]["type"]["state"] == "post"]
    if done: get(f"{W}/football/nfl/summary?event={done[0]['id']}", "box_nfl.json")
sbc = get(f"{W}/football/college-football/scoreboard", "sb_ncaaf.json") or {}
for e in sbc.get("events", [])[:8]:
    c = e["competitions"][0]
    notes.append({"ncaaf_venue": c.get("venue"), "weather": e.get("weather"), "name": e.get("shortName")})

# NHL finished game box
sbh = get(f"{W}/hockey/nhl/scoreboard?dates={et(now - dt.timedelta(days=1))}") or {}
posth = [e for e in sbh.get("events", []) if e["status"]["type"]["state"] == "post"]
if posth: get(f"{W}/hockey/nhl/summary?event={posth[0]['id']}", "box_nhl.json")

# Open-Meteo: geocoding + forecast, CORS
g = get("https://geocoding-api.open-meteo.com/v1/search?" + urllib.parse.urlencode({"name": "Green Bay", "count": 10, "language": "en", "format": "json", "countryCode": "US"}), "geo.json")
get("https://api.open-meteo.com/v1/forecast?latitude=44.5&longitude=-88.06&hourly=temperature_2m,precipitation,snowfall,wind_speed_10m,wind_gusts_10m,weather_code&wind_speed_unit=mph&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=UTC&forecast_days=7", "forecast.json")

json.dump(notes, open(os.path.join(OUT, "notes.json"), "w"), indent=1)
for n in notes:
    print(json.dumps(n)[:400])
