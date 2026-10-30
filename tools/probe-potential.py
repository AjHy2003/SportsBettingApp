"""Temporary probe: which "potential" (opportunity) stats can a GitHub runner reach?"""
import io, json, time
import requests

out = {}
def tryget(name, url, headers=None, timeout=30, parse=True):
    t = time.time()
    try:
        r = requests.get(url, headers=headers or {}, timeout=timeout)
        info = {"status": r.status_code, "secs": round(time.time() - t, 1), "bytes": len(r.content)}
        if parse and r.ok:
            try:
                j = r.json()
                info["sample"] = json.dumps(j)[:1500]
            except Exception:
                info["sample"] = r.text[:600]
        elif r.ok:
            info["sample"] = r.content[:800].decode("utf-8", "replace")
    except Exception as e:
        info = {"error": str(e)[:200], "secs": round(time.time() - t, 1)}
    out[name] = info
    print(name, {k: v for k, v in info.items() if k != "sample"}, flush=True)

NBA_H = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Referer": "https://www.nba.com/", "Origin": "https://www.nba.com", "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9", "x-nba-stats-origin": "stats", "x-nba-stats-token": "true", "Connection": "keep-alive",
}
base = "https://stats.nba.com/stats/leaguedashptstats?College=&Conference=&Country=&DateFrom=&DateTo=&Division=&DraftPick=&DraftYear=&GameScope=&Height=&LastNGames=0&LeagueID=00&Location=&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PerMode=PerGame&PlayerExperience=&PlayerOrTeam=Player&PlayerPosition=&Season=2025-26&SeasonSegment=&SeasonType=Regular%20Season&StarterBench=&TeamID=0&VsConference=&VsDivision=&Weight="
tryget("nba_pt_passing", base + "&PtMeasureType=Passing", NBA_H, timeout=45)
tryget("nba_pt_rebounding", base + "&PtMeasureType=Rebounding", NBA_H, timeout=45)
tryget("nba_track_box_v3", "https://stats.nba.com/stats/boxscoreplayertrackv3?GameID=0022500100", NBA_H, timeout=45)
tryget("nba_cdn_box", "https://cdn.nba.com/static/json/liveData/boxscore/boxscore_0022500100.json", {"User-Agent": NBA_H["User-Agent"]})
tryget("pbpstats", "https://api.pbpstats.com/get-totals/nba?Season=2025-26&SeasonType=Regular%2BSeason&Type=Player", {"User-Agent": NBA_H["User-Agent"]})
# NFL expected stats (ffopportunity, built on nflverse play-by-play)
for y in (2026, 2025):
    tryget(f"ffopp_weekly_{y}", f"https://github.com/ffverse/ffopportunity/releases/download/latest-data/ep_weekly_{y}.csv", parse=False, timeout=60)
# NHL shot attempts from the league's own play-by-play
tryget("nhl_schedule", "https://api-web.nhle.com/v1/schedule/now")
tryget("nhl_pbp", "https://api-web.nhle.com/v1/gamecenter/2025020150/play-by-play")
json.dump(out, open("probe-potential.json", "w"), indent=1)
