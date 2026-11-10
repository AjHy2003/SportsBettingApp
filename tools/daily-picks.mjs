// Daily picks generator. Runs in GitHub Actions after the data pipeline:
//   node tools/daily-picks.mjs --site _site --history picks-data/history.json
// Scans today's NBA / college basketball / NHL games and this week's NFL / college
// football games: every DraftKings game line and player prop goes through the
// same model the site uses. Writes:
//   <site>/data/picks/today.json    all evaluated legs, top picks, record
//   <site>/data/picks/history.json  graded track record
//   notify.json                     title/body for the phone notification
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const SITE = args.site || "_site";
const HISTORY = args.history || "picks-data/history.json";
const SITE_URL = args.url || "https://ajhy2003.github.io/SportsBettingApp/";

// The site's modules fetch "data/..." relative to the page; serve those from the built site.
const netFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.fetch = async (url, opts) => {
  if (typeof url === "string" && url.startsWith("data/")) {
    const f = path.join(SITE, url.split("?")[0]);
    return fs.existsSync(f) ? new Response(fs.readFileSync(f), { status: 200 }) : new Response("", { status: 404 });
  }
  for (let i = 0; ; i++) {
    try {
      const r = await netFetch(url, opts);
      if (r.status >= 500 && i < 3) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      if (i >= 3) throw e;
      await sleep(800 * 2 ** i);
    }
  }
};

const { leagueById, MARKETS } = await import("../js/sports.js");
const { api, standingsTable, parseProps, parseMilestones, loadGamelogs, pool, scheduleResults } = await import("../js/espn.js");
const { impliedProb, fmtOdds, makeVerdict, expectedValue } = await import("../js/model.js");
const { loadDeep, loadDeepPlayer } = await import("../js/deep.js");
const { gameContext, defaultLines, evaluateLines, fmtSpread, guardLine } = await import("../js/gamemodel.js");
const { loadPeople, propRows, scanRows, mergeDeepStats } = await import("../js/scan.js");
const { injuryReport } = await import("../js/context.js");
const { gameWeather } = await import("../js/weather.js");
const { marketValue } = await import("../js/props.js");
const { bestParlay, bestSameGame, decimalOdds, choosePicks, usableLeg, edgeShrink, shrinkLeg, learnGroup, isBestBet } = await import("../js/parlay.js");
const { buildMoonshot, oneIn } = await import("../js/moonshot.js");
const { propMove, gameMove } = await import("../js/movement.js");
const { propLadder, gameLadder } = await import("../js/reprice.js");

// ---------- team betting records (against the spread, over/under) ----------
// ESPN's closing DraftKings line for a finished game, cached on disk forever.
const CLOSE_DIR = "cache/closing-odds";
async function closingLine(L, ev) {
  const f = path.join(CLOSE_DIR, `${L.id}-${ev}.json`);
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* not cached */ }
  const [sport, league] = L.espn.split("/");
  try {
    const r = await fetch(`https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${league}/events/${ev}/competitions/${ev}/odds`);
    if (!r.ok) return null;
    const items = (await r.json()).items || [];
    const it = items.find((x) => String(x.provider?.id) === "100") || items.find((x) => String(x.provider?.id) !== "200");
    const out = { spread: it?.spread ?? null, total: it?.overUnder ?? null };
    fs.mkdirSync(CLOSE_DIR, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(out));
    return out;
  } catch { return null; }
}

// This season's record against the closing spread and total.
async function teamRecord(L, team, sched) {
  if (!sched) return null;
  const games = scheduleResults(sched, team.id).filter((g) => String(g.seasonType) !== "1").slice(0, 25);
  if (!games.length) return null;
  const rows = [];
  await pool(games, 6, async (g) => {
    const c = await closingLine(L, g.eventId);
    if (!c || (c.spread == null && c.total == null)) return;
    const line = c.spread == null ? null : g.home ? c.spread : -c.spread; // this team's number
    const cover = line == null ? null : g.pf - g.pa + line;
    const tot = c.total == null ? null : g.pf + g.pa - c.total;
    rows.push({ date: g.date, ats: cover == null ? null : cover > 0 ? "W" : cover < 0 ? "L" : "P", ou: tot == null ? null : tot > 0 ? "O" : tot < 0 ? "U" : "P", home: g.home });
  });
  rows.sort((a, b) => new Date(b.date) - new Date(a.date));
  const count = (k, v, f = () => true) => rows.filter((r) => r[k] === v && f(r)).length;
  return {
    n: rows.length,
    ats: { w: count("ats", "W"), l: count("ats", "L"), p: count("ats", "P") },
    atsHome: { w: count("ats", "W", (r) => r.home), l: count("ats", "L", (r) => r.home) },
    atsAway: { w: count("ats", "W", (r) => !r.home), l: count("ats", "L", (r) => !r.home) },
    ou: { o: count("ou", "O"), u: count("ou", "U"), p: count("ou", "P") },
    atsLast5: rows.filter((r) => r.ats).slice(0, 5).map((r) => r.ats).join(""),
    ouLast5: rows.filter((r) => r.ou).slice(0, 5).map((r) => r.ou).join(""),
  };
}

// A big move against an A/B pick usually means news or sharp money the stats don't see.
function applyMove(leg, mv) {
  if (!mv) return;
  leg.move = mv;
  if (leg.lean && mv.against && mv.strong && ["A", "B"].includes(leg.grade)) { leg.grade = "C"; leg.moveCap = true; }
}
const { loadBooks, matchEvent, shop } = await import("./books.mjs");
const { leagueNews, isStory } = await import("../js/news.js");

const LEAGUES = [
  { id: "nba", window: "day", props: true },
  { id: "nfl", window: "week", props: true },
  { id: "ncaaf", window: "week", props: true, params: "groups=80&limit=300" },
  { id: "ncaab", window: "day", props: true, params: "groups=50&limit=400" },
  { id: "nhl", window: "day", props: true },
];
const now = new Date();
const etDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replaceAll("-", "");
const todayET = etDate(now);

