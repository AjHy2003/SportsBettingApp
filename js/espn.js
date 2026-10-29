// ESPN public JSON endpoints. Browsers are blocked on site.api.espn.com, so
// everything goes through site.web.api.espn.com, which serves the same paths with CORS.
import { LEAGUES } from "./sports.js";

const SITE = "https://site.web.api.espn.com/apis/site/v2/sports";
const WEB = "https://site.web.api.espn.com/apis/common/v3/sports";
const CORE = "https://sports.core.api.espn.com/v2/sports";
const STAND = "https://site.web.api.espn.com/apis/v2/sports";

const cache = new Map();

export async function getJSON(url, ttl = 10 * 60e3) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`${r.status} from ${new URL(url).hostname}`);
    return r.json();
  });
  cache.set(url, { t: Date.now(), p });
  p.catch(() => cache.delete(url));
  return p;
}

// Drop cached responses whose URL contains `part` (all of them without an argument).
export function clearCache(part = "") {
  for (const k of [...cache.keys()]) if (k.includes(part)) cache.delete(k);
}

// Run async fn over items with limited concurrency.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e }; }
    }
  }));
  return out;
}

const split = (L) => L.espn.split("/");

export const api = {
  scoreboard: (L, params = "") => getJSON(`${SITE}/${L.espn}/scoreboard${params ? "?" + params : ""}`, 60e3),
  summary: (L, ev) => getJSON(`${SITE}/${L.espn}/summary?event=${ev}`, 2 * 60e3),
  schedule: (L, team, season) => getJSON(`${SITE}/${L.espn}/teams/${team}/schedule${season ? `?season=${season}` : ""}`),
  roster: (L, team) => getJSON(`${SITE}/${L.espn}/teams/${team}/roster`, 60 * 60e3),
  standings: (L) => getJSON(`${STAND}/${L.espn}/standings`, 30 * 60e3),
  athlete: (L, id) => getJSON(`${WEB}/${L.espn}/athletes/${id}`, 30 * 60e3),
  overview: (L, id) => getJSON(`${WEB}/${L.espn}/athletes/${id}/overview`, 5 * 60e3),
  gamelog: (L, id, season) => getJSON(`${WEB}/${L.espn}/athletes/${id}/gamelog${season ? `?season=${season}` : ""}`),
  propBets: async (L, ev, provider = 100) => {
    const [sport, league] = split(L);
    const base = `${CORE}/${sport}/leagues/${league}/events/${ev}/competitions/${ev}/odds/${provider}/propBets?limit=500`;
    const first = await getJSON(base, 5 * 60e3);
    const pages = [first];
    for (let p = 2; p <= (first.pageCount || 1); p++) pages.push(await getJSON(`${base}&page=${p}`, 5 * 60e3));
    return pages.flatMap((x) => x.items || []);
  },
  search: (q) => getJSON(`https://site.web.api.espn.com/apis/search/v2?query=${encodeURIComponent(q)}&limit=25`, 60 * 60e3),
};

// ---------- search ----------
export async function searchPlayers(q) {
  const d = await api.search(q);
  const players = (d.results || []).filter((r) => r.type === "player").flatMap((r) => r.contents || []);
  return players.map((p) => {
    const aid = (p.uid || "").match(/a:(\d+)/)?.[1];
    const L = LEAGUES.find((l) => l.espn && l.espn.endsWith("/" + p.defaultLeagueSlug) && l.espn.startsWith(p.sport));
    return { id: aid, name: p.displayName, sub: [p.description, p.subtitle].filter(Boolean).join(" · "), img: p.image?.default, league: L?.id };
  }).filter((p) => p.id && p.league);
}

// ---------- gamelog parsing ----------
const num = (s) => {
  if (s == null || s === "" || s === "-" || s === "--") return null;
  if (typeof s === "number") return s;
  if (/^\d+:\d{2}$/.test(s)) { const [m, sec] = s.split(":").map(Number); return m + sec / 60; }
  const n = parseFloat(String(s).replace(/,/g, ""));
  return isFinite(n) ? n : null;
};

