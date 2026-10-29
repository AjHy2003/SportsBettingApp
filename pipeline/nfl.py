"""NFL advanced stats from nflverse: per-player weekly files + team defense table.

Outputs (under <out>/nfl/):
  teams.json            team offense/defense per game, allowed-by-position, ranks, league averages
  players/<espn_id>.json weekly rows for the current and previous season
  index.json            espn_id -> name/pos/team for players with files
"""
import datetime as dt
import os

import numpy as np
import pandas as pd

from common import clean, download, ranks, write_json

NFLV = "https://github.com/nflverse/nflverse-data/releases/download"
TEAM_FIX = {"LA": "LAR", "WAS": "WSH", "OAK": "LV", "SD": "LAC", "STL": "LAR"}
POS = {"QB": "QB", "RB": "RB", "FB": "RB", "HB": "RB", "WR": "WR", "TE": "TE"}


def espn_abbr(a):
    return TEAM_FIX.get(a, a) if isinstance(a, str) else a


def fetch(cache, rel, name=None):
    path = os.path.join(cache, "nflverse", name or os.path.basename(rel))
    return download(f"{NFLV}/{rel}", path)


def current_season(games):
    today = pd.Timestamp(dt.date.today())
    played = games[pd.to_datetime(games["gameday"]) <= today]
    return int(played["season"].max())


def pbp_frames(cache, season):
    try:
        p = fetch(cache, f"pbp/play_by_play_{season}.parquet")
    except FileNotFoundError:
        return None
    cols = ["game_id", "season", "week", "season_type", "posteam", "defteam", "pass_attempt", "rush_attempt",
            "qb_dropback", "qb_scramble", "qb_kneel", "qb_spike", "sack", "air_yards", "complete_pass", "yards_gained",
            "receiver_player_id", "rusher_player_id", "passer_player_id", "epa", "two_point_attempt", "play_type"]
    df = pd.read_parquet(p, columns=cols)
    return df[(df["two_point_attempt"] != 1)]


def receiving_depth(pbp):
    """Targets/catches by air-yards depth and by total gain, per receiver-game."""
    t = pbp[(pbp["pass_attempt"] == 1) & (pbp["sack"] != 1) & pbp["receiver_player_id"].notna()].copy()
    t["c"] = (t["complete_pass"] == 1).astype(int)
    ay = t["air_yards"]
    for d in (5, 10, 20):
        t[f"t{d}"] = (ay >= d).astype(int)
        t[f"c{d}"] = ((ay >= d) & (t["c"] == 1)).astype(int)
    t["t_short"] = (ay < 5).astype(int)
    t["c_short"] = ((ay < 5) & (t["c"] == 1)).astype(int)
    for d in (10, 20):
        t[f"g{d}"] = ((t["c"] == 1) & (t["yards_gained"] >= d)).astype(int)
    t["ay_sum"] = ay.fillna(0)
    t["ay_n"] = ay.notna().astype(int)
    agg = t.groupby(["receiver_player_id", "game_id"]).agg(
        t5=("t5", "sum"), c5=("c5", "sum"), t10=("t10", "sum"), c10=("c10", "sum"), t20=("t20", "sum"), c20=("c20", "sum"),
        ts=("t_short", "sum"), cs=("c_short", "sum"), g10=("g10", "sum"), g20=("g20", "sum"), ay_sum=("ay_sum", "sum"), ay_n=("ay_n", "sum"),
    ).reset_index().rename(columns={"receiver_player_id": "pid"})
    agg["adot"] = agg["ay_sum"] / agg["ay_n"].replace(0, np.nan)
    return agg.drop(columns=["ay_sum", "ay_n"])


def qb_rushing(pbp):
    """Designed runs vs scrambles for every rusher (non-QBs simply have zero scrambles)."""
    r = pbp[(pbp["rush_attempt"] == 1) & (pbp["qb_kneel"] != 1) & pbp["rusher_player_id"].notna()].copy()
    r["scr"] = (r["qb_scramble"] == 1).astype(int)
    r["dr"] = 1 - r["scr"]
    r["scry"] = r["yards_gained"].where(r["scr"] == 1, 0)
    r["dry"] = r["yards_gained"].where(r["scr"] == 0, 0)
    agg = r.groupby(["rusher_player_id", "game_id"]).agg(dr=("dr", "sum"), dry=("dry", "sum"), scr=("scr", "sum"), scry=("scry", "sum")).reset_index()
    return agg.rename(columns={"rusher_player_id": "pid"})