async function upcomingEvents(cfg, L) {
  const p = cfg.params ? `${cfg.params}&` : "";
  const boards = cfg.window === "day"
    ? [await api.scoreboard(L, `${p}dates=${todayET}`)]
    : [await api.scoreboard(L, cfg.params || "")];
  const horizon = cfg.window === "day" ? 30 * 3600e3 : 4.5 * 864e5;
  const evs = boards.flatMap((b) => b.events || []).filter((e) => {
    const t = new Date(e.date);
    return e.status?.type?.state === "pre" && t > now && t - now < horizon;
  });
  // College slates are huge: only games with a posted line.
  return L.id.startsWith("ncaa") ? evs.filter((e) => e.competitions?.[0]?.odds?.length) : evs;
}

const pctTxt = (p) => `${Math.round(p * 100)}%`;

// Game-line legs for both sides of every market. With The Odds API (books.mjs),
// the model is blended with the all-book consensus instead of DraftKings alone,
// and each leg notes the best price available elsewhere.
function lineLegs(L, gc, game, bookEv) {
  const st = defaultLines(gc.odds);
  const { rows } = evaluateLines(gc, st);
  const legs = [];
  for (const r of rows) {
    if (!r.sides) continue;
    const kind = r.key;
    const sideName = (s) => (kind === "total" ? (s.side === "A" ? "OVER" : "UNDER") : s.side === "A" ? "HOME" : "AWAY");
    const point = (s) => (kind === "spread" ? (s.side === "A" ? st.spreadHome : -st.spreadHome) : kind === "total" ? st.total : null);
    const shopped = bookEv && r.sides.length === 2 ? r.sides.map((s) => shop(bookEv, kind, sideName(s), point(s))) : null;
    const cons = shopped?.[0]?.consensus ?? (shopped?.[1]?.consensus != null ? 1 - shopped[1].consensus : null);
    let v = r.v, probs = r.sides.map((s) => s.prob);
    if (cons != null && r.model != null) {
      const fin = gc.wModel * r.model + (1 - gc.wModel) * cons;
      const push = r.push || 0;
      const [oA, oB] = r.sides.map((s) => s.odds ?? -110);
      const a = fin * (1 - push), b = (1 - fin) * (1 - push);
      // Same sanity check as the site's, against the all-book consensus.
      v = guardLine(makeVerdict(a, b, push, oA, oB, expectedValue(a, push, oA), expectedValue(b, push, oB), gc.minGames, r.sides.map((s) => s.label)), r.model, cons, gc.lineCap);
      probs = [fin, 1 - fin];
    }
    r.sides.forEach((s, i) => {
      const odds = s.odds ?? -110;
      const prob = probs[i];
      const lean = v.lean === s.label;
      const sh = shopped?.[i];
      const leg = {
        id: `${L.id}:${game.eventId}:${kind}:${s.side}`, league: L.id, gameKey: game.key, eventId: game.eventId, start: game.start, matchup: game.matchup,
        kind, marketKey: kind, market: r.label, label: s.label, side: sideName(s),
        line: point(s),
        team: kind === "total" ? null : s.side === "A" ? game.home.abbr : game.away.abbr,
        odds, priced: s.odds != null, prob, edge: prob - impliedProb(odds), ev: prob * decimalOdds(odds) - 1,
        grade: lean ? v.grade : "PASS", lean, mismatch: lean && !!v.mismatch,
        why: cons != null ? `${r.info.replace(/ → blended .*/, "")} · ${Math.max(...shopped.map((x) => x?.books || 0))}-book consensus ${pctTxt(cons)} → blended ${pctTxt(probs[0])}` : r.info,
      };
      if (sh && s.odds != null && decimalOdds(sh.best.odds) > decimalOdds(odds) + 1e-9) {
        leg.bestBook = { title: sh.best.title, odds: sh.best.odds, ev: prob * decimalOdds(sh.best.odds) - 1 };
      }
      if (sh) {
        leg.books = sh.books;
        const links = Object.fromEntries(sh.prices.filter((p) => p.link).map((p) => [p.book, p.link]));
        if (Object.keys(links).length) leg.bookLinks = links;
      }
      applyMove(leg, gameMove(kind, leg.side, gc.odds, gc.odds.open));
      // DraftKings bet-slip link from ESPN's odds (adds this exact selection), else the game page.
      const dk = gc.odds.dk?.[kind]?.[s.side];
      leg.dk = dk || gc.odds.dk?.game || undefined;
      leg.dkExact = !!dk || undefined;
      legs.push(leg);
    });
  }
  return legs;
}

function propLeg(L, game, r) {
  const res = r.res;
  const side = res.verdict.lean;
  const push = res.pPush || 0;
  const prob = (side === "OVER" ? res.pOver : res.pUnder) / (1 - push || 1);
  const odds = (side === "OVER" ? r.p.over : r.p.under) ?? -110;
  const hits = side === "OVER" ? r.l10?.overs : r.l10?.unders;
  const why = [
    `Projection ${res.projection.toFixed(1)} vs line ${r.p.line}`,
    r.l10?.n ? `${side.toLowerCase()} in ${hits}/${r.l10.n} of last ${r.l10.n}` : "",
    r.opp?.factor && Math.abs(r.opp.factor - 1) > 0.02 ? `matchup ×${r.opp.factor.toFixed(2)}` : "",
    res.potential && Math.abs(res.potential.factor - 1) >= 0.02 ? `chances say ${res.potential.expected.toFixed(1)}/g vs ${res.potential.actual.toFixed(1)} actual (×${res.potential.factor.toFixed(2)})` : "",
    r.context?.withWithout?.notes[0] || "",
    r.context?.implied != null && Math.abs((r.context.factor || 1) / (r.context.withWithout?.factor || 1) / (r.context.weather?.factor || 1) - 1) > 0.02 ? `team total ${r.context.implied.toFixed(1)}` : "",
    r.context?.weather ? `weather: ${r.context.weather.why} ×${r.context.weather.factor.toFixed(2)}` : "",
  ].filter(Boolean).join(" · ");
  const leg = {
    id: `${L.id}:${game.eventId}:${r.aid}:${r.key}:${side}`, league: L.id, gameKey: game.key, eventId: game.eventId, start: game.start, matchup: game.matchup,
    kind: "prop", player: r.who.name, playerId: r.aid, team: r.who.team?.abbreviation, pos: r.who.pos,
    marketKey: r.key, market: r.m.label, line: r.p.line, side, label: `${r.who.name} ${side === "OVER" ? "Over" : "Under"} ${r.p.line} ${r.m.label}`,
    odds, priced: r.p.over != null && r.p.under != null, prob, edge: prob - impliedProb(odds), ev: prob * decimalOdds(odds) - 1,
    grade: res.verdict.grade, lean: true, proj: Number(res.projection.toFixed(2)), why,
    mismatch: !!res.verdict.mismatch,
    book: { line: r.p.line, over: r.p.over, under: r.p.under },
    questionable: r.context?.status?.maybe ? r.context.status.status : undefined,
    roleChange: res.verdict.roleChange,
    dk: game.dk || undefined,
    l10: r.l10?.n ? r.l10 : undefined,
    context: r.context?.notes?.length ? r.context.notes : undefined,
    rp: propLadder(res, r.p.line),
    pot: res.potential ? { exp: Number(res.potential.expected.toFixed(2)), act: Number(res.potential.actual.toFixed(2)), f: Number(res.potential.factor.toFixed(3)) } : undefined,
  };
  applyMove(leg, propMove(side, { line: r.p.line, over: r.p.over, under: r.p.under }, { line: r.p.open, over: r.p.openOver, under: r.p.openUnder }));
  return leg;
}