// ESPN stat name -> normalized key, per market family. "cat.name" entries win over bare names.
const NAME_MAP = {
  basketball: {
    minutes: "min", points: "pts", totalRebounds: "reb", assists: "ast", steals: "stl", blocks: "blk",
    turnovers: "tov", fouls: "pf", offensiveRebounds: "oreb", defensiveRebounds: "dreb",
    "fieldGoalsMade-fieldGoalsAttempted": ["fgm", "fga"],
    "threePointFieldGoalsMade-threePointFieldGoalsAttempted": ["fg3m", "fg3a"],
    "freeThrowsMade-freeThrowsAttempted": ["ftm", "fta"],
  },
  football: {
    completions: "pass_cmp", passingAttempts: "pass_att", passingYards: "pass_yds", passingTouchdowns: "pass_td",
    interceptions: "pass_int", "passing.sacks": "sacked", longPassing: "long_pass", QBRating: "rating", adjQBR: "qbr",
    rushingAttempts: "rush_att", rushingYards: "rush_yds", rushingTouchdowns: "rush_td", longRushing: "long_rush",
    receptions: "rec", receivingTargets: "tgt", receivingYards: "rec_yds", receivingTouchdowns: "rec_td", longReception: "long_rec",
    totalTackles: "tackles", "defensive.sacks": "def_sacks", "defensiveInterceptions.interceptions": "def_int",
    fumblesLost: "fum_lost",
  },
  baseball: {
    atBats: "ab", runs: "r", hits: "h", doubles: "d2", triples: "d3", homeRuns: "hr", RBIs: "rbi", walks: "bb",
    hitByPitch: "hbp", strikeouts: "so", stolenBases: "sb",
  },
  baseballPitching: {
    innings: "ip", hits: "p_h", runs: "p_r", earnedRuns: "er", homeRuns: "p_hr", walks: "p_bb", strikeouts: "k",
    pitches: "pitches", pitchCount: "pitches", numberOfPitches: "pitches", battersFaced: "bf",
  },
  hockey: {
    goals: "g", assists: "a", points: "pts", plusMinus: "pm", penaltyMinutes: "pim", shotsTotal: "sog",
    timeOnIcePerGame: "min", timeOnIce: "min", powerPlayGoals: "ppg", powerPlayAssists: "ppa",
    saves: "saves", goalsAgainst: "ga", shotsAgainst: "sa", blockedShots: "blk", hits: "hits",
  },
  soccer: {
    totalGoals: "g", goalAssists: "a", totalShots: "shots", shotsOnTarget: "sot", foulsCommitted: "fouls",
    foulsSuffered: "fouled", offsides: "offsides", yellowCards: "yc", redCards: "rc", saves: "saves", goalsConceded: "ga",
  },
};

function derive(fam, s) {
  if (fam === "baseball") {
    if (s.h != null) s.tb = s.h + (s.d2 || 0) + 2 * (s.d3 || 0) + 3 * (s.hr || 0);
  }
  if (fam === "baseballPitching" && s.ip != null) {
    const whole = Math.trunc(s.ip);
    s.outs = whole * 3 + Math.round((s.ip - whole) * 10);
  }
  if (fam === "football") {
    if (s.rec != null && s.tgt == null) s.tgt = null;
  }
  return s;
}