def passing_depth(pbp):
    p = pbp[(pbp["pass_attempt"] == 1) & (pbp["sack"] != 1) & pbp["passer_player_id"].notna()].copy()
    p["deep"] = (p["air_yards"] >= 20).astype(int)
    p["ay"] = p["air_yards"]
    agg = p.groupby(["passer_player_id", "game_id"]).agg(padot=("ay", "mean"), deep=("deep", "sum")).reset_index()
    return agg.rename(columns={"passer_player_id": "pid"})


def team_tables(pbp, weekly, games, season):
    """Per-team offense/defense rates and per-position production allowed (regular season)."""
    reg = pbp[(pbp["season_type"] == "REG") & pbp["posteam"].notna() & pbp["defteam"].notna()]
    plays = reg[(reg["pass_attempt"] == 1) | (reg["rush_attempt"] == 1)].copy()
    plays["is_pass"] = (plays["qb_dropback"] == 1).astype(int)
    plays["success"] = (plays["epa"] > 0).astype(int)
    plays["explosive"] = (((plays["is_pass"] == 1) & (plays["yards_gained"] >= 20)) | ((plays["is_pass"] == 0) & (plays["yards_gained"] >= 12))).astype(int)

    def side(df, team_col):
        g = df.groupby(team_col)
        dbk = df[df["is_pass"] == 1].groupby(team_col)
        rush = df[(df["is_pass"] == 0) & (df["qb_kneel"] != 1)].groupby(team_col)
        out = pd.DataFrame({
            "games": g["game_id"].nunique(),
            "plays": g.size(),
            "epa_play": g["epa"].mean(),
            "success": g["success"].mean(),
            "pass_rate": g["is_pass"].mean(),
            "epa_pass": dbk["epa"].mean(),
            "ypp_pass": dbk["yards_gained"].mean(),
            "sack_rate": dbk["sack"].mean(),
            "explosive_pass": dbk["explosive"].mean(),
            "epa_rush": rush["epa"].mean(),
            "ypc": rush["yards_gained"].mean(),
            "explosive_rush": rush["explosive"].mean(),
            "dropbacks": dbk.size(),
            "rushes": rush.size(),
        })
        out["plays_g"] = out["plays"] / out["games"]
        out["dropbacks_g"] = out["dropbacks"] / out["games"]
        out["rushes_g"] = out["rushes"] / out["games"]
        return out

    off = side(plays, "posteam")
    de = side(plays, "defteam")

    # Production allowed by position, per game.
    w = weekly[(weekly["season_type"] == "REG")].copy()
    w["pg"] = w["position"].map(POS)
    w = w[w["pg"].notna()]
    stat_cols = {"pass_yds": "passing_yards", "pass_att": "attempts", "cmp": "completions", "pass_td": "passing_tds",
                 "rush_yds": "rushing_yards", "rush_att": "carries", "rec": "receptions", "rec_yds": "receiving_yards", "tgt": "targets"}
    per_game = w.groupby(["opponent_team", "game_id", "pg"])[list(stat_cols.values())].sum().reset_index()
    allowed = per_game.groupby(["opponent_team", "pg"])[list(stat_cols.values())].mean()

    # Points for/against from schedule.
    g = games[(games["season"] == season) & (games["game_type"] == "REG") & games["home_score"].notna()]
    pts = {}
    for _, r in g.iterrows():
        for t, pf, pa in ((r["home_team"], r["home_score"], r["away_score"]), (r["away_team"], r["away_score"], r["home_score"])):
            d = pts.setdefault(t, [0, 0, 0])
            d[0] += pf
            d[1] += pa
            d[2] += 1

    teams = {}
    for t in sorted(set(off.index) | set(de.index)):
        ab = espn_abbr(t)
        o = off.loc[t] if t in off.index else None
        d = de.loc[t] if t in de.index else None
        rec = {
            "nflverse": t,
            "games": clean(d["games"] if d is not None else 0),
            "pf": clean(pts[t][0] / pts[t][2], 2) if t in pts else None,
            "pa": clean(pts[t][1] / pts[t][2], 2) if t in pts else None,
            "off": {k: clean(o[k]) for k in ["epa_play", "success", "pass_rate", "epa_pass", "ypp_pass", "epa_rush", "ypc", "plays_g", "dropbacks_g", "rushes_g", "explosive_pass", "explosive_rush", "sack_rate"]} if o is not None else {},
            "def": {k: clean(d[k]) for k in ["epa_play", "success", "epa_pass", "ypp_pass", "epa_rush", "ypc", "plays_g", "dropbacks_g", "rushes_g", "explosive_pass", "explosive_rush", "sack_rate"]} if d is not None else {},
            "allowed": {},
        }
        for pg in ("QB", "RB", "WR", "TE"):
            if (t, pg) in allowed.index:
                row = allowed.loc[(t, pg)]
                rec["allowed"][pg] = {k: clean(row[v], 2) for k, v in stat_cols.items()}
        teams[ab] = rec

    # League averages + ranks (1 = stingiest defense / best offense).
    league = {"def": {}, "off": {}, "allowed": {}}
    for k in ["epa_play", "epa_pass", "ypp_pass", "epa_rush", "ypc", "explosive_pass", "explosive_rush", "sack_rate", "success"]:
        dv = {a: t["def"].get(k) for a, t in teams.items()}
        ov = {a: t["off"].get(k) for a, t in teams.items()}
        league["def"][k] = clean(np.nanmean([v for v in dv.values() if v is not None]))
        league["off"][k] = clean(np.nanmean([v for v in ov.values() if v is not None]))
        higher_good_def = k == "sack_rate"
        rd = ranks(dv, ascending=not higher_good_def)
        ro = ranks(ov, ascending=k == "sack_rate")
        for a in teams:
            teams[a].setdefault("def_rank", {})[k] = rd.get(a)
            teams[a].setdefault("off_rank", {})[k] = ro.get(a)
    for pg in ("QB", "RB", "WR", "TE"):
        league["allowed"][pg] = {}
        for k in stat_cols:
            vals = {a: t["allowed"].get(pg, {}).get(k) for a, t in teams.items()}
            good = [v for v in vals.values() if v is not None]
            league["allowed"][pg][k] = clean(np.mean(good), 2) if good else None
            rk = ranks(vals, ascending=True)
            for a in teams:
                if pg in teams[a]["allowed"]:
                    teams[a]["allowed"][pg][f"{k}_rank"] = rk.get(a)
    pf_all = [t["pf"] for t in teams.values() if t["pf"] is not None]
    league["pf"] = clean(np.mean(pf_all), 2) if pf_all else None
    return teams, league