// Alt-line legs from DraftKings milestones ("30+ points" at a price): plus-money rungs
// where the model beats the price. Moonshot material, never top picks.
let altTooGood = 0;
function altLegs(L, game, r, ladder) {
  const res = r.res;
  if (!ladder?.length || !res?.probOver || res.verdict?.mismatch || res.verdict?.roleChange || r.context?.status?.maybe) return [];
  const out = [];
  for (const { at, odds } of ladder) {
    if (odds == null || odds < 100) continue;
    const p = res.probOver(at - 0.5)?.over;
    if (!(p >= 0.08)) continue;
    const edge = p - impliedProb(odds);
    if (edge <= 0) continue;
    // A rung the model makes more than twice as likely as DraftKings' price, or 15+ points
    // likelier, is almost always bad data or news the model hasn't seen (Nov 2's moonshot
    // had "7+ assists" at +234 rated 54% and "40+ Pts + Reb + Ast" at +1140 rated 24%).
    if (p > 2 * impliedProb(odds) || edge > 0.15) { altTooGood++; continue; }
    out.push({
      id: `${L.id}:${game.eventId}:${r.aid}:${r.key}:alt${at}`, league: L.id, gameKey: game.key, eventId: game.eventId, start: game.start, matchup: game.matchup,
      kind: "prop", alt: true, player: r.who.name, playerId: r.aid, team: r.who.team?.abbreviation, marketKey: r.key, market: r.m.label,
      line: at - 0.5, side: "OVER", label: `${r.who.name} ${at}+ ${r.m.label}`, odds, priced: true, prob: p, edge, ev: p * decimalOdds(odds) - 1,
      grade: "ALT", lean: true, proj: Number(res.projection.toFixed(2)), why: `Projection ${res.projection.toFixed(1)} · model ${pctTxt(p)} vs ${pctTxt(impliedProb(odds))} priced`, dk: game.dk || undefined,
    });
  }
  return out.sort((a, b) => b.edge - a.edge).slice(0, 2);
}

let failedLeagues = 0;
// All-book prices (optional ODDS_API_KEY secret; refreshed once a day, cached otherwise).
const BOOKS = await loadBooks({ key: process.env.ODDS_API_KEY, cacheFile: "cache/oddsapi.json", refresh: process.env.ODDS_API_REFRESH === "1", leagues: LEAGUES.map((c) => c.id) }).catch((e) => { console.log(`odds api: ${e.message}`); return null; });
console.log(BOOKS ? `odds api: ${Object.values(BOOKS.events).reduce((s, x) => s + x.length, 0)} events from ${BOOKS.fetchedAt}` : "odds api: off (no ODDS_API_KEY), using DraftKings only");

async function scanLeague(cfg) {
  const L = leagueById(cfg.id);
  let events = [];
  try { events = await upcomingEvents(cfg, L); } catch (e) { console.log(`${cfg.id}: scoreboard failed ${e.message}`); failedLeagues++; return { games: [], legs: [], alts: [] }; }
  console.log(`${cfg.id}: ${events.length} upcoming games`);
  if (!events.length) return { games: [], legs: [], alts: [] };
  const [standings, deep] = await Promise.all([
    api.standings(L).then(standingsTable).catch(() => null),
    loadDeep(L).catch(() => null),
  ]);
  const games = [], legs = [], alts = [];
  await pool(events, 3, async (e) => {
    try {
      const sum = await api.summary(L, e.id);
      const comp = sum.header.competitions[0];
      const h = comp.competitors.find((c) => c.homeAway === "home"), a = comp.competitors.find((c) => c.homeAway === "away");
      const [schedH, schedA, weather] = await Promise.all([
        api.schedule(L, h.team.id).catch(() => null), api.schedule(L, a.team.id).catch(() => null),
        gameWeather(L, sum, { indoor: e.competitions?.[0]?.venue?.indoor ?? null }).catch(() => null),
      ]);
      const gc = gameContext(L, sum, standings, schedH, schedA, weather);
      const [recH, recA] = await Promise.all([teamRecord(L, h.team, schedH).catch(() => null), teamRecord(L, a.team, schedA).catch(() => null)]);
      const game = {
        key: `${L.id}:${e.id}`, league: L.id, eventId: e.id, start: comp.date, matchup: `${a.team.abbreviation} @ ${h.team.abbreviation}`,
        home: { id: h.team.id, abbr: h.team.abbreviation, name: h.team.displayName, logo: h.team.logos?.[0]?.href },
        away: { id: a.team.id, abbr: a.team.abbreviation, name: a.team.displayName, logo: a.team.logos?.[0]?.href },
        lines: { details: gc.odds.details, spreadHome: gc.odds.spreadHome, total: gc.odds.total, mlHome: gc.odds.mlHome, mlAway: gc.odds.mlAway },
        weather: weather || undefined,
        dk: gc.odds.dk?.game || undefined,
        open: gc.odds.open || undefined,
        records: recH || recA ? { home: recH, away: recA } : undefined,
      };
      const gameLegs = lineLegs(L, gc, game, matchEvent(BOOKS, L.id, game));
      // Model chances at nearby lines, so the Today page can re-price when DraftKings moves.
      const st0 = defaultLines(gc.odds);
      game.rep = gameLadder(gc, st0, (sp, tot) => evaluateLines(gc, { ...st0, spreadHome: sp, total: tot }).rows);
      if (cfg.props) {
        const items = await api.propBets(L, e.id).catch(() => null);
        const props = items ? parseProps(items, L.markets) : null;
        const miles = items ? parseMilestones(items, L.markets) : null;
        if (props?.size) {
          const people = await loadPeople(L, [gc.H, gc.A]);
          const rows = propRows(L, props, people);
          await scanRows(L, rows, { game: { H: gc.H, A: gc.A, date: comp.date, lines: { spreadHome: gc.odds.spreadHome, total: gc.odds.total }, report: injuryReport(sum), weather }, standings, deep, concurrency: 4 });
          game.out = rows.filter((r) => r.out).map((r) => `${r.who.name} (${r.out})`).filter((x, i, a) => a.indexOf(x) === i);
          for (const r of rows) if (r.res?.verdict?.lean) gameLegs.push(propLeg(L, game, r));
          if (miles?.size) for (const r of rows) alts.push(...altLegs(L, game, r, miles.get(r.aid)?.[r.key]));
        }
      }
      game.nLegs = gameLegs.length;
      games.push(game);
      legs.push(...gameLegs);
    } catch (err) {
      console.log(`  ${cfg.id} ${e.id} failed: ${err.message}`);
    }
  });
  console.log(`${cfg.id}: ${games.length} games, ${legs.length} legs, ${alts.length} alt-line legs (${altTooGood} too-good-to-be-true rungs dropped so far)`);
  return { games, legs, alts };
}

