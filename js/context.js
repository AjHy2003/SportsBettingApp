// Game-day context for player props, shared by the player page, the prop
// scanner and the daily picks generator (no DOM):
//   - Vegas environment: the team's implied points from spread + total, NFL
//     game script, NBA blowout minutes.
//   - Injury report: who's out tonight, and how this player produced in past
//     games without those teammates (with/without splits).
import { marketValue } from "./props.js";
import { TEAM_REGRESS } from "./gamemodel.js";

// How strongly each market tracks the team's scoring environment.
const ENV_ELASTICITY = {
  basketball: { pts: 0.8, fgm: 0.8, fga: 0.5, ftm: 0.7, fg3m: 0.6, fg3a: 0.4, pra: 0.65, pr: 0.7, pa: 0.8, ast: 0.6, ra: 0.45, reb: 0.25, stl: 0.2, blk: 0.1, tov: 0.3 },
  football: { pass_yds: 0.6, pass_cmp: 0.4, pass_att: 0.3, pass_td: 0.9, rec: 0.4, rec_yds: 0.6, tgt: 0.3, rush_yds: 0.6, rush_att: 0.4, any_td: 0.9, rush_rec_yds: 0.6, pass_rush_yds: 0.6, long_rec: 0.3, long_rush: 0.3 },
  hockey: { g: 0.9, a: 0.9, pts: 0.9, sog: 0.4 },
  soccer: { g: 0.9, a: 0.9, ga: 0.9, shots: 0.5, sot: 0.6 },
};
// NFL game script: favorites run more, underdogs throw more (per point favored).
const SCRIPT = { rush_att: 0.010, rush_yds: 0.010, pass_att: -0.008, pass_cmp: -0.008, pass_yds: -0.006, rec: -0.005, tgt: -0.005, rec_yds: -0.004 };

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const pts1 = (x) => (Math.round(x * 10) / 10).toString();

export const impliedPoints = (lines, isHome) => {
  if (lines?.total == null || lines?.spreadHome == null) return null;
  return lines.total / 2 + (isHome ? -lines.spreadHome / 2 : lines.spreadHome / 2);
};

// lines: { spreadHome, total }. Returns { factor, minutesFactor, notes[] }.
export function vegasContext({ fam, m, teamId, teamAbbr, isHome, lines, standings, avgMinutes }) {
  const out = { factor: 1, minutesFactor: 1, notes: [], implied: null };
  const implied = impliedPoints(lines, isHome);
  if (implied == null) return out;
  out.implied = implied;
  const el = ENV_ELASTICITY[fam]?.[m.key] || 0;
  const t = standings?.teams?.[teamId];
  if (el && t?.pf && standings.leagueAvg) {
    const k = TEAM_REGRESS[fam] || 8;
    const base = (t.gp * t.pf + k * standings.leagueAvg) / (t.gp + k);
    const f = clamp(Math.pow(implied / base, el), 0.85, 1.18);
    if (Math.abs(f - 1) > 0.005) {
      out.factor *= f;
      out.notes.push(`Vegas has ${teamAbbr || "the team"} at ${pts1(implied)} points tonight vs a usual ${pts1(base)} → ×${f.toFixed(3)}`);
    }
  }
  const favoredBy = isHome ? -lines.spreadHome : lines.spreadHome;
  if (fam === "football" && SCRIPT[m.key] && Math.abs(favoredBy) >= 1) {
    const f = clamp(1 + SCRIPT[m.key] * clamp(favoredBy, -14, 14), 0.88, 1.12);
    out.factor *= f;
    out.notes.push(`Game script: ${favoredBy > 0 ? `favored by ${pts1(favoredBy)}` : `${pts1(-favoredBy)}-point underdog`} → ×${f.toFixed(3)}`);
  }
  // NBA blowouts: starters sit late in lopsided games.
  if (fam === "basketball" && m.perMinute && avgMinutes >= 26 && Math.abs(lines.spreadHome) >= 9) {
    const mf = clamp(1 - 0.007 * (Math.abs(lines.spreadHome) - 8), 0.92, 1);
    out.minutesFactor = mf;
    out.notes.push(`${pts1(Math.abs(lines.spreadHome))}-point spread: blowout risk trims starter minutes ×${mf.toFixed(3)}`);
  }
  return out;
}

// ---------- injuries ----------
const OUT_RE = /\bout\b|injured reserve|\bir\b|suspend|doubtful|pup|not active|inactive/i;
const MAYBE_RE = /questionable|day-to-day|game-time|probable/i;

// From an ESPN game summary: Map teamId -> [{ id, name, pos, status, out, maybe }].
export function injuryReport(sum) {
  const map = new Map();
  for (const t of sum?.injuries || []) {
    const tid = String(t.team?.id ?? "");
    const list = (t.injuries || []).map((i) => {
      const status = i.status || i.type?.description || "";
      return { id: String(i.athlete?.id ?? ""), name: i.athlete?.displayName, pos: i.athlete?.position?.abbreviation, status, out: OUT_RE.test(status), maybe: !OUT_RE.test(status) && MAYBE_RE.test(status) };
    }).filter((x) => x.id);
    map.set(tid, list);
  }
  return map;
}

