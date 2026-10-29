"""Probe ESPN news / video endpoints the way a browser on github.io would see them."""
import datetime as dt, json, os, urllib.request

OUT = "probe-news"
os.makedirs(OUT, exist_ok=True)
ORIGIN = "https://ajhy2003.github.io"
report = []

def get(url, name=None, head=False, rng=False):
    req = urllib.request.Request(url, method="HEAD" if head else "GET", headers={"Origin": ORIGIN, "User-Agent": "Mozilla/5.0", **({"Range": "bytes=0-1023"} if rng else {})})
    row = {"url": url}
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = b"" if head else r.read()
            h = {k.lower(): v for k, v in r.headers.items()}
            row.update(status=r.status, acao=h.get("access-control-allow-origin"), ctype=h.get("content-type"), length=h.get("content-length"), ranges=h.get("accept-ranges") or h.get("content-range"))
            if name and body:
                open(os.path.join(OUT, name), "wb").write(body)
            report.append(row)
            return json.loads(body) if body and "json" in (row["ctype"] or "") else None
    except Exception as e:
        row["error"] = repr(e)[:300]
        report.append(row)
        return None

W = "https://site.web.api.espn.com/apis/site/v2/sports"
leagues = {"nba": "basketball/nba", "nfl": "football/nfl", "ncaaf": "football/college-football", "ncaab": "basketball/mens-college-basketball", "mlb": "baseball/mlb", "nhl": "hockey/nhl", "epl": "soccer/eng.1", "wnba": "basketball/wnba"}
news = {}
for k, p in leagues.items():
    news[k] = get(f"{W}/{p}/news?limit=50", f"news_{k}.json")
get("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=5")
get(f"{W}/basketball/nba/news?limit=10&team=13", "news_nba_team13.json")
get(f"{W}/basketball/nba/news?limit=10&athlete=1966", "news_nba_ath1966.json")
get(f"{W}/basketball/nba/news?limit=50&type=Media", "news_nba_media.json")
get("https://now.core.api.espn.com/v1/sports/news?limit=20&sport=basketball&league=nba", "now_nba.json")
get("https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/1966/news", "athnews_1966.json")

# A video from the news feed: can the browser resolve it to an mp4?
for k in ("nfl", "nba"):
    arts = (news.get(k) or {}).get("articles", [])
    media = [a for a in arts if a.get("type") == "Media"]
    if media:
        get(media[0]["links"]["api"]["self"]["href"], f"clip_{k}.json")

# Last night's games: scoreboard highlights and summary videos; can the mp4 / m3u8 load?
y = (dt.datetime.utcnow() - dt.timedelta(hours=5) - dt.timedelta(days=1)).strftime("%Y%m%d")
for k in ("nba", "nhl", "nfl", "ncaaf"):
    sb = get(f"{W}/{leagues[k]}/scoreboard" + (f"?dates={y}" if k in ("nba", "nhl") else ""), f"sb_{k}.json")
    evs = [e for e in (sb or {}).get("events", []) if e["status"]["type"]["state"] == "post"]
    hl = sum(len(e["competitions"][0].get("highlights", [])) for e in evs)
    report.append({"note": f"{k}: {len(evs)} finished games, {hl} scoreboard highlights"})
    if evs:
        s = get(f"{W}/{leagues[k]}/summary?event={evs[0]['id']}", f"summary_{k}.json")
        vids = (s or {}).get("videos", [])
        report.append({"note": f"{k} summary {evs[0]['id']}: {len(vids)} videos"})
        if vids:
            v = vids[0]
            get(v["links"]["source"]["href"], head=True)
            get(v["links"]["source"]["href"], rng=True)
            hls = v["links"]["source"].get("HLS", {}).get("href")
            if hls:
                get(hls, f"hls_{k}.m3u8")
            get(v["thumbnail"], head=True)
json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)
for r in report:
    print(r)