// ---------- track record ----------
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY, "utf8")); } catch { return { picks: [] }; }
}

// Every graded leg the app shows (tickets, same-game parlays, top picks) and the featured
// moonshots' long shots, recorded the first time they appear and graded like posted picks,
// so the record and the learning cover everything, not just the top-15 list.
const TRACKED = path.join(path.dirname(HISTORY), "tracked.json");
function loadTracked() {
  try { return JSON.parse(fs.readFileSync(TRACKED, "utf8")); } catch { return { picks: [] }; }
}
const trackRow = (l, src, issued) => ({ id: l.id, src, issued, start: l.start, league: l.league, eventId: l.eventId, kind: l.kind, marketKey: l.marketKey, playerId: l.playerId,
  side: l.side, line: l.line, odds: l.odds, prob: Number(l.prob.toFixed(4)), praw: l.praw != null ? Number(l.praw.toFixed(4)) : undefined, grade: l.grade, label: l.label, mkv: 2, result: null });
function trackedSummary(t) {
  const done = t.picks.filter((p) => p.result === "W" || p.result === "L");
  const agg = (rows) => ({ w: rows.filter((p) => p.result === "W").length, l: rows.filter((p) => p.result === "L").length,
    units: Number(rows.reduce((u, p) => u + (p.result === "W" ? decimalOdds(p.odds ?? -110) - 1 : -1), 0).toFixed(2)) });
  const legs = done.filter((p) => p.src === "leg");
  const byLeague = {};
  for (const lg of [...new Set(legs.map((p) => p.league))]) byLeague[lg] = Object.fromEntries(["A", "B", "C"].map((g) => [g, agg(legs.filter((p) => p.league === lg && p.grade === g))]));
  return { since: t.picks.reduce((m, p) => (!m || p.issued < m ? p.issued : m), null), byGrade: Object.fromEntries(["A", "B", "C"].map((g) => [g, agg(legs.filter((p) => p.grade === g))])), byLeague, alt: agg(done.filter((p) => p.src === "alt")) };
}

async function gradePending(history) {
  const pending = history.picks.filter((p) => !p.result && new Date(p.start) < new Date(now - 4 * 3600e3));
  let graded = 0;
  await pool(pending, 4, async (p) => {
    const L = leagueById(p.league);
    try {
      if (p.kind === "prop") {
        const log = await loadGamelogs(L, p.playerId, L.markets, 1);
        const g = log.games.find((x) => String(x.eventId) === String(p.eventId));
        if (!g) {
          // Gave up after 3 days: player didn't play (book would void it).
          if (now - new Date(p.start) > 3 * 864e5) { p.result = "VOID"; graded++; }
          return;
        }
        const m = (MARKETS[L.markets] || []).find((x) => x.key === p.marketKey);
        let v = m ? marketValue(m, g) : null;
        // Stats ESPN's game logs leave out (NHL blocked shots, hits) come from the box
        // scores the data pipeline collects, the same place the model read them from.
        if (v == null && m) {
          mergeDeepStats(L, [g], await loadDeepPlayer(L, p.playerId).catch(() => null));
          v = marketValue(m, g);
        }
        if (v == null) {
          if (now - new Date(p.start) > 3 * 864e5) { p.result = "VOID"; p.voided = "no stat to grade it"; graded++; }
          return;
        }
        p.actual = v;
        p.result = v === p.line ? "P" : (v > p.line) === (p.side === "OVER") ? "W" : "L";
      } else {
        const s = await api.summary(L, p.eventId);
        const c = s.header?.competitions?.[0];
        if (!c?.status?.type?.completed) return;
        const h = Number(c.competitors.find((x) => x.homeAway === "home").score);
        const a = Number(c.competitors.find((x) => x.homeAway === "away").score);
        p.actual = `${a}-${h}`;
        if (p.kind === "total") {
          const t = h + a;
          p.result = t === p.line ? "P" : (t > p.line) === (p.side === "OVER") ? "W" : "L";
        } else if (p.kind === "spread") {
          const margin = p.side === "HOME" ? h - a : a - h;
          const adj = margin + p.line;
          p.result = adj === 0 ? "P" : adj > 0 ? "W" : "L";
        } else if (p.kind === "ml") {
          p.result = h === a ? "P" : (h > a) === (p.side === "HOME") ? "W" : "L";
        }
      }
      if (p.result) graded++;
    } catch (e) {
      console.log(`  grade ${p.id}: ${e.message}`);
    }
  });
  return graded;
}