// Returns { family, seasons:[{value,label}], games:[...] } with games newest first.
export function parseGamelog(json, family) {
  const names = json.names || [];
  let fam = family;
  if (family === "baseball" && (names.includes("innings") || names.includes("earnedRuns"))) fam = "baseballPitching";
  const map = NAME_MAP[fam] || {};
  // Category-qualified names (NFL groups columns by passing/rushing/...).
  const qual = [];
  if (json.categories) {
    let i = 0;
    for (const c of json.categories) for (let k = 0; k < c.count; k++) qual[i++] = c.name;
  }
  const keys = names.map((n, i) => map[`${qual[i]}.${n}`] ?? map[n] ?? null);
  const events = json.events || {};
  const seen = new Set();
  const games = [];
  for (const st of json.seasonTypes || []) {
    const label = st.displayName || "";
    if (/preseason/i.test(label)) continue;
    const type = /post|playoff/i.test(label) ? "post" : "reg";
    for (const cat of st.categories || []) {
      for (const e of cat.events || []) {
        if (seen.has(e.eventId)) continue;
        seen.add(e.eventId);
        const meta = events[e.eventId] || {};
        const s = {};
        e.stats.forEach((v, i) => {
          const k = keys[i];
          if (!k) return;
          if (Array.isArray(k)) {
            const [a, b] = String(v).split("-").map(num);
            s[k[0]] = a; s[k[1]] = b;
          } else {
            s[k] = num(v);
          }
        });
        derive(fam, s);
        games.push({
          eventId: e.eventId,
          date: meta.gameDate,
          opp: meta.opponent?.abbreviation || "",
          oppId: meta.opponent?.id,
          oppName: meta.opponent?.displayName,
          oppLogo: meta.opponent?.logo,
          teamId: meta.opponent?.id != null && String(meta.homeTeamId) === String(meta.opponent.id) ? meta.awayTeamId : meta.homeTeamId,
          home: meta.atVs === "vs",
          result: meta.gameResult,
          score: meta.score,
          seasonType: type,
          seasonLabel: label,
          stats: s,
        });
      }
    }
  }
  games.sort((a, b) => new Date(b.date) - new Date(a.date));
  const seasonFilter = (json.filters || []).find((f) => f.name === "season");
  return {
    family: fam,
    season: seasonFilter?.value,
    seasons: seasonFilter?.options?.map((o) => ({ value: o.value, label: o.displayValue })) || [],
    games,
  };
}

// Load this season plus the previous one so early-season samples are not tiny.
export async function loadGamelogs(L, id, family, nSeasons = 2) {
  const cur = parseGamelog(await api.gamelog(L, id), family);
  const out = { ...cur, games: cur.games.map((g) => ({ ...g, season: cur.season })) };
  const idx = cur.seasons.findIndex((s) => s.value === cur.season);
  const older = cur.seasons.slice(idx + 1, idx + nSeasons);
  for (const s of older) {
    try {
      const prev = parseGamelog(await api.gamelog(L, id, s.value), family);
      out.games.push(...prev.games.map((g) => ({ ...g, season: s.value })));
    } catch { /* older season missing */ }
  }
  out.seasonLabels = Object.fromEntries(cur.seasons.map((s) => [s.value, s.label]));
  return out;
}

// ---------- odds ----------
export function gameOdds(comp) {
  const o = comp?.odds?.[0];
  if (!o) return null;
  const am = (x) => (x == null ? null : Number(String(x).replace("+", "")));
  const line = (x) => (x == null ? null : Number(String(x).replace(/^[ou]/, "")));
  return {
    provider: o.provider?.displayName || o.provider?.name,
    details: o.details,
    spreadHome: o.spread != null ? Number(o.spread) : line(o.pointSpread?.home?.close?.line),
    total: o.overUnder != null ? Number(o.overUnder) : line(o.total?.over?.close?.line),
    spreadHomeOdds: am(o.pointSpread?.home?.close?.odds),
    spreadAwayOdds: am(o.pointSpread?.away?.close?.odds),
    overOdds: am(o.total?.over?.close?.odds),
    underOdds: am(o.total?.under?.close?.odds),
    mlHome: am(o.moneyline?.home?.close?.odds),
    mlAway: am(o.moneyline?.away?.close?.odds),
    draw: am(o.drawOdds?.moneyLine),
  };
}

