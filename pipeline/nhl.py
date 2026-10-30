"""NHL per-game skater/goalie stats ESPN's game logs leave out (hits, blocked shots,
power-play TOI) plus team shot rates and shots allowed by position.

Outputs (under <out>/nhl/):
  teams.json              shots/goals/hits for and against per game, SOG allowed to F/D, ranks
  players/<espn_id>.json  per-game rows for the current season
"""
import datetime as dt
import os

from common import clean, ranks, write_json
from espn_boxes import load_boxes, season_events

POS = {"C": "F", "LW": "F", "RW": "F", "F": "F", "W": "F", "D": "D", "G": "G"}


def mmss(s):
    try:
        m, sec = str(s).split(":")
        return int(m) + int(sec) / 60
    except ValueError:
        return None


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def parse_summary(js):
    comp = js["header"]["competitions"][0]
    if not comp.get("status", {}).get("type", {}).get("completed"):
        return None
    teams = {}
    for c in comp["competitors"]:
        teams[c["team"]["id"]] = {"id": c["team"]["id"], "abbr": c["team"]["abbreviation"], "home": c["homeAway"] == "home", "goals": num(c.get("score"))}
    for t in js["boxscore"]["teams"]:
        by = {x["name"]: x.get("displayValue") for x in t.get("statistics", [])}
        teams[t["team"]["id"]].update({"sog": num(by.get("shotsTotal")), "hits": num(by.get("hits")), "blk": num(by.get("blockedShots")),
                                       "ppg": num(by.get("powerPlayGoals")), "ppo": num(by.get("powerPlayOpportunities"))})
    players, seen = [], set()
    for grp in js["boxscore"].get("players", []):
        tid = grp["team"]["id"]
        for st in grp.get("statistics", []):
            keys = st.get("keys") or st.get("names") or []
            goalie = st.get("name") == "goalies"
            for a in st.get("athletes", []):
                ath = a["athlete"]
                if ath["id"] in seen or not a.get("stats"):
                    continue
                row = dict(zip(keys, a["stats"]))
                toi = mmss(row.get("timeOnIce"))
                if not toi:
                    continue
                seen.add(ath["id"])
                pos = (ath.get("position") or {}).get("abbreviation")
                p = {"id": ath["id"], "name": ath.get("displayName"), "pos": "G" if goalie else POS.get(pos, "F"), "team": tid, "toi": round(toi, 2)}
                if goalie:
                    p.update(saves=num(row.get("saves")), sa=num(row.get("shotsAgainst")), ga=num(row.get("goalsAgainst")))
                else:
                    p.update(g=num(row.get("goals")), a=num(row.get("assists")), sog=num(row.get("shotsTotal")), miss=num(row.get("shotsMissed")),
                             hits=num(row.get("hits")), blk=num(row.get("blockedShots")), pptoi=mmss(row.get("powerPlayTimeOnIce")),
                             pim=num(row.get("penaltyMinutes")), fow=num(row.get("faceoffsWon")), fol=num(row.get("faceoffsLost")))
                players.append(p)
    return {"date": comp["date"], "season_type": js["header"].get("season", {}).get("type"), "teams": teams, "players": players}


def add_potential(rows, meta):
    """Expected shots on goal (shot attempts x his on-target rate) and expected goals
    (shots on goal x his shooting %), both shrunk toward the league."""
    skaters = [r for pid, rs in rows.items() if meta[pid]["pos"] != "G" for r in rs]
    sog = sum(r.get("sog") or 0 for r in skaters)
    att = sog + sum(r.get("miss") or 0 for r in skaters)
    goals = sum(r.get("g") or 0 for r in skaters)
    lg_on = sog / att if att else 0.6
    lg_sh = goals / sog if sog else 0.1
    for pid, rs in rows.items():
        if meta[pid]["pos"] == "G":
            continue
        s_sog = sum(r.get("sog") or 0 for r in rs)
        s_att = s_sog + sum(r.get("miss") or 0 for r in rs)
        on = (s_sog + 40 * lg_on) / (s_att + 40)
        sh = (sum(r.get("g") or 0 for r in rs) + 60 * lg_sh) / (s_sog + 60)
        for r in rs:
            a = (r.get("sog") or 0) + (r.get("miss") or 0)
            r["xsog"] = clean(a * on, 2)
            r["xg"] = clean((r.get("sog") or 0) * sh, 3)