// ---------- closing line value ----------
// Latest pre-game price for each posted pick: "did the market move toward us?"
function snapshotLines(history, legs) {
  const props = new Map(), lines = new Map();
  for (const l of legs) {
    if (l.kind === "prop") props.set(`${l.league}:${l.eventId}:${l.playerId}:${l.marketKey}`, l.book);
    else lines.set(l.id, { line: l.line, odds: l.odds });
  }
  let n = 0;
  for (const p of history.picks) {
    if (p.result || new Date(p.start) <= now) continue;
    let snap = null;
    if (p.kind === "prop") {
      const b = props.get(`${p.league}:${p.eventId}:${p.playerId}:${p.marketKey}`);
      if (b) snap = { line: b.line, odds: (p.side === "OVER" ? b.over : b.under) ?? null };
    } else {
      snap = lines.get(p.id) || null;
    }
    if (snap && snap.line != null || snap?.odds != null) { p.close = { ...snap, at: new Date().toISOString() }; n++; }
  }
  return n;
}

// Positive = we got a better number than the last pre-game line.
function clvOf(p) {
  if (!p.close) return null;
  let pts = 0;
  if (p.kind === "spread") pts = p.line - p.close.line;
  else if (p.kind !== "ml" && p.close.line != null) pts = p.side === "OVER" ? p.close.line - p.line : p.line - p.close.line;
  const prob = p.close.odds != null && p.odds != null && (p.kind === "ml" || p.close.line === p.line) ? impliedProb(p.close.odds) - impliedProb(p.odds) : 0;
  return { pts: Math.round(pts * 10) / 10, prob: Math.round(prob * 1000) / 1000 };
}

function clvSummary(history) {
  const rows = history.picks.map((p) => ({ p, c: clvOf(p) })).filter((x) => x.c && (x.c.pts !== 0 || Math.abs(x.c.prob) >= 0.005));
  const beat = rows.filter((x) => x.c.pts > 0 || (x.c.pts === 0 && x.c.prob > 0)).length;
  return { moved: rows.length, beat, rate: rows.length ? beat / rows.length : null, tracked: history.picks.filter((p) => p.close).length };
}

// Does "60%" actually hit 60%?
function calibration(history) {
  const graded = history.picks.filter((p) => ["W", "L"].includes(p.result));
  const buckets = [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 1.01]];
  return buckets.map(([lo, hi]) => {
    const r = graded.filter((p) => p.prob >= lo && p.prob < hi);
    return { lo, hi: Math.min(hi, 1), n: r.length, predicted: r.length ? r.reduce((s, p) => s + p.prob, 0) / r.length : null, actual: r.length ? r.filter((p) => p.result === "W").length / r.length : null };
  });
}

function record(history, days = null) {
  const since = days ? now - days * 864e5 : 0;
  const rows = history.picks.filter((p) => ["W", "L"].includes(p.result) && new Date(p.start) >= since);
  const units = rows.reduce((u, p) => u + (p.result === "W" ? decimalOdds(p.odds) - 1 : -1), 0);
  const byGrade = {};
  for (const g of ["A", "B", "C"]) {
    const r = rows.filter((p) => p.grade === g);
    byGrade[g] = { w: r.filter((p) => p.result === "W").length, l: r.filter((p) => p.result === "L").length, units: r.reduce((u, p) => u + (p.result === "W" ? decimalOdds(p.odds) - 1 : -1), 0) };
  }
  return { w: rows.filter((p) => p.result === "W").length, l: rows.filter((p) => p.result === "L").length, units, byGrade };
}

// ---------- main ----------
const results = [];
for (const cfg of LEAGUES) results.push(await scanLeague(cfg));
const games = results.flatMap((r) => r.games).sort((a, b) => new Date(a.start) - new Date(b.start));
const legs = results.flatMap((r) => r.legs);
const alts = results.flatMap((r) => r.alts || []);

// News: the latest ESPN story or video about each pick's player (props) or either
// team (game lines), and the top stories for the notification.
const news = new Map(await Promise.all(LEAGUES.map(async (c) => [c.id, await leagueNews(leagueById(c.id), { limit: 50 }).catch(() => [])])));
const gameTeams = new Map(games.map((g) => [g.key, [String(g.home.id), String(g.away.id)]]));
const within = (a, h) => a.published && now - new Date(a.published) < h * 3600e3;
// Only stories actually about the player (few players tagged, or named in the
// headline/summary), stories before videos; for game lines, only stories about these teams.
const lastName = (n) => String(n || "").replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, "").split(" ").pop().toLowerCase();
for (const l of legs) {
  const list = (news.get(l.league) || []).filter((a) => a.url && (isStory(a) || a.kind === "video"));
  let hit = null;
  if (l.kind === "prop") {
    const ln = lastName(l.player);
    const about = list.filter((a) => within(a, 72) && a.athletes.includes(String(l.playerId)) &&
      (a.athletes.length <= 3 || `${a.headline} ${a.description}`.toLowerCase().includes(ln)));
    hit = about.find(isStory) || about[0];
  } else {
    const teams = gameTeams.get(l.gameKey) || [];
    hit = list.find((a) => within(a, 36) && isStory(a) && a.teams.length && a.teams.every((t) => teams.includes(t)));
  }
  if (hit) l.news = { headline: hit.headline, url: hit.url, published: hit.published, video: hit.kind === "video" || undefined };
}
const topStories = ["nba", "nfl", "ncaaf", "ncaab"].flatMap((id) => (news.get(id) || []).filter((a) => isStory(a) && within(a, 24)).slice(0, 3).map((a) => ({ league: id, headline: a.headline, url: a.url, published: a.published })));
console.log(`news: ${[...news.values()].reduce((s, x) => s + x.length, 0)} articles, ${legs.filter((l) => l.news).length} legs with a related story`);

