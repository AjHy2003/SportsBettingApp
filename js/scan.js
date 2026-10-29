// Prop scanning shared by the game page's "Scan all props" and the daily picks
// generator: rosters -> game logs -> model for every posted DraftKings line. No DOM access.
import { api, loadGamelogs, pool } from "./espn.js";
import { MARKETS } from "./sports.js";
import { loadDeepPlayer, deepGameStats } from "./deep.js";
import { marketsFor, opponentFactor, runProp, playedGames, combineOpponent } from "./props.js";
import { playerContext, roleChange } from "./context.js";

export async function loadPeople(L, teams) {
  const people = new Map();
  await Promise.all(teams.map(async (t) => {
    try {
      const r = await api.roster(L, t.id);
      const list = Array.isArray(r.athletes?.[0]?.items) ? r.athletes.flatMap((g) => g.items) : r.athletes || [];
      for (const p of list) people.set(String(p.id), { name: p.displayName, pos: p.position?.abbreviation, team: t, img: p.headshot?.href, status: p.status?.type, injuries: p.injuries });
    } catch { /* roster unavailable */ }
  }));
  return people;
}

// Fill stats ESPN's game log lacks (NHL hits/blocks) from pipeline rows, matched by event id.
export function mergeDeepStats(L, games, deepPlayer) {
  const extra = deepGameStats(L, deepPlayer);
  if (!extra) return;
  for (const g of games) {
    const x = extra.get(String(g.eventId));
    if (!x) continue;
    for (const [k, v] of Object.entries(x)) if (g.stats[k] == null && v != null) g.stats[k] = v;
  }
}

// One row per (player, market) with a posted line.
export function propRows(L, propsAll, people) {
  const allMarkets = MARKETS[L.markets] || [];
  const rows = [];
  for (const [aid, mk] of propsAll || []) {
    for (const [key, p] of Object.entries(mk)) {
      const m = allMarkets.find((x) => x.key === key);
      if (!m) continue;
      rows.push({ aid, key, m, p, who: people.get(aid) || { name: `Player ${aid}`, team: null } });
    }
  }
  return rows;
}

// Run the prop model on every row.
// game = { H, A, date, lines?: {spreadHome, total}, report?: injuryReport() map, weather?: gameWeather() }.
export async function scanRows(L, rows, { game, standings, deep, concurrency = 4, onProgress } = {}) {
  const ids = [...new Set(rows.map((r) => r.aid))];
  const logs = new Map(), deepPlayers = new Map();
  let done = 0;
  await pool(ids, concurrency, async (aid) => {
    try {
      const [lg, dp] = await Promise.all([loadGamelogs(L, aid, L.markets), loadDeepPlayer(L, aid).catch(() => null)]);
      logs.set(aid, lg);
      deepPlayers.set(aid, dp);
    } catch { logs.set(aid, null); }
    onProgress?.(++done, ids.length);
  });
  const { H, A } = game;
  for (const r of rows) {
    const log = logs.get(r.aid);
    if (!log) { r.err = true; continue; }
    const games = playedGames(log, r.who.team?.id);
    mergeDeepStats(L, games, deepPlayers.get(r.aid));
    const fam = log.family;
    if (!games.length || !marketsFor(fam, games).some((x) => x.key === r.key)) { r.err = true; continue; }
    const isHome = r.who.team && String(r.who.team.id) === String(H.id);
    const next = r.who.team ? { oppId: isHome ? A.id : H.id, opp: isHome ? A.abbreviation : H.abbreviation, home: isHome, date: game.date } : null;
    const opp = opponentFactor({ L, fam, m: r.m, next, standings, deep, athlete: { id: r.aid, position: { abbreviation: r.who.pos }, team: r.who.team } });
    const context = r.who.team ? await playerContext({ L, fam, m: r.m, games, teamId: r.who.team.id, teamAbbr: r.who.team.abbreviation, isHome, lines: game.lines, standings, report: game.report, playerId: r.aid, weather: game.weather }) : null;
    if (context?.status?.out) { r.err = true; r.out = context.status.status; continue; }
    const { res, withVal } = runProp(fam, r.m, games, { line: r.p.line, oddsOver: r.p.over, oddsUnder: r.p.under, opp, posted: r.p, context });
    if (!res.n) { r.err = true; continue; }
    // A questionable player might sit or be limited: never more than a C.
    if (context?.status?.maybe && ["A", "B"].includes(res.verdict?.grade)) { res.verdict.grade = "C"; res.verdict.questionable = true; }
    const rc = res.verdict && roleChange(context, r.who.pos, res.verdict.lean, r.p.line, res.projection);
    if (rc) { res.verdict.grade = "PASS"; res.verdict.side = null; res.verdict.roleChange = rc; }
    r.res = res;
    r.edge = res.verdict?.edge;
    r.opp = combineOpponent(opp, context);
    r.context = context;
    // Recent hit rate on the leaning side, for the pick write-up.
    const last10 = withVal.slice(0, 10).map((g) => g.value);
    const overs = last10.filter((v) => v > r.p.line).length, unders = last10.filter((v) => v < r.p.line).length;
    r.l10 = { overs, unders, n: last10.length };
  }
  return rows;
}