def build(out, cache):
    season, events = season_events("hockey/nhl", cache, "nhl")
    print(f"NHL season {season}: {len(events)} completed games", flush=True)
    boxes = load_boxes("hockey/nhl", cache, "nhl", events, parse_summary)

    team_games, allowed, rows, meta = {}, {}, {}, {}
    for ev, box in sorted(boxes, key=lambda x: x[1]["date"]):
        ids = list(box["teams"])
        if len(ids) != 2:
            continue
        for tid in ids:
            t = box["teams"][tid]
            o = box["teams"][ids[1] if tid == ids[0] else ids[0]]
            regular = box["season_type"] == 2
            if regular and t.get("sog") is not None and o.get("sog") is not None:
                team_games.setdefault(t["abbr"], []).append({"sf": t["sog"], "sa": o["sog"], "gf": t["goals"], "ga": o["goals"], "hits": t["hits"], "hits_a": o["hits"], "blk": t["blk"], "blk_a": o["blk"]})
                # Shots on goal / points this team allowed to opposing forwards and defensemen.
                agg = {}
                for p in box["players"]:
                    if p["team"] != o["id"] or p["pos"] == "G":
                        continue
                    a = agg.setdefault(p["pos"], {"sog": 0.0, "pts": 0.0, "hits": 0.0, "blk": 0.0})
                    a["sog"] += p.get("sog") or 0
                    a["pts"] += (p.get("g") or 0) + (p.get("a") or 0)
                    a["hits"] += p.get("hits") or 0
                    a["blk"] += p.get("blk") or 0
                for pos, a in agg.items():
                    allowed.setdefault(t["abbr"], {}).setdefault(pos, []).append(a)
            for p in box["players"]:
                if p["team"] != tid:
                    continue
                r = {"ev": ev, "date": box["date"][:10], "opp": o["abbr"], "home": t["home"], "post": not regular, "toi": p["toi"]}
                for k in ("g", "a", "sog", "miss", "hits", "blk", "pptoi", "pim", "fow", "fol", "saves", "sa", "ga"):
                    if p.get(k) is not None:
                        r[k] = clean(p[k], 2)
                rows.setdefault(p["id"], []).append(r)
                meta[p["id"]] = {"name": p["name"], "pos": p["pos"], "team": t["abbr"]}

    teams = {}
    for abbr, gl in team_games.items():
        n = len(gl)
        avg = lambda k: clean(sum(g[k] or 0 for g in gl) / n, 2)  # noqa: E731
        teams[abbr] = {"gp": n, "sf": avg("sf"), "sa": avg("sa"), "gf": avg("gf"), "ga": avg("ga"), "hits": avg("hits"), "hits_a": avg("hits_a"), "blk": avg("blk"), "blk_a": avg("blk_a"),
                       "allowed": {pos: {k: clean(sum(x[k] for x in lst) / len(lst), 2) for k in ("sog", "pts", "hits", "blk")} for pos, lst in allowed.get(abbr, {}).items()}}
    for k, asc in {"sa": True, "sf": False, "ga": True, "gf": False, "hits_a": True}.items():
        rk = ranks({a: t[k] for a, t in teams.items()}, ascending=asc)
        for a in teams:
            teams[a].setdefault("rank", {})[k] = rk.get(a)
    league = {}
    if teams:
        for k in ("sf", "sa", "gf", "ga", "hits", "blk"):
            league[k] = clean(sum(t[k] for t in teams.values()) / len(teams), 3)
        league["allowed"] = {}
        for pos in ("F", "D"):
            lst = [t["allowed"][pos] for t in teams.values() if pos in t["allowed"]]
            if lst:
                league["allowed"][pos] = {k: clean(sum(x[k] for x in lst) / len(lst), 3) for k in ("sog", "pts", "hits", "blk")}

    add_potential(rows, meta)
    pdir = os.path.join(out, "nhl", "players")
    os.makedirs(pdir, exist_ok=True)
    for pid, r in rows.items():
        write_json(os.path.join(pdir, f"{pid}.json"), {"id": pid, **meta[pid], "games": r})
    write_json(os.path.join(out, "nhl", "teams.json"), {"season": season, "updated": dt.datetime.utcnow().isoformat() + "Z", "games": len(boxes), "teams": teams, "league": league})
    print(f"NHL: {len(teams)} teams, {len(rows)} players", flush=True)