const history = loadHistory();
const graded = await gradePending(history);
for (const p of history.picks) if (p.result && p.close && !p.clv) p.clv = clvOf(p);
const tracked = loadTracked();
// Until Nov 2, DraftKings' "Total Assists and Rebounds" was read as Assists, so basketball
// assists picks may have been on the wrong bet: void them (out of the record and the
// learning). Picks made after the fix carry mkv: 2.
for (const p of [...history.picks, ...tracked.picks]) {
  if (p.marketKey === "ast" && !p.mkv && ["nba", "ncaab", "wnba", "ncaaw"].includes(p.league) && p.result !== "VOID") { p.result = "VOID"; p.voided = "market mix-up: Assists vs Assists + Rebounds"; }
}
const trackedGraded = await gradePending(tracked);

// Learn from results: keep only the share of each league's claimed edge that has shown
// up in graded picks (posted picks plus every other graded leg the app showed), and
// re-grade (never up). The live re-check applies the same k.
const inHistory = new Set(history.picks.map((p) => p.id));
const learn = edgeShrink([...history.picks, ...tracked.picks.filter((p) => p.src === "leg" && !inHistory.has(p.id))]);
const kOf = (l, side) => learn[learnGroup({ ...l, side })]?.k;
for (const l of [...legs, ...alts]) {
  // Props carry both sides' k for the live re-check (a pick can switch sides there).
  if (l.kind === "prop") {
    const ko = kOf(l, "OVER"), ku = kOf(l, "UNDER");
    if (ko < 0.999 || ku < 0.999) l.ks = { OVER: Number((ko ?? 1).toFixed(4)), UNDER: Number((ku ?? 1).toFixed(4)) };
  }
  const k = kOf(l, l.side);
  if (!(k < 0.999)) continue;
  const s = shrinkLeg(l.prob, l.odds, l.grade, k);
  l.praw = l.prob; l.k = Number(k.toFixed(4));
  l.prob = s.prob; l.edge = s.prob - impliedProb(l.odds ?? -110); l.ev = s.prob * decimalOdds(l.odds ?? -110) - 1; l.grade = s.grade;
}
console.log(`learning: ${Object.entries(learn).map(([g, x]) => `${g} ${x.w}-${x.n - x.w} (${x.ne.toFixed(0)} player-games) k=${x.k.toFixed(2)}`).join(", ") || "no graded picks yet"}`);

const picks = choosePicks(legs);
const snapshots = snapshotLines(history, legs);
const known = new Set(history.picks.map((p) => p.id));
const issued = new Date().toISOString();
// One open pick per player per game: a later scan's second market on the same player
// (Under 21.5 PRA, then Under 19.5 P+R) just doubles the same bet.
const openPlayer = new Set(history.picks.filter((p) => !p.result && p.playerId).map((p) => `${p.eventId}:${p.playerId}`));
for (const p of picks) {
  if (known.has(p.id)) continue;
  if (p.playerId && openPlayer.has(`${p.eventId}:${p.playerId}`)) continue;
  if (p.playerId) openPlayer.add(`${p.eventId}:${p.playerId}`);
  history.picks.push({ id: p.id, issued, start: p.start, league: p.league, eventId: p.eventId, matchup: p.matchup, kind: p.kind, marketKey: p.marketKey, market: p.market,
    playerId: p.playerId, player: p.player, team: p.team, side: p.side, line: p.line, odds: p.odds, prob: Number(p.prob.toFixed(4)), praw: p.praw != null ? Number(p.praw.toFixed(4)) : undefined, edge: Number(p.edge.toFixed(4)), grade: p.grade, label: p.label, best: isBestBet(p) || undefined, mkv: 2, result: null });
}
history.picks = history.picks.filter((p) => now - new Date(p.start) < 400 * 864e5);
history.updated = issued;
fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
fs.writeFileSync(HISTORY, JSON.stringify(history));

const groups = { basketball: ["nba", "ncaab"], football: ["nfl", "ncaaf"], hockey: ["nhl"] };
// Featured parlays use today's games (Eastern time). Too few games with an edge for a
// regular parlay (a Thursday with one NFL game): the day's best same-game parlay. Only
// when neither works do they move to the next day.
const dayOf = (l) => etDate(new Date(l.start));
const weekdayOf = (l) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(l.start));
const upcomingDays = [...new Set(legs.filter((l) => new Date(l.start) > now).map(dayOf))].sort();
function parlayFor(ids, n) {
  for (const d of upcomingDays) {
    const all = legs.filter((l) => l.lean && ids.includes(l.league) && l.grade !== "PASS" && new Date(l.start) > now && dayOf(l) === d);
    // Grade A legs first (the grade that has been hitting); all graded legs if A can't fill it.
    const pool = bestParlay(all.filter((l) => l.grade === "A"), n) ? all.filter((l) => l.grade === "A") : all;
    const keys = [...new Set(pool.map((l) => l.gameKey))];
    const p = bestParlay(pool, n) || keys.map((k) => bestSameGame(pool, k, n)).filter((x) => x && x.ev > 0).sort((a, b) => b.ev - a.ev)[0];
    if (p) return { ...p, day: d, sgp: new Set(p.legs.map((l) => l.gameKey)).size === 1 || undefined };
  }
  return null;
}
const featured = {
  basketball: parlayFor(groups.basketball, 3),
  football: parlayFor(groups.football, 3),
  hockey: parlayFor(groups.hockey, 3),
  any: parlayFor(Object.values(groups).flat(), 3),
};
// Featured moonshots: $10 -> $10,000 with the best model chance, per sport.
// Today's games first; the rest of the week only if today can't get there.
const moonPool = (ids, day) => [...legs, ...alts].filter((l) => ids.includes(l.league) && new Date(l.start) > now && (!day || dayOf(l) === day) && l.prob > 0 && l.odds != null && usableLeg(l) && !l.mismatch && !l.roleChange && (l.edge ?? 0) > -0.01 && l.odds >= -250);
const moonshots = {};
for (const [k, ids] of Object.entries({ all: Object.values(groups).flat(), ...groups })) {
  let m = buildMoonshot(moonPool(ids, todayET), { stake: 10, target: 10000 }), later = false;
  if (!m?.reached) { m = buildMoonshot(moonPool(ids), { stake: 10, target: 10000 }); later = true; }
  if (m?.reached) moonshots[k] = { legs: m.legs.map((l) => l.id), american: m.american, decimal: Number(m.decimal.toFixed(2)), prob: m.prob, payout: Math.round(m.payout), ev: m.ev, later: later || undefined };
}
console.log(`moonshots: ${Object.entries(moonshots).map(([k, m]) => `${k} ${m.legs.length} legs 1 in ${oneIn(m.prob)}`).join(", ") || "none"}`);

