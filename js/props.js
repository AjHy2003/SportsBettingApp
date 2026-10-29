// Shared prop-analysis plumbing used by the player page and the game prop scanner.
import { MARKETS } from "./sports.js";
import * as M from "./model.js";
import { fx } from "./ui.js";
import { deepOppFactor } from "./deep.js";

export const MODEL_SAMPLE = 40;
const REGRESS_GAMES = { basketball: 10, football: 4, baseball: 25, baseballPitching: 25, hockey: 12, soccer: 6 };
const UNIT = { basketball: "pts", football: "pts", hockey: "goals", soccer: "goals", baseball: "runs", baseballPitching: "runs" };

export function marketValue(m, g) {
  let s = 0;
  for (const k of m.stats) {
    const v = g.stats[k];
    if (v == null) return null;
    s += v;
  }
  return s;
}

export function marketsFor(fam, games) {
  let list;
  if (fam === "baseballPitching") list = MARKETS.baseball.filter((m) => m.pitcher);
  else if (fam === "baseball") list = MARKETS.baseball.filter((m) => !m.pitcher);
  else list = MARKETS[fam] || [];
  const recent = games.slice(0, 25);
  const isGoalie = recent.some((g) => g.stats.saves > 0);
  return list.filter((m) => {
    if (m.goalie && !isGoalie) return false;
    if (isGoalie && !m.goalie && (fam === "hockey" || fam === "soccer") && m.key !== "toi") return false;
    const vals = recent.map((g) => marketValue(m, g)).filter((v) => v != null);
    if (!vals.length || !vals.some((v) => v > 0)) return false;
    // Hide side stats the player rarely records (a WR's carries, a QB's catches) unless it's a rare-event market.
    return RARE.has(m.key) || vals.filter((v) => v > 0).length / vals.length >= 0.3;
  });
}

const RARE = new Set(["pass_td", "pass_int", "any_td", "hr", "sb", "stl", "blk", "g", "a", "ga", "sacks", "rbi", "r", "bb", "so", "pts", "fg3m"]);
const PRIMARY = ["pass_yds", "rec_yds", "rush_yds", "pts", "sog", "k", "tb", "shots", "saves", "outs", "h"];

// Default market: the player's biggest primary stat (a WR opens on receiving yards, a QB on passing).
export function defaultMarket(markets, games) {
  let best = null, bestVal = -1;
  for (const m of markets) {
    if (!PRIMARY.includes(m.key)) continue;
    const vals = games.slice(0, 10).map((g) => marketValue(m, g)).filter((v) => v != null);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    if (avg > bestVal) { best = m; bestVal = avg; }
  }
  return (best || markets[0])?.key;
}

// Opponent multiplier for the next game: pipeline data first, then standings.
export function opponentFactor({ L, fam, m, next, standings, deep, athlete }) {
  if (!next?.oppId) return { factor: 1, why: "No upcoming opponent found." };
  const d = deep && deepOppFactor(L, deep, m, next, athlete);
  if (d) return d;
  if (!m.oppEl || !standings?.leagueAvg) return { factor: 1, why: "No opponent adjustment for this market." };
  const t = standings.teams[next.oppId];
  if (!t || !t.gp) return { factor: 1, why: "Opponent has no games yet." };
  const side = m.oppSide === "off" ? t.pf : t.pa;
  const raw = side / standings.leagueAvg;
  const k = REGRESS_GAMES[fam] || 10;
  const reg = 1 + (raw - 1) * (t.gp / (t.gp + k));
  const factor = Math.min(1.25, Math.max(0.8, Math.pow(reg, m.oppEl)));
  const what = m.oppSide === "off" ? `scores ${fx(side)} ${UNIT[fam] || "pts"}/game` : `allows ${fx(side)} ${UNIT[fam] || "pts"}/game`;
  return { factor, why: `${next.opp} ${what} vs league avg ${fx(standings.leagueAvg)} (${t.gp} games, shrunk toward average) → ×${factor.toFixed(3)}.` };
}

export function runProp(fam, m, games, { line, oddsOver, oddsUnder, opp, role = 0, minutes = null, posted = null }) {
  const withVal = games.map((g) => ({ ...g, value: marketValue(m, g) })).filter((g) => g.value != null);
  // A sportsbook's posted main line without prices still says "about 50/50 here".
  const marketProb = posted && Number(line) === posted.line && (posted.over == null || posted.under == null) ? 0.5 : null;
  const res = M.analyzeProp(withVal.slice(0, MODEL_SAMPLE), {
    line, oddsOver, oddsUnder, dist: m.dist, marketProb,
    oppFactor: opp?.factor ?? 1, roleAdj: role, perMinute: m.perMinute, minutesOverride: Number(minutes) || null,
    halfLife: fam === "football" ? 6 : 10,
  });
  return { res, withVal };
}

// Weight multipliers: last season counts 75%, games for a previous team 35%.
export const PREV_SEASON_W = 0.75;
export const OLD_TEAM_W = 0.35;

// Games a player actually played, with minutes, rest days and weights attached.
export function playedGames(log, currentTeamId) {
  const fam = log.family;
  const games = log.games.filter((g) => !(fam === "basketball" && !(g.stats.min > 0)));
  const team = String(currentTeamId || games[0]?.teamId || "");
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    g.minutes = g.stats.min ?? null;
    const nxt = games[i + 1];
    g.rest = nxt ? Math.round((new Date(g.date) - new Date(nxt.date)) / 864e5) - 1 : null;
    g.oldTeam = !!(team && g.teamId && String(g.teamId) !== team);
    g.w = (g.season !== log.season ? PREV_SEASON_W : 1) * (g.oldTeam ? OLD_TEAM_W : 1);
  }
  return games;
}