// pickcenter entries from a game summary.
export function pickcenterOdds(pc) {
  if (!pc) return null;
  return {
    provider: pc.provider?.name,
    details: pc.details,
    spreadHome: pc.spread != null ? Number(pc.spread) : null,
    total: pc.overUnder != null ? Number(pc.overUnder) : null,
    spreadHomeOdds: pc.homeTeamOdds?.spreadOdds ?? null,
    spreadAwayOdds: pc.awayTeamOdds?.spreadOdds ?? null,
    overOdds: pc.overOdds ?? null,
    underOdds: pc.underOdds ?? null,
    mlHome: pc.homeTeamOdds?.moneyLine ?? null,
    mlAway: pc.awayTeamOdds?.moneyLine ?? null,
    draw: pc.drawOdds?.moneyLine ?? null,
  };
}

// ESPN prop type name -> our market key.
const PROP_TYPES = [
  [/3-?point|three/i, "fg3m"],
  [/points.*rebounds.*assists|pts.*reb.*ast/i, "pra"],
  [/points.*rebounds/i, "pr"],
  [/points.*assists/i, "pa"],
  [/rebounds.*assists/i, "ra"],
  [/^total points/i, "pts"],
  [/^total rebounds/i, "reb"],
  [/^total assists/i, "ast"],
  [/steals.*blocks/i, "sb"],
  [/^total steals/i, "stl"],
  [/^total blocks/i, "blk"],
  [/turnovers/i, "tov"],
  [/passing yards/i, "pass_yds"],
  [/pass completions|completions/i, "pass_cmp"],
  [/pass(ing)? attempts/i, "pass_att"],
  [/passing touchdowns/i, "pass_td"],
  [/interceptions/i, "pass_int"],
  [/rushing \+ receiving|rush.*rec.*yards/i, "rush_rec_yds"],
  [/rushing yards/i, "rush_yds"],
  [/carries|rushing attempts/i, "rush_att"],
  [/receiving yards/i, "rec_yds"],
  [/receptions/i, "rec"],
  [/strikeouts/i, "k"],
  [/total bases/i, "tb"],
  [/hits \+ runs \+ rbis/i, "hrr"],
  [/shots on goal/i, "sog"],
  [/shots on target/i, "sot"],
  [/blocked shots/i, "blk"],
  [/saves/i, "saves"],
  [/^total goals/i, "g"],
  [/^total hits$/i, "hits"],
  [/^total shots$/i, "shots"],
  [/home runs/i, "hr"],
  [/^total rbis/i, "rbi"],
  [/^total runs/i, "r"],
];

// Same ESPN prop name, different stat per sport.
const FAMILY_ALIAS = {
  hockey: { ast: "a" },
  soccer: { ast: "a" },
  baseball: { hits: "h", ast: null },
};

export function propMarketKey(typeName, family) {
  // Full-game props only: skip halves, quarters, periods, innings, first-X specials.
  if (/half|quarter|period|inning|\b(1st|2nd|3rd|4th|first|last)\b|\bq[1-4]\b|milestone|alt(ernate)?\b|\+\s*$/i.test(typeName)) return null;
  for (const [re, key] of PROP_TYPES) {
    if (!re.test(typeName)) continue;
    const alias = FAMILY_ALIAS[family];
    return alias && key in alias ? alias[key] : key;
  }
  return null;
}