// ---------- daily moonshot log ----------
// Each day's featured $10 -> $10,000 moonshots as they stood when their first game started
// (later scans can't change them after that), graded leg by leg like the picks.
const MOONS = path.join(path.dirname(HISTORY), "moonshots.json");
const moonLog = (() => { try { return JSON.parse(fs.readFileSync(MOONS, "utf8")); } catch { return { tickets: [] }; } })();
{
  const byId = new Map([...legs, ...alts].map((l) => [l.id, l]));
  const row = (l) => ({ id: l.id, league: l.league, eventId: l.eventId, start: l.start, matchup: l.matchup, kind: l.kind, marketKey: l.marketKey, playerId: l.playerId,
    side: l.side, line: l.line, odds: l.odds, prob: Number(l.prob.toFixed(4)), label: l.label, alt: l.alt || undefined, result: null });
  const stamp = new Date().toISOString();
  for (const [k, m] of Object.entries(moonshots)) {
    const id = `${todayET}:${k}`, prev = moonLog.tickets.find((t) => t.id === id);
    if (prev && prev.legs.some((l) => new Date(l.start) <= now)) continue; // its first game has started: locked
    const rows = m.legs.map((lid) => byId.get(lid)).filter(Boolean).map(row);
    if (rows.length !== m.legs.length) continue;
    const t = { id, day: todayET, kind: k, issued: prev?.issued || stamp, updated: stamp, stake: 10, american: m.american, decimal: m.decimal, payout: m.payout, prob: Number(m.prob.toFixed(6)), later: m.later, legs: rows, result: null };
    if (prev) Object.assign(prev, t); else moonLog.tickets.push(t);
  }
  // Grade every leg (so a lost ticket still shows how close it came), then the ticket: lost on
  // any losing leg; won when every leg is graded and none lost (pushes and voids drop out).
  const open = moonLog.tickets.filter((t) => t.legs.some((l) => !l.result));
  const n = await gradePending({ picks: open.flatMap((t) => t.legs) });
  for (const t of moonLog.tickets) {
    const r = t.legs.map((l) => l.result);
    if (r.includes("L")) t.result = "L";
    else if (r.every(Boolean)) {
      const won = t.legs.filter((l) => l.result === "W");
      t.result = won.length ? "W" : "VOID";
      t.paid = Number((t.stake * won.reduce((d, l) => d * decimalOdds(l.odds), 1)).toFixed(2));
    }
  }
  moonLog.tickets = moonLog.tickets.filter((t) => now - new Date(`${t.day}T12:00:00Z`) < 400 * 864e5);
  moonLog.updated = stamp;
  fs.mkdirSync(path.dirname(MOONS), { recursive: true });
  fs.writeFileSync(MOONS, JSON.stringify(moonLog));
  console.log(`moonshot log: ${moonLog.tickets.length} tickets, ${n} legs graded this run`);
}
// Daily moonshots so far (the "all sports" one, the one in the notification).
function moonRecord(log) {
  const ts = log.tickets.filter((t) => t.kind === "all");
  const done = ts.filter((t) => t.result === "W" || t.result === "L");
  const legsDone = ts.flatMap((t) => t.legs).filter((l) => l.result === "W" || l.result === "L");
  return { w: done.filter((t) => t.result === "W").length, l: done.filter((t) => t.result === "L").length, pending: ts.filter((t) => !t.result).length,
    staked: done.reduce((s, t) => s + t.stake, 0), returned: done.reduce((s, t) => s + (t.paid || 0), 0),
    legsW: legsDone.filter((l) => l.result === "W").length, legsL: legsDone.filter((l) => l.result === "L").length,
    closest: done.filter((t) => t.result === "L").reduce((m, t) => Math.min(m, t.legs.filter((l) => l.result === "L").length), Infinity) };
}

// Best same-game parlays: up to 5 per day, so each day picked on the Today page has some.
const sgps = games
  .map((g) => ({ game: g.key, matchup: g.matchup, league: g.league, day: etDate(new Date(g.start)), sgp: bestSameGame(legs.filter((l) => l.lean && l.grade === "A"), g.key, 3) || bestSameGame(legs.filter((l) => l.lean), g.key, 3) }))
  .filter((x) => x.sgp && x.sgp.ev > 0)
  .sort((a, b) => b.sgp.ev - a.sgp.ev)
  .filter((x, i, all) => all.slice(0, i).filter((y) => y.day === x.day).length < 5);

// Record every graded leg shown today, and the featured moonshots' long shots.
{
  const seen = new Set(tracked.picks.map((p) => p.id));
  const issuedNow = new Date().toISOString();
  for (const l of legs) {
    if (!l.lean || !["A", "B", "C"].includes(l.grade) || !usableLeg(l) || seen.has(l.id) || new Date(l.start) <= now) continue;
    tracked.picks.push(trackRow(l, "leg", issuedNow)); seen.add(l.id);
  }
  const altById = new Map(alts.map((l) => [l.id, l]));
  for (const m of Object.values(moonshots)) for (const id of m.legs) {
    const l = altById.get(id);
    if (l && !seen.has(id) && new Date(l.start) > now) { tracked.picks.push(trackRow(l, "alt", issuedNow)); seen.add(id); }
  }
  tracked.picks = tracked.picks.filter((p) => now - new Date(p.start) < 120 * 864e5);
  tracked.updated = issuedNow;
  fs.writeFileSync(TRACKED, JSON.stringify(tracked));
  console.log(`tracked: ${tracked.picks.length} legs (${trackedGraded} graded this run)`);
}

