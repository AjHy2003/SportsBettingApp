// Live games: ESPN's live win probability next to DraftKings' live moneyline.
// No DOM. One scoreboard per league, plus one small odds request per live game.
import { leagueById } from "./sports.js";
import { getJSON } from "./espn.js";
import { noVig } from "./model.js";

const SITE = "https://site.web.api.espn.com/apis/site/v2/sports";
const CORE = "https://sports.core.api.espn.com/v2/sports";
const etYmd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replaceAll("-", "");

// DraftKings live odds (ESPN provider 200) for one game, or null when none are posted.
export async function liveOdds(L, ev, ttl = 20e3) {
  const [sport, league] = L.espn.split("/");
  const d = await getJSON(`${CORE}/${sport}/leagues/${league}/events/${ev}/competitions/${ev}/odds`, ttl);
  const it = (d.items || []).find((x) => String(x.provider?.id) === "200" || /live/i.test(x.provider?.name || ""));
  if (!it) return null;
  const n = (v) => (v != null && isFinite(Number(v)) ? Number(v) : null);
  return { mlHome: n(it.homeTeamOdds?.moneyLine), mlAway: n(it.awayTeamOdds?.moneyLine), spreadHome: n(it.spread), total: n(it.overUnder), provider: it.provider?.name || "DraftKings live" };
}

// Every game in progress (plus today's upcoming ones) in these leagues.
export async function liveBoard(leagueIds, { ttl = 20e3 } = {}) {
  const out = [];
  await Promise.all(leagueIds.map(async (id) => {
    const L = leagueById(id);
    if (!L?.espn) return;
    const weekly = id === "nfl" || id === "ncaaf";
    let sb;
    try { sb = await getJSON(`${SITE}/${L.espn}/scoreboard${weekly ? (id === "ncaaf" ? "?groups=80&limit=300" : "") : `?dates=${etYmd(new Date())}${id === "ncaab" ? "&groups=50&limit=400" : ""}`}`, ttl); } catch { return; }
    for (const e of sb.events || []) {
      const c = e.competitions?.[0];
      const state = e.status?.type?.state;
      if (!c || state === "post") continue;
      if (state === "pre" && new Date(e.date) - Date.now() > 14 * 3600e3) continue;
      const side = (ha) => { const x = c.competitors.find((t) => t.homeAway === ha) || {}; return { id: String(x.team?.id ?? ""), abbr: x.team?.abbreviation || "", name: x.team?.shortDisplayName || x.team?.displayName || "", logo: x.team?.logo || "", score: x.score != null ? Number(x.score) : null }; };
      const pr = c.situation?.lastPlay?.probability;
      out.push({
        league: id, eventId: String(e.id), state, start: e.date, detail: e.status?.type?.shortDetail || "",
        home: side("home"), away: side("away"),
        winHome: pr?.homeWinPercentage != null ? Number(pr.homeWinPercentage) : null,
      });
    }
  }));
  return out.sort((a, b) => (a.state === "in" ? 0 : 1) - (b.state === "in" ? 0 : 1) || new Date(a.start) - new Date(b.start));
}

// ESPN's number vs the market's (no-vig) for the home team; positive = ESPN likes home more.
export function liveEdge(g, odds) {
  if (g.winHome == null || odds?.mlHome == null || odds?.mlAway == null) return null;
  const nv = noVig(odds.mlHome, odds.mlAway);
  if (!nv) return null;
  const diff = g.winHome - nv.a;
  const side = diff >= 0 ? "home" : "away";
  return { marketHome: nv.a, espnHome: g.winHome, diff, side, team: g[side].abbr, ml: side === "home" ? odds.mlHome : odds.mlAway, big: Math.abs(diff) >= 0.06 };
}