// Items arrive in Over/Under pairs (same athlete, type and line; Over first —
// confirmed by line moves: when a line drops, the first price shortens).
// Alternate lines are collapsed to the one priced closest to even.
export function parseProps(items, family) {
  const cands = new Map(); // `${aid}|${market}` -> [{line, over, under, ...}]
  for (const it of items) {
    const aid = it.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1];
    const market = propMarketKey(it.type?.name || "", family);
    if (!aid || !market) continue;
    const line = it.current?.target?.value ?? Number(it.odds?.total?.value);
    if (line == null || !isFinite(line)) continue;
    const price = it.odds?.american?.value != null ? Number(String(it.odds.american.value).replace("+", "")) : null;
    const key = `${aid}|${market}`;
    const list = cands.get(key) || [];
    const last = list[list.length - 1];
    if (last && last.line === line && last.under == null && !last.closed) {
      last.under = price;
      last.closed = true;
    } else {
      list.push({ line, over: price, under: null, open: it.open?.target?.value ?? null, type: it.type?.name });
    }
    cands.set(key, list);
  }
  const imp = (o) => (o == null ? 0.5 : o < 0 ? -o / (-o + 100) : 100 / (o + 100));
  const out = new Map(); // athleteId -> { market -> {line, over, under, open, alts} }
  for (const [key, list] of cands) {
    const [aid, market] = key.split("|");
    const priced = list.filter((c) => c.over != null && c.under != null);
    // Unpriced ladders (common for NFL): alternates surround the main line, so take the median.
    const best = priced.length
      ? priced.reduce((a, b) => (Math.abs(imp(a.over) - imp(a.under)) <= Math.abs(imp(b.over) - imp(b.under)) ? a : b))
      : [...list].sort((a, b) => a.line - b.line)[Math.floor((list.length - 1) / 2)];
    const m = out.get(aid) || {};
    m[market] = { line: best.line, over: best.over, under: best.under, open: best.open, type: best.type, alts: list.length };
    out.set(aid, m);
  }
  return out;
}

// ---------- team helpers ----------
export function competitorsOf(evOrComp) {
  const comp = evOrComp.competitions ? evOrComp.competitions[0] : evOrComp;
  const cs = comp.competitors || [];
  return {
    home: cs.find((c) => c.homeAway === "home") || cs[0],
    away: cs.find((c) => c.homeAway === "away") || cs[1],
    comp,
  };
}

// Completed games from a team schedule, newest first.
export function scheduleResults(sched, teamId) {
  const out = [];
  for (const e of sched.events || []) {
    const c = e.competitions?.[0];
    if (!c?.status?.type?.completed) continue;
    const me = c.competitors.find((x) => String(x.team?.id ?? x.id) === String(teamId));
    const op = c.competitors.find((x) => x !== me);
    if (!me || !op) continue;
    const pf = num(me.score?.value ?? me.score?.displayValue ?? me.score);
    const pa = num(op.score?.value ?? op.score?.displayValue ?? op.score);
    if (pf == null || pa == null) continue;
    out.push({
      eventId: e.id, date: e.date, home: me.homeAway === "home", opp: op.team?.abbreviation, oppId: op.team?.id,
      pf, pa, win: me.winner ?? pf > pa, seasonType: e.seasonType?.type ?? c.type?.id,
    });
  }
  return out.sort((a, b) => new Date(b.date) - new Date(a.date));
}

// Standings -> { teamId: {pf, pa, gp, w, l} } for every team plus league average.
export function standingsTable(st) {
  const teams = {};
  const walk = (node) => {
    if (node.standings?.entries) {
      for (const e of node.standings.entries) {
        const s = Object.fromEntries(e.stats.map((x) => [x.name || x.type, x.value ?? num(x.displayValue)]));
        const gp = (s.wins || 0) + (s.losses || 0) + (s.ties || 0) + (s.otLosses || 0) || s.gamesPlayed || 0;
        teams[e.team.id] = {
          abbr: e.team.abbreviation, name: e.team.displayName,
          gp, w: s.wins, l: s.losses,
          pf: s.avgPointsFor ?? (gp ? s.pointsFor / gp : null),
          pa: s.avgPointsAgainst ?? (gp ? s.pointsAgainst / gp : null),
        };
      }
    }
    (node.children || []).forEach(walk);
  };
  walk(st);
  const vals = Object.values(teams).filter((t) => t.gp > 0 && t.pf != null);
  const lg = vals.length ? vals.reduce((s, t) => s + t.pf * t.gp, 0) / vals.reduce((s, t) => s + t.gp, 0) : null;
  return { teams, leagueAvg: lg };
}

export const headshot = (L, id) => {
  const [, league] = split(L);
  const path = { "mens-college-basketball": "mens-college-basketball", "college-football": "college-football" }[league] || league;
  return `https://a.espncdn.com/i/headshots/${path}/players/full/${id}.png`;
};
