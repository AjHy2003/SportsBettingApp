// Check my slip: read bets typed (or pasted) the way a sportsbook shows them, find the
// player or game in today's scan, and price each one at that book's exact line and odds.
// No DOM.
import * as M from "./model.js";
import { priceSide, priceGameSide } from "./reprice.js";
import { fmtSpread } from "./gamemodel.js";

// Lowercase, no accents or name punctuation ("T. Jones", "Jr."), but keep decimals (4.5).
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[−–]/g, "-")
  .replace(/[’'`]/g, "").replace(/\./g, (m, i, str) => (/\d/.test(str[i - 1] || "") && /\d/.test(str[i + 1] || "") ? "." : " "))
  .replace(/\b(jr|sr|ii|iii|iv)\b/g, " ").replace(/[^a-z0-9+\-./ ]/g, " ").replace(/\s+/g, " ").trim();

// Stat words per sport -> market keys (combos are worked out from the set).
const WORDS = {
  basketball: [[/\bpra\b|p ?\+ ?r ?\+ ?a/, ["pts", "reb", "ast"]], [/\bp ?\+ ?r\b|\bpr\b/, ["pts", "reb"]], [/\bp ?\+ ?a\b|\bpa\b/, ["pts", "ast"]], [/\br ?\+ ?a\b|\bra\b/, ["reb", "ast"]],
    [/\bstocks\b/, ["stl", "blk"]], [/\b(3s|3pm|3pt|threes?|three pointers?|3 pointers?|3-pointers?|made threes?)\b/, ["fg3m"]],
    [/\b(points?|pts)\b/, ["pts"]], [/\b(rebounds?|rebs?|boards?)\b/, ["reb"]], [/\b(assists?|asts?|dimes?)\b/, ["ast"]],
    [/\b(steals?|stl)\b/, ["stl"]], [/\b(blocks?|blks?)\b/, ["blk"]], [/\b(turnovers?|tov)\b/, ["tov"]]],
  hockey: [[/\b(shots on goal|sog|shots)\b/, ["sog"]], [/\b(goals?)\b/, ["g"]], [/\b(assists?)\b/, ["a"]], [/\b(points?|pts)\b/, ["pts"]], [/\b(saves?)\b/, ["saves"]], [/\b(blocked shots?|blocks?)\b/, ["blk"]], [/\bhits\b/, ["hits"]]],
  football: [[/pass(ing)? ?\+ ?rush(ing)?/, ["pass_rush_yds"]], [/rush(ing)? ?\+ ?rec(eiving)?/, ["rush_rec_yds"]], [/pass(ing)? (yds|yards)/, ["pass_yds"]], [/rush(ing)? (yds|yards)/, ["rush_yds"]],
    [/rec(eiving)? (yds|yards)/, ["rec_yds"]], [/\b(receptions?|catches|recs?)\b/, ["rec"]], [/\b(completions?|cmp)\b/, ["pass_cmp"]], [/pass(ing)? (attempts|att)/, ["pass_att"]],
    [/\b(carries|rush(ing)? (attempts|att))\b/, ["rush_att"]], [/pass(ing)? (tds?|touchdowns?)/, ["pass_td"]], [/\b(interceptions?|ints?)\b/, ["pass_int"]]],
};
// Keys sorted alphabetically, as marketOf joins them.
const COMBO = { "ast+pts+reb": "pra", "pts+reb": "pr", "ast+pts": "pa", "ast+reb": "ra", "blk+stl": "sb" };
const FAMILY = { nba: "basketball", wnba: "basketball", ncaab: "basketball", ncaaw: "basketball", nhl: "hockey", nfl: "football", ncaaf: "football" };

function marketOf(text, family) {
  const found = new Set();
  let t = text;
  for (const [re, keys] of WORDS[family] || []) {
    if (re.test(t)) { keys.forEach((k) => found.add(k)); t = t.replace(re, " "); }
  }
  if (!found.size) return null;
  if (found.size === 1) return [...found][0];
  return COMBO[[...found].sort().join("+")] || null;
}

// Odds: a signed 3-5 digit number (or "even"); line: the remaining number; "30+" is an alt line.
function numbers(text) {
  let t = text.replace(/[−–]/g, "-");
  let odds = null;
  const om = t.match(/(?:^|[\s(])([+-]\d{3,5})(?=$|[\s)])/);
  if (om) { odds = Number(om[1]); t = t.replace(om[1], " "); }
  else if (/\b(even|evens|ev)\b/.test(t)) { odds = 100; t = t.replace(/\b(even|evens|ev)\b/, " "); }
  const alt = t.match(/(\d+(\.\d+)?)\s*\+(?!\s*\d)/);
  const side = /\b(over|o)\b|\bo(?=\d)/.test(t) ? "OVER" : /\b(under|u)\b|\bu(?=\d)/.test(t) ? "UNDER" : null;
  const lm = t.match(/(?:^|[\s(ou])([+-]?\d+(\.\d+)?)(?=$|[\s)])/);
  return { odds, alt: alt ? Number(alt[1]) : null, side, line: lm ? Number(lm[1]) : null, rest: t };
}

// Index today's file: players with prop markets, teams with games.
export function slipIndex(today) {
  const players = new Map(), teams = [];
  const now = Date.now();
  for (const l of today?.legs || []) {
    if (l.kind !== "prop" || !l.player || new Date(l.start) <= now) continue;
    const key = norm(l.player);
    if (!players.has(key)) players.set(key, { name: l.player, legs: [] });
    players.get(key).legs.push(l);
  }
  for (const g of today?.games || []) {
    if (new Date(g.start) <= now) continue;
    for (const [side, t] of [["home", g.home], ["away", g.away]]) {
      const full = norm(t.name), nick = full.split(" ").slice(-1)[0];
      teams.push({ g, side, abbr: norm(t.abbr), full, nick, school: full.split(" ").slice(0, -1).join(" ") });
    }
  }
  return { players, teams, games: today?.games || [], legs: today?.legs || [] };
}

function findPlayer(t, idx) {
  let best = null;
  for (const [key, p] of idx.players) if (t.includes(key) && (!best || key.length > best.key.length)) best = { key, p };
  if (best) return { ...best, text: t.replace(best.key, " ") };
  // Last name (plus first initial when given, e.g. "t jones" or "t. jones").
  const words = t.split(" ");
  const hits = [];
  for (const [key, p] of idx.players) {
    const parts = key.split(" "), last = parts[parts.length - 1];
    if (last.length < 4 || !words.includes(last)) continue;
    const i = words.indexOf(last), before = words[i - 1];
    const initialOk = !before || before.length > 1 || before[0] === parts[0][0];
    if (initialOk) hits.push({ key: last, p, strong: before?.length === 1 && before[0] === parts[0][0] });
  }
  const strong = hits.filter((h) => h.strong);
  const pick = strong.length === 1 ? strong[0] : hits.length === 1 ? hits[0] : null;
  if (pick) return { ...pick, text: t.replace(new RegExp(`\\b(${pick.p.name.split(" ")[0][0].toLowerCase()} )?${pick.key}\\b`), " ") };
  if (hits.length > 1) return { ambiguous: hits.map((h) => h.p.name) };
  // A distinctive first name on its own ("lebron", "giannis").
  const firsts = [];
  for (const [key, p] of idx.players) { const first = key.split(" ")[0]; if (first.length >= 5 && words.includes(first)) firsts.push({ key: first, p }); }
  return firsts.length === 1 ? { ...firsts[0], text: t.replace(new RegExp(`\\b${firsts[0].key}\\b`), " ") } : null;
}

// Teams named in the text, strongest match first (full name > abbreviation > school > nickname).
const PRO = new Set(["nba", "nfl", "nhl", "wnba"]);
function findTeams(t, idx) {
  const out = [];
  for (const tm of idx.teams) {
    const re = (x) => x && new RegExp(`(^|\\s)${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(t);
    const score = re(tm.full) ? 4 : re(tm.abbr) && tm.abbr.length >= 2 ? 3 : tm.school.length > 3 && re(tm.school) ? 2 : re(tm.nick) ? 1 : 0;
    if (score) out.push({ ...tm, score });
  }
  return out;
}
// The game the text means: the one with the most named teams, then the strongest match,
// then pro over college (a bare "Rockets" is Houston, not Toledo), then the soonest.
function pickGame(tms) {
  const by = new Map();
  for (const tm of tms) {
    const x = by.get(tm.g.key) || { g: tm.g, n: 0, score: 0, teams: new Set() };
    x.n++; x.score = Math.max(x.score, tm.score); x.teams.add(tm.full); by.set(tm.g.key, x);
  }
  const ranked = [...by.values()].sort((a, b) => b.n - a.n || b.score - a.score || (PRO.has(b.g.league) - PRO.has(a.g.league)) || new Date(a.g.start) - new Date(b.g.start));
  const top = ranked[0], next = ranked[1];
  // Same team in two upcoming games means the next one; different teams tied is ambiguous.
  const tie = next && next.n === top.n && next.score === top.score && PRO.has(next.g.league) === PRO.has(top.g.league) && [...next.teams].some((x) => !top.teams.has(x));
  return { g: top.g, alsoMeant: tie ? next.g : null };
}

// One slip line -> a checked leg.
export function checkLine(raw, idx) {
  const t = norm(raw);
  if (!t) return null;
  const base = { raw: raw.trim() };
  const pl = findPlayer(t, idx);
  if (pl?.ambiguous) return { ...base, status: "unknown", why: `More than one player matches: ${pl.ambiguous.slice(0, 3).join(", ")}. Add the first name.` };
  if (pl) {
    const fam = FAMILY[pl.p.legs[0].league];
    const n = numbers(pl.text);
    const key = marketOf(n.rest, fam);
    if (!key) return { ...base, status: "unknown", why: `Found ${pl.p.name}, but not which stat (points, rebounds, assists, PRA...).` };
    const leg = pl.p.legs.find((l) => l.marketKey === key);
    if (!leg) return { ...base, status: "unknown", why: `${pl.p.name} has no ${key.toUpperCase()} line in today's scan.` };
    const side = n.alt != null ? "OVER" : n.side;
    const line = n.alt != null ? n.alt - 0.5 : n.line;
    if (!side || line == null) return { ...base, status: "unknown", why: `Found ${leg.player} ${leg.market}; add over/under and the line (e.g. "under 4.5").` };
    const r = priceSide(leg, side, line, n.odds);
    if (!r) return { ...base, status: "unknown", why: "No model read for this one." };
    const label = n.alt != null ? `${leg.player} ${n.alt}+ ${leg.market}` : `${leg.player} ${side === "OVER" ? "Over" : "Under"} ${line} ${leg.market}`;
    return { ...base, ...r, kind: "prop", label, leg, assumedOdds: n.odds == null, dk: leg.book, appPick: leg.lean && leg.grade !== "PASS" ? leg : null,
      pick: { league: leg.league, athleteId: leg.playerId, athlete: leg.player, market: leg.marketKey, marketLabel: leg.market, line, side, odds: r.odds, eventId: leg.eventId, eventDate: leg.start, opp: leg.matchup, label } };
  }
  // Game lines.
  const tms = findTeams(t, idx);
  if (!tms.length) return { ...base, status: "unknown", why: "Couldn't find that player or team in today's scan (it covers NBA, NHL, college basketball, and NFL and college football games)." };
  const { g, alsoMeant } = pickGame(tms);
  if (alsoMeant) return { ...base, status: "unknown", why: `That could be ${g.matchup} or ${alsoMeant.matchup}. Use the full team name.` };
  const n = numbers(t.replace(/\b(ml|moneyline|money line|to win)\b/g, " "));
  const kind = /\b(ml|moneyline|money line|to win)\b/.test(t) ? "ml" : n.side ? "total" : "spread";
  const tm = tms.filter((x) => x.g.key === g.key).sort((a, b) => b.score - a.score)[0];
  const i = kind === "total" ? (n.side === "UNDER" ? 1 : 0) : tm.side === "home" ? 0 : 1;
  const line = kind === "ml" ? null : kind === "spread" ? (/\b(pk|pick|pickem)\b/.test(t) ? 0 : n.line) : n.line;
  if (kind !== "ml" && line == null) return { ...base, status: "unknown", why: `Found ${g.matchup}; add the ${kind === "total" ? "total (e.g. over 221.5)" : "spread (e.g. -3.5)"}.` };
  const legOf = (side) => idx.legs.find((l) => l.gameKey === g.key && l.kind === kind && l.id.endsWith(`:${kind}:${side}`));
  const ref = legOf(i ? "B" : "A");
  const r = priceGameSide(g, kind, i, line, n.odds, ref?.k);
  if (!r || r.far) return { ...base, status: "unknown", why: `That number is too far from the posted line for a reliable read (${g.matchup}).` };
  const team = i ? g.away.abbr : g.home.abbr;
  const label = kind === "ml" ? `${team} ML` : kind === "spread" ? `${team} ${fmtSpread(line)}` : `${i ? "Under" : "Over"} ${line} (${g.matchup})`;
  const app = idx.legs.find((l) => l.gameKey === g.key && l.kind === kind && l.lean && l.grade !== "PASS");
  const side = kind === "total" ? (i ? "UNDER" : "OVER") : i ? "AWAY" : "HOME";
  return { ...base, ...r, kind, side, lean: r.sameSide ? side : "other", label, leg: ref, assumedOdds: n.odds == null, appPick: app || null, game: g,
    pick: { league: g.league, eventId: g.eventId, eventDate: g.start, athlete: g.matchup, marketLabel: kind === "ml" ? "Moneyline" : kind === "spread" ? "Spread" : "Total", market: kind, game: true,
      homeAbbr: g.home.abbr, awayAbbr: g.away.abbr, side: kind === "total" ? `${i ? "Under" : "Over"} ${line}` : label, line: kind === "spread" ? (i ? -line : line) : line, odds: r.odds, label } };
}

// Verdict for a checked leg.
export function verdictOf(c) {
  if (c.status === "unknown") return { tag: "unknown", icon: "❓", text: c.why };
  const fair = M.toAmerican(c.prob);
  if (c.lean && c.lean !== c.side && c.lean !== "same" && c.grade === "PASS") return { tag: "other", icon: "🔁", text: `The model likes the other side here. This side: ${Math.round(c.prob * 100)}% vs ${Math.round(M.impliedProb(c.odds) * 100)}% needed.` };
  if (c.prob < 0.2) return { tag: "long", icon: "🎰", text: `Long shot: about 1 in ${Math.round(1 / Math.max(c.prob, 0.001))}${c.edge > 0 ? ", priced a little better than that" : `, and the price needs 1 in ${Math.round(1 / M.impliedProb(c.odds))}`}.` };
  if (c.grade === "A" || c.grade === "B") return { tag: "keep", icon: c.grade === "A" && c.edge >= 0.1 ? "⭐" : "✅", text: `Keep: ${Math.round(c.prob * 100)}% to hit vs ${Math.round(M.impliedProb(c.odds) * 100)}% the price needs (grade ${c.grade}).` };
  if (c.grade === "C") return { tag: "thin", icon: "⚠️", text: `Thin edge: ${Math.round(c.prob * 100)}% vs ${Math.round(M.impliedProb(c.odds) * 100)}% needed (grade C). Fine straight, risky in a parlay.` };
  return { tag: "drop", icon: "❌", text: `No edge at this price: ${Math.round(c.prob * 100)}% vs ${Math.round(M.impliedProb(c.odds) * 100)}% needed. Fair price would be about ${M.fmtOdds(fair)}.` };
}