def build(out, cache):
    games = pd.read_csv(fetch(cache, "schedules/games.csv"), low_memory=False)
    season = current_season(games)
    print(f"NFL season {season}", flush=True)
    players = pd.read_csv(fetch(cache, "players/players.csv.gz"), low_memory=False)
    espn_of = {r.gsis_id: str(int(r.espn_id)) for r in players[["gsis_id", "espn_id"]].dropna().itertuples() if str(r.espn_id).replace(".0", "").isdigit()}

    ngs = {}
    for kind in ("receiving", "passing", "rushing"):
        d = pd.read_csv(fetch(cache, f"nextgen_stats/ngs_{kind}.csv.gz"), low_memory=False)
        ngs[kind] = d[(d["season"] >= season - 1) & (d["week"] > 0)]

    game_meta = games.set_index("game_id")[["home_team", "away_team", "espn", "gameday", "season"]]
    rows = []
    team_out = league = None
    for s in (season - 1, season):
        try:
            wk = pd.read_csv(fetch(cache, f"stats_player/stats_player_week_{s}.csv.gz"), low_memory=False)
        except FileNotFoundError:
            continue
        pbp = pbp_frames(cache, s)
        if pbp is not None:
            wk = wk.merge(receiving_depth(pbp), how="left", left_on=["player_id", "game_id"], right_on=["pid", "game_id"]).drop(columns=["pid"])
            wk = wk.merge(qb_rushing(pbp), how="left", left_on=["player_id", "game_id"], right_on=["pid", "game_id"]).drop(columns=["pid"])
            wk = wk.merge(passing_depth(pbp), how="left", left_on=["player_id", "game_id"], right_on=["pid", "game_id"]).drop(columns=["pid"])
            if s == season:
                team_out, league = team_tables(pbp, wk, games, season)
        for kind, cols in (("receiving", {"avg_separation": "sep", "avg_cushion": "cush", "avg_intended_air_yards": "iay", "catch_percentage": "cpct", "avg_yac_above_expectation": "yacoe"}),
                           ("passing", {"avg_time_to_throw": "ttt", "aggressiveness": "aggr", "completion_percentage_above_expectation": "ngs_cpoe"}),
                           ("rushing", {"rush_yards_over_expected_per_att": "ryoe", "efficiency": "eff", "percent_attempts_gte_eight_defenders": "box8"})):
            n = ngs[kind][ngs[kind]["season"] == s][["player_gsis_id", "week", "season_type", *cols.keys()]].rename(columns=cols)
            n = n.drop_duplicates(["player_gsis_id", "week", "season_type"])
            wk = wk.merge(n, how="left", left_on=["player_id", "week", "season_type"], right_on=["player_gsis_id", "week", "season_type"]).drop(columns=["player_gsis_id"])
        rows.append(wk)
    weekly = pd.concat(rows, ignore_index=True)
    weekly = weekly[weekly["position"].map(POS).notna()]

    fields = {
        "tgt": "targets", "rec": "receptions", "ryd": "receiving_yards", "rtd": "receiving_tds", "air": "receiving_air_yards",
        "yac": "receiving_yards_after_catch", "tsh": "target_share", "ash": "air_yards_share", "wopr": "wopr",
        "t5": "t5", "c5": "c5", "t10": "t10", "c10": "c10", "t20": "t20", "c20": "c20", "ts": "ts", "cs": "cs", "g10": "g10", "g20": "g20", "adot": "adot",
        "sep": "sep", "cush": "cush", "iay": "iay", "cpct": "cpct", "yacoe": "yacoe",
        "car": "carries", "rushyd": "rushing_yards", "rushtd": "rushing_tds", "dr": "dr", "dry": "dry", "scr": "scr", "scry": "scry",
        "ryoe": "ryoe", "eff": "eff", "box8": "box8",
        "att": "attempts", "cmp": "completions", "pyd": "passing_yards", "ptd": "passing_tds", "int": "passing_interceptions",
        "sk": "sacks_suffered", "cpoe": "passing_cpoe", "padot": "padot", "deep": "deep", "ttt": "ttt", "aggr": "aggr", "epa_pass": "passing_epa",
    }
    index = {}
    pdir = os.path.join(out, "nfl", "players")
    os.makedirs(pdir, exist_ok=True)
    for pid, grp in weekly.groupby("player_id"):
        eid = espn_of.get(pid)
        if not eid:
            continue
        grp = grp.sort_values(["season", "week"])
        last = grp.iloc[-1]
        weeks = []
        for r in grp.itertuples(index=False):
            r = r._asdict()
            meta = game_meta.loc[r["game_id"]] if r["game_id"] in game_meta.index else None
            row = {"s": int(r["season"]), "w": int(r["week"]), "post": r["season_type"] != "REG",
                   "team": espn_abbr(r["team"]), "opp": espn_abbr(r["opponent_team"]),
                   "home": bool(meta is not None and meta["home_team"] == r["team"]),
                   "ev": str(int(meta["espn"])) if meta is not None and pd.notna(meta["espn"]) else None,
                   "date": meta["gameday"] if meta is not None else None}
            for k, col in fields.items():
                v = clean(r.get(col))
                if v not in (None, 0):
                    row[k] = v
            weeks.append(row)
        pos = POS[last["position"]]
        write_json(os.path.join(pdir, f"{eid}.json"), {"id": eid, "name": last["player_display_name"], "pos": pos, "team": espn_abbr(last["team"]), "weeks": weeks})
        index[eid] = {"n": last["player_display_name"], "p": pos, "t": espn_abbr(last["team"])}

    write_json(os.path.join(out, "nfl", "teams.json"), {"season": season, "updated": dt.datetime.utcnow().isoformat() + "Z", "teams": team_out or {}, "league": league or {}})
    write_json(os.path.join(out, "nfl", "index.json"), index)
    print(f"NFL: {len(index)} players, {len(team_out or {})} teams", flush=True)
