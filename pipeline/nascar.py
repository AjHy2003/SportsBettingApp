"""NASCAR Cup results + loop data (driver rating, average running position) for three seasons.

Output: <out>/nascar/summary.json in the same shape the racing page builds live:
  { series, season, races: [{key, season, name, track, trackId, date, superspeedway, results: [...]}], next }
"""
import datetime as dt
import json
import os

from common import get, write_json

CF = "https://cf.nascar.com"


def race_results(cache, season, race):
    rid = race["race_id"]
    path = os.path.join(cache, "nascar", f"{season}-{rid}.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    wk = get(f"{CF}/cacher/{season}/1/{rid}/weekend-feed.json")
    wr = (wk or {}).get("weekend_race") or []
    if not wr or not wr[0].get("results"):
        return None
    loop = get(f"{CF}/loopstats/prod/{season}/1/{rid}.json") or []
    loop_by = {}
    if loop:
        for d in loop[0].get("drivers", []):
            loop_by[d["driver_id"]] = d
    results = []
    for x in wr[0]["results"]:
        ls = loop_by.get(x["driver_id"], {})
        results.append({
            "id": str(x["driver_id"]), "name": x["driver_fullname"], "team": x.get("team_name"), "pos": x["finishing_position"],
            "grid": x.get("starting_position"), "status": x.get("finishing_status"), "dnf": x.get("finishing_status") != "Running",
            "lapsLed": x.get("laps_led"), "rating": ls.get("rating"), "avgPos": ls.get("avg_ps"), "fastLaps": ls.get("fast_laps"),
        })
    out = {
        "key": f"{season}-{rid}", "season": season, "name": race["race_name"], "track": race["track_name"], "trackId": str(race["track_id"]),
        "date": race["race_date"], "superspeedway": bool(race.get("restrictor_plate")), "results": results,
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(out, f)
    return out


def build(out, cache):
    year = dt.date.today().year
    races, nxt = [], None
    for season in (year - 2, year - 1, year):
        lst = get(f"{CF}/cacher/{season}/1/race_list_basic.json") or []
        points = [r for r in lst if r.get("race_type_id") == 1 and not r.get("is_qualifying_race")]
        for r in points:
            if r.get("winner_driver_id"):
                res = race_results(cache, season, r)
                if res:
                    races.append(res)
            elif season == year and nxt is None and dt.datetime.fromisoformat(r["race_date"]) > dt.datetime.now() - dt.timedelta(days=1):
                nxt = {"name": r["race_name"], "track": r["track_name"], "trackId": str(r["track_id"]), "date": r["race_date"], "superspeedway": bool(r.get("restrictor_plate"))}
    races.sort(key=lambda r: r["date"])
    write_json(os.path.join(out, "nascar", "summary.json"), {
        "series": "NASCAR Cup", "season": year, "updated": dt.datetime.utcnow().isoformat() + "Z", "races": races, "next": nxt,
    })
    print(f"NASCAR: {len(races)} races, next={nxt and nxt['name']}", flush=True)
