"""NBA advanced stats computed from ESPN box scores.

NBA.com's tracking endpoints (potential rebounds/assists) time out from cloud
runners, so this derives the closest box-score equivalents for every game:
usage %, rebound %, assist %, rebound chances, team/opponent misses, pace,
ratings and defense-vs-position.

"Potential" fields per game (what the chances say he should have had):
  pot_ast  potential assists (est.): assists / teammates' FG% that game
  xast     expected assists: potential assists x teammates' normal FG%
  xreb     expected rebounds: rebound chances x his season rebound conversion
  xfg3m    expected threes: 3PA x his 3P% shrunk toward the league's
  xpts     expected points: shot attempts and free throws at his normal percentages

Outputs (under <out>/nba/):
  teams.json              per-team pace/ratings/misses/DvP + league averages + ranks
  players/<espn_id>.json  per-game advanced rows for the current season
"""
import datetime as dt
import os

from common import clean, ranks, write_json
from espn_boxes import load_boxes, previous_season_events, season_events

POS = {"PG": "G", "SG": "G", "G": "G", "SF": "F", "PF": "F", "F": "F", "GF": "F", "C": "C", "FC": "C", "CF": "C"}
DVP_STATS = ["pts", "reb", "ast", "fg3m", "stl", "blk", "tov", "fgm", "fga", "ftm", "fg3a"]


def num(s):
    try:
        return float(str(s).replace("+", ""))
    except (TypeError, ValueError):
        return None


def made_att(s):
    try:
        a, b = str(s).split("-")
        return float(a), float(b)
    except ValueError:
        return None, None


def parse_minutes(s):
    if s is None or s == "":
        return 0.0
    s = str(s)
    if ":" in s:
        m, sec = s.split(":")
        return float(m) + float(sec) / 60
    return num(s) or 0.0


def team_line(stats):
    """Team totals from boxscore.teams[].statistics."""
    by = {x.get("name"): x.get("displayValue") for x in stats}
    out = {}
    for name, (mk, ak) in {"fieldGoalsMade-fieldGoalsAttempted": ("fgm", "fga"),
                           "threePointFieldGoalsMade-threePointFieldGoalsAttempted": ("fg3m", "fg3a"),
                           "freeThrowsMade-freeThrowsAttempted": ("ftm", "fta")}.items():
        out[mk], out[ak] = made_att(by.get(name))
    for name, k in {"totalRebounds": "reb", "offensiveRebounds": "oreb", "defensiveRebounds": "dreb", "assists": "ast",
                    "steals": "stl", "blocks": "blk", "totalTurnovers": "tov", "turnovers": "tov_player"}.items():
        out[k] = num(by.get(name))
    if out.get("tov") is None:
        out["tov"] = out.get("tov_player")
    return out


def parse_summary(js):
    """Compact box score: teams (with totals) and players."""
    comp = js["header"]["competitions"][0]
    if not comp.get("status", {}).get("type", {}).get("completed"):
        return None
    season_type = js["header"].get("season", {}).get("type")
    teams = {}
    for c in comp["competitors"]:
        teams[c["team"]["id"]] = {"id": c["team"]["id"], "abbr": c["team"]["abbreviation"], "home": c["homeAway"] == "home", "pts": num(c.get("score"))}
    for t in js["boxscore"]["teams"]:
        teams[t["team"]["id"]].update(team_line(t.get("statistics", [])))
    players = []
    for grp in js["boxscore"].get("players", []):
        tid = grp["team"]["id"]
        st = grp["statistics"][0]
        labels = st.get("labels") or st.get("names")
        for a in st.get("athletes", []):
            if a.get("didNotPlay") or not a.get("stats"):
                continue
            row = dict(zip(labels, a["stats"]))
            mins = parse_minutes(row.get("MIN"))
            if mins <= 0:
                continue
            fgm, fga = made_att(row.get("FG"))
            fg3m, fg3a = made_att(row.get("3PT"))
            ftm, fta = made_att(row.get("FT"))
            ath = a["athlete"]
            players.append({
                "id": ath["id"], "name": ath.get("displayName"), "pos": (ath.get("position") or {}).get("abbreviation"), "team": tid,
                "starter": bool(a.get("starter")), "min": mins, "pts": num(row.get("PTS")), "fgm": fgm, "fga": fga, "fg3m": fg3m, "fg3a": fg3a,
                "ftm": ftm, "fta": fta, "oreb": num(row.get("OREB")), "dreb": num(row.get("DREB")), "reb": num(row.get("REB")),
                "ast": num(row.get("AST")), "stl": num(row.get("STL")), "blk": num(row.get("BLK")), "tov": num(row.get("TO")), "pf": num(row.get("PF")),
            })
    tmin = {}
    for p in players:
        tmin[p["team"]] = tmin.get(p["team"], 0) + p["min"]
    for tid, t in teams.items():
        t["min"] = tmin.get(tid) or 240.0
    return {"date": comp["date"], "season_type": season_type, "teams": teams, "players": players}