export function playerStatus(report, teamId, playerId) {
  return (report?.get(String(teamId)) || []).find((x) => x.id === String(playerId)) || null;
}

const lineupCache = new Map();
export async function loadLineups(L, teamAbbr) {
  if (!L.deep || !teamAbbr || !["nba", "nfl"].includes(L.deep)) return null;
  const key = `${L.deep}/${teamAbbr}`;
  if (!lineupCache.has(key)) {
    lineupCache.set(key, fetch(`data/${L.deep}/lineups/${teamAbbr}.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return lineupCache.get(key);
}

// How the player produced in games without tonight's missing teammates,
// relative to the (recency-weighted) sample the projection already uses.
// games: playedGames() output, newest first. Returns { factor, notes[], detail } or null.
export function withWithout({ games, m, lineup, outTeammates, halfLife = 10 }) {
  if (!lineup?.games || !outTeammates?.length) return null;
  const G = lineup.games;
  const mine = games.filter((g) => G[String(g.eventId)] && g.stats).map((g, i) => ({ g, v: marketValue(m, g), w: Math.pow(0.5, i / halfLife) * (g.w ?? 1) })).filter((x) => x.v != null);
  if (mine.length < 6) return null;
  // Only teammates who were real contributors in this sample matter.
  const freq = (id) => mine.filter((x) => G[String(x.g.eventId)].p[id] != null).length / mine.length;
  const relevant = outTeammates.filter((t) => freq(t.id) >= 0.3).sort((a, b) => freq(b.id) - freq(a.id)).slice(0, 3);
  if (!relevant.length) return null;
  const absentAll = (x, ids) => ids.every((id) => G[String(x.g.eventId)].p[id] == null);
  let ids = relevant.map((t) => t.id);
  let without = mine.filter((x) => absentAll(x, ids));
  if (without.length < 2 && ids.length > 1) {
    ids = [ids[0]];
    without = mine.filter((x) => absentAll(x, ids));
  }
  if (without.length < 2) return null;
  const names = relevant.filter((t) => ids.includes(t.id)).map((t) => t.name);
  const perMin = m.perMinute && mine.every((x) => x.g.minutes > 0);
  const rate = (xs, weighted) => {
    const w = (x) => (weighted ? x.w : 1);
    const num = xs.reduce((s, x) => s + w(x) * x.v, 0);
    const den = xs.reduce((s, x) => s + w(x) * (perMin ? x.g.minutes : 1), 0);
    return den ? num / den : NaN;
  };
  const minutes = (xs, weighted) => {
    const w = (x) => (weighted ? x.w : 1);
    return xs.reduce((s, x) => s + w(x) * (x.g.minutes || 0), 0) / xs.reduce((s, x) => s + w(x), 0);
  };
  const n = without.length;
  const shrinkTo = (raw) => 1 + (raw - 1) * (n / (n + 5));
  // Compare against the sample the projection uses, so long absences aren't double counted.
  let factor = shrinkTo(rate(without, false) / rate(mine, true));
  if (perMin) factor *= shrinkTo(minutes(without, false) / minutes(mine, true));
  factor = clamp(factor, 0.8, 1.35);
  const avgWith = mine.filter((x) => !absentAll(x, ids));
  const fmt = (xs) => (xs.length ? (xs.reduce((s, x) => s + x.v, 0) / xs.length).toFixed(1) : "—");
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return {
    factor,
    names,
    nWithout: n,
    nWith: avgWith.length,
    notes: [`${who} out: ${fmt(without)} ${m.label.toLowerCase()} in ${n} game${n === 1 ? "" : "s"} without vs ${fmt(avgWith)} with → ×${factor.toFixed(3)}`],
  };
}

// Everything above for one player in one game.
export async function playerContext({ L, fam, m, games, teamId, teamAbbr, isHome, lines, standings, report, playerId }) {
  const avgMinutes = games.slice(0, 10).reduce((s, g) => s + (g.minutes || 0), 0) / Math.max(1, Math.min(10, games.length));
  const v = vegasContext({ fam, m, teamId, teamAbbr, isHome, lines, standings, avgMinutes });
  const me = playerStatus(report, teamId, playerId);
  const outMates = (report?.get(String(teamId)) || []).filter((x) => x.out && x.id !== String(playerId));
  let ww = null;
  if (outMates.length) {
    const lineup = await loadLineups(L, teamAbbr);
    ww = withWithout({ games, m, lineup, outTeammates: outMates, halfLife: fam === "football" ? 6 : 10 });
  }
  return {
    factor: v.factor * (ww?.factor ?? 1),
    minutesFactor: v.minutesFactor,
    notes: [...v.notes, ...(ww?.notes || [])],
    implied: v.implied,
    status: me,
    outMates,
    withWithout: ww,
  };
}