const slim = (l) => ({ ...l, prob: Number(l.prob.toFixed(4)), edge: Number(l.edge.toFixed(4)), ev: Number(l.ev.toFixed(4)) });
const today = {
  generated: issued, date: todayET, games, legs: legs.map(slim), picks: picks.map((p) => p.id),
  alts: alts.map(slim),
  moonshots,
  moonRecord: moonRecord(moonLog),
  featured: Object.fromEntries(Object.entries(featured).map(([k, v]) => [k, v ? { legs: v.legs.map((l) => l.id), american: v.american, prob: v.prob, ev: v.ev, day: v.day, sgp: v.sgp } : null])),
  sgps: sgps.map((x) => ({ game: x.game, matchup: x.matchup, league: x.league, legs: x.sgp.legs.map((l) => l.id), american: x.sgp.american, prob: x.sgp.prob, ev: x.sgp.ev })),
  books: BOOKS ? { fetchedAt: BOOKS.fetchedAt, remaining: BOOKS.remaining } : null,
  topStories,
  record: { all: record(history), last30: record(history, 30), last7: record(history, 7), graded, clv: clvSummary(history), calibration: calibration(history), snapshots },
  tracked: trackedSummary(tracked),
  learn: Object.fromEntries(Object.entries(learn).map(([g, x]) => [g, { n: x.n, w: x.w, ne: Number(x.ne.toFixed(1)), hit: Number(x.hit.toFixed(4)), model: Number(x.model.toFixed(4)), be: Number(x.be.toFixed(4)), k: Number(x.k.toFixed(4)) }])),
};
const outDir = path.join(SITE, "data", "picks");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "today.json"), JSON.stringify(today));
fs.writeFileSync(path.join(outDir, "history.json"), JSON.stringify(history));
// Every leg the app showed, for 📋 Pick history's "every leg" view.
fs.writeFileSync(path.join(outDir, "tracked.json"), JSON.stringify({ updated: tracked.updated, picks: tracked.picks }));
fs.writeFileSync(path.join(outDir, "moonshots.json"), JSON.stringify(moonLog));

// Phone notification text.
// Today's games lead; picks for later in the week fill in, marked with their day.
const todayPicks = picks.filter((p) => dayOf(p) === todayET), laterPicks = picks.filter((p) => dayOf(p) !== todayET);
const short = (l) => `${dayOf(l) === todayET ? "" : `${weekdayOf(l)} · `}${l.grade} · ${l.label}${l.kind === "prop" ? "" : ` (${l.matchup})`} ${fmtOdds(l.odds)}`;
const counts = ["A", "B"].map((g) => `${todayPicks.filter((p) => p.grade === g).length} ${g}`).join(", ");
const strongToday = todayPicks.filter((p) => p.grade === "A" || p.grade === "B").length;
// Lead with ⭐ best bets, then grade A, when there are enough of them.
const todayA = todayPicks.filter((p) => p.grade === "A");
const lead = [...todayPicks.filter(isBestBet), ...(todayA.length >= 3 ? todayA : todayPicks).filter((p) => !isBestBet(p))];
const lines = [...lead.slice(0, 6), ...laterPicks.slice(0, Math.max(0, 4 - lead.length))].map((l) => `${isBestBet(l) ? "⭐ " : ""}${short(l)}`);
const parlayLine = (icon, f) => `${icon} ${f.legs.length}-leg ${f.sgp ? `same-game parlay (${f.legs[0].matchup})` : "parlay"}${f.day === todayET ? "" : ` for ${weekdayOf(f.legs[0])}`} ${fmtOdds(f.american)} (${pctTxt(f.prob)} to hit)`;
if (featured.basketball) lines.push(parlayLine("🏀", featured.basketball));
if (featured.football) lines.push(parlayLine("🏈", featured.football));
if (moonshots.all) lines.push(`🚀 Moonshot: $10 → $${moonshots.all.payout.toLocaleString("en-US")} (${moonshots.all.legs.length} legs${moonshots.all.later ? ", includes later games" : ""}, est. 1 in ${oneIn(moonshots.all.prob)}; lottery money only)`);
for (const id of ["nba", "nfl"]) {
  const st = topStories.find((x) => x.league === id);
  if (st) lines.push(`📰 ${leagueById(id).name}: ${st.headline}`);
}
const rec = today.record.last30;
// Mondays: last week's report card.
const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now);
const wk = today.record.last7, clvAll = today.record.clv;
if (weekday === "Mon" && wk.w + wk.l) {
  const best = ["A", "B", "C"].map((g) => ({ g, ...wk.byGrade[g] })).filter((x) => x.w + x.l).sort((a, b) => b.units - a.units)[0];
  lines.push(`📊 Last week: ${wk.w}-${wk.l}, ${wk.units >= 0 ? "+" : ""}${wk.units.toFixed(1)}u${best ? ` · best: ${best.g} picks ${best.w}-${best.l}` : ""}${clvAll?.rate != null ? ` · beat the closing line ${Math.round(clvAll.rate * 100)}%` : ""}`);
} else if (rec.w + rec.l) lines.push(`Last 30 days: ${rec.w}-${rec.l}, ${rec.units >= 0 ? "+" : ""}${rec.units.toFixed(1)}u`);
fs.writeFileSync("notify.json", JSON.stringify({
  skip: failedLeagues === LEAGUES.length,
  // Only A and B count as picks in the title; a day of C leans says so instead.
  title: strongToday ? `PickLab: ${strongToday} picks today (${counts})${laterPicks.length ? ` + ${laterPicks.length} later` : ""}` : todayPicks.length ? `PickLab: no strong edges today · ${todayPicks.length} thin C lean${todayPicks.length === 1 ? "" : "s"}` : picks.length ? `PickLab: ${picks.length} picks for later this week` : "PickLab: no strong edges today",
  body: picks.length ? `${!strongToday && todayPicks.length ? "Nothing graded A or B today. C leans are close to coin flips: skip them or bet small.\n" : ""}${lines.join("\n")}` : "Nothing cleared the bar. Sitting out is a pick too.",
  click: `${SITE_URL}#/today`,
}));
console.log(`picks: ${picks.length}, legs: ${legs.length}, games: ${games.length}, graded: ${graded}`);