def possessions(t, o):
    """Basketball-Reference team possession estimate, averaged over both sides."""
    def one(a, b):
        orb = a["oreb"] / (a["oreb"] + b["dreb"]) if (a["oreb"] + b["dreb"]) else 0.3
        return a["fga"] + 0.4 * a["fta"] - 1.07 * orb * (a["fga"] - a["fgm"]) + a["tov"]
    return 0.5 * (one(t, o) + one(o, t))


def write_lineups(out, league, boxes):
    """Per team: who played (and minutes) in every game, for with/without teammate splits."""
    teams = {}
    for ev, box in boxes:
        for tid, t in box["teams"].items():
            played = {p["id"]: round(p["min"], 1) for p in box["players"] if p["team"] == tid and p.get("min", 0) > 0}
            if played:
                teams.setdefault(t["abbr"], {})[ev] = {"d": box["date"][:10], "p": played}
    ldir = os.path.join(out, league, "lineups")
    os.makedirs(ldir, exist_ok=True)
    for abbr, games in teams.items():
        write_json(os.path.join(ldir, f"{abbr}.json"), {"team": abbr, "games": games})


def add_potential(player_rows, boxes):
    """Per-game potential and expected stats; raw shooting fields are dropped after."""
    tot = {"fgm": 0, "fga": 0, "fg3m": 0, "fg3a": 0, "ftm": 0, "fta": 0}
    for _, box in boxes:
        for t in box["teams"].values():
            for k in tot:
                tot[k] += t.get(k) or 0
    lg_fg = tot["fgm"] / tot["fga"] if tot["fga"] else 0.47
    lg_3 = tot["fg3m"] / tot["fg3a"] if tot["fg3a"] else 0.36
    lg_2 = (tot["fgm"] - tot["fg3m"]) / (tot["fga"] - tot["fg3a"]) if tot["fga"] > tot["fg3a"] else 0.54
    lg_ft = tot["ftm"] / tot["fta"] if tot["fta"] else 0.78
    for rows in player_rows.values():
        s = lambda k: sum(r.get(k) or 0 for r in rows)  # noqa: E731
        # Normal rates, shrunk toward the league by sample size.
        tm_fg = (s("tm_fgm") + 600 * lg_fg) / (s("tm_fga") + 600)
        p3 = (s("fg3m") + 150 * lg_3) / (s("fg3a") + 150)
        p2 = (s("fgm") - s("fg3m") + 200 * lg_2) / (s("fga") - s("fg3a") + 200)
        pft = (s("ftm") + 60 * lg_ft) / (s("fta") + 60)
        rch = sum(r["rch"] or 0 for r in rows if r.get("rch"))
        conv = (sum(r["reb"] or 0 for r in rows if r.get("rch")) + 6) / (rch + 6 / 0.14) if rch else None
        for r in rows:
            fga, fg3a, fta = r.get("fga") or 0, r.get("fg3a") or 0, r.get("fta") or 0
            if r.get("tm_fga", 0) >= 20 and r.get("ast") is not None:
                g_fg = max(0.25, min(0.75, r["tm_fgm"] / r["tm_fga"]))
                r["pot_ast"] = clean(r["ast"] / g_fg, 1)
                r["xast"] = clean(r["ast"] * tm_fg / g_fg, 2)
            if conv and r.get("rch"):
                r["xreb"] = clean(r["rch"] * conv, 2)
            r["xfg3m"] = clean(fg3a * p3, 2)
            r["xpts"] = clean(2 * (fga - fg3a) * p2 + 3 * fg3a * p3 + fta * pft, 1)
            r["rconv"] = clean(conv, 3)
            for k in ("fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "tm_fgm", "tm_fga"):
                r.pop(k, None)
            r["fga"], r["fg3a"], r["fta"] = clean(fga), clean(fg3a), clean(fta)


def build(out, cache):
    season, events = season_events("basketball/nba", cache, "nba")
    print(f"NBA season {season}: {len(events)} completed games", flush=True)
    boxes = load_boxes("basketball/nba", cache, "nba", events, parse_summary)
    # Last season's box scores only feed the with/without lineup files.
    prev_events = previous_season_events("basketball/nba", cache, "nba")
    prev_boxes = load_boxes("basketball/nba", cache, "nba", prev_events, parse_summary)
    print(f"NBA last season: {len(prev_boxes)} games for lineups", flush=True)
    write_lineups(out, "nba", boxes + prev_boxes)

    team_games = {}   # abbr -> list of per-game team rows
    dvp = {}          # abbr -> pos -> list of per-game sums allowed
    player_rows = {}  # id -> rows
    player_meta = {}
    for ev, box in sorted(boxes, key=lambda x: x[1]["date"]):
        tids = list(box["teams"].keys())
        if len(tids) != 2:
            continue
        for tid in tids:
            t = box["teams"][tid]
            o = box["teams"][tids[1] if tid == tids[0] else tids[0]]
            if any(t.get(k) is None for k in ("fga", "fgm", "fta", "ftm", "oreb", "dreb", "tov")) or any(o.get(k) is None for k in ("fga", "fgm", "fta", "oreb", "dreb", "tov")):
                continue
            poss = possessions(t, o)
            regular = box["season_type"] == 2
            if regular:
                team_games.setdefault(t["abbr"], []).append({
                    "poss": poss, "min": t["min"], "pts": t["pts"], "opp_pts": o["pts"],
                    "fg_miss": t["fga"] - t["fgm"], "opp_fg_miss": o["fga"] - o["fgm"],
                    "reb": t["reb"], "opp_reb": o["reb"], "fga": t["fga"], "fg3a": t["fg3a"],
                })
                # Defense vs position: what this team's opponents' players produced.
                allowed = {}
                for p in box["players"]:
                    if p["team"] != o["id"]:
                        continue
                    g = POS.get(p["pos"] or "", None)
                    if not g:
                        continue
                    a = allowed.setdefault(g, {k: 0.0 for k in DVP_STATS})
                    for k in DVP_STATS:
                        a[k] += p.get(k) or 0
                for g, a in allowed.items():
                    dvp.setdefault(t["abbr"], {}).setdefault(g, []).append(a)
            # Player advanced rows.
            tm5 = t["min"] / 5
            for p in box["players"]:
                if p["team"] != tid:
                    continue
                m = p["min"]
                plays_t = t["fga"] + 0.44 * t["fta"] + t["tov"]
                usg = 100 * ((p["fga"] or 0) + 0.44 * (p["fta"] or 0) + (p["tov"] or 0)) * tm5 / (m * plays_t) if plays_t else None
                reb_avail = (t["reb"] or 0) + (o["reb"] or 0)
                rebp = 100 * (p["reb"] or 0) * tm5 / (m * reb_avail) if reb_avail else None
                orebp = 100 * (p["oreb"] or 0) * tm5 / (m * (t["oreb"] + o["dreb"])) if (t["oreb"] + o["dreb"]) else None
                drebp = 100 * (p["dreb"] or 0) * tm5 / (m * (t["dreb"] + o["oreb"])) if (t["dreb"] + o["oreb"]) else None
                ast_den = (m / tm5) * t["fgm"] - (p["fgm"] or 0)
                astp = 100 * (p["ast"] or 0) / ast_den if ast_den > 0 else None
                misses = (t["fga"] - t["fgm"]) + (o["fga"] - o["fgm"]) + 0.44 * ((t["fta"] - t["ftm"]) + (o["fta"] - (o.get("ftm") or 0)))
                rch = misses * m / tm5 if tm5 else None
                player_rows.setdefault(p["id"], []).append({
                    "ev": ev, "date": box["date"][:10], "opp": o["abbr"], "home": t["home"], "post": not regular,
                    "min": clean(m, 1), "usg": clean(usg, 1), "rebp": clean(rebp, 1), "orebp": clean(orebp, 1), "drebp": clean(drebp, 1),
                    "astp": clean(astp, 1), "rch": clean(rch, 1), "reb": clean(p["reb"]), "oreb": clean(p["oreb"]), "ast": clean(p["ast"]),
                    "pts": clean(p["pts"]), "tm_miss": clean(t["fga"] - t["fgm"]), "opp_miss": clean(o["fga"] - o["fgm"]),
                    "fgm": p["fgm"], "fga": p["fga"], "fg3m": p["fg3m"], "fg3a": p["fg3a"], "ftm": p["ftm"], "fta": p["fta"],
                    "tm_fgm": (t["fgm"] or 0) - (p["fgm"] or 0), "tm_fga": (t["fga"] or 0) - (p["fga"] or 0),
                })
                player_meta[p["id"]] = {"name": p["name"], "pos": p["pos"], "team": t["abbr"]}

    teams = {}
    for abbr, gl in team_games.items():
        n = len(gl)
        poss = sum(g["poss"] for g in gl)
        mins = sum(g["min"] for g in gl)
        teams[abbr] = {
            "gp": n,
            "pace": clean(48 * poss / (mins / 5), 2),
            "ortg": clean(100 * sum(g["pts"] for g in gl) / poss, 2),
            "drtg": clean(100 * sum(g["opp_pts"] for g in gl) / poss, 2),
            "fg_miss": clean(sum(g["fg_miss"] for g in gl) / n, 2),
            "opp_fg_miss": clean(sum(g["opp_fg_miss"] for g in gl) / n, 2),
            "reb_pct": clean(sum(g["reb"] for g in gl) / sum(g["reb"] + g["opp_reb"] for g in gl), 4),
            "fg3a_rate": clean(sum(g["fg3a"] for g in gl) / sum(g["fga"] for g in gl), 4),
            "dvp": {pos: {k: clean(sum(x[k] for x in rows) / len(rows), 2) for k in DVP_STATS} for pos, rows in dvp.get(abbr, {}).items()},
        }
    rank_spec = {"pace": True, "drtg": True, "ortg": False, "fg_miss": True, "opp_fg_miss": True, "reb_pct": False, "fg3a_rate": False}
    for k, asc in rank_spec.items():
        rk = ranks({a: t[k] for a, t in teams.items()}, ascending=asc)
        for a in teams:
            teams[a].setdefault("rank", {})[k] = rk.get(a)
    league = {}
    if teams:
        for k in ("pace", "ortg", "drtg", "fg_miss", "opp_fg_miss", "reb_pct", "fg3a_rate"):
            vals = [t[k] for t in teams.values() if t[k] is not None]
            league[k] = clean(sum(vals) / len(vals), 3)
        league["dvp"] = {}
        for pos in ("G", "F", "C"):
            rows = [t["dvp"][pos] for t in teams.values() if pos in t["dvp"]]
            if rows:
                league["dvp"][pos] = {k: clean(sum(r[k] for r in rows) / len(rows), 2) for k in DVP_STATS}

    add_potential(player_rows, boxes)
    pdir = os.path.join(out, "nba", "players")
    os.makedirs(pdir, exist_ok=True)
    for pid, rows in player_rows.items():
        meta = player_meta[pid]
        write_json(os.path.join(pdir, f"{pid}.json"), {"id": pid, **meta, "games": rows})
    write_json(os.path.join(out, "nba", "teams.json"), {"season": season, "updated": dt.datetime.utcnow().isoformat() + "Z", "games": len(boxes), "teams": teams, "league": league})
    print(f"NBA: {len(teams)} teams, {len(player_rows)} players", flush=True)
