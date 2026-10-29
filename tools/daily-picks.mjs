// Daily picks generator. Runs in GitHub Actions after the data pipeline:
//   node tools/daily-picks.mjs --site _site --history picks-data/history.json
// Scans today's NBA / college basketball games and this week's NFL / college
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
const { api, standingsTable, parseProps, loadGamelogs, pool } = await import("../js/espn.js");
const { impliedProb, fmtOdds, makeVerdict, expectedValue } = await import("../js/model.js");
const { loadDeep } = await import("../js/deep.js");
const { gameContext, defaultLines, evaluateLines, fmtSpread, guardLine } = await import("../js/gamemodel.js");
const { loadPeople, propRows, scanRows } = await import("../js/scan.js");
const { injuryReport } = await import("../js/context.js");
const { marketValue } = await import("../js/props.js");
const { bestParlay, bestSameGame, decimalOdds, choosePicks } = await import("../js/parlay.js");
const { loadBooks, matchEvent, shop } = await import("./books.mjs");

const LEAGUES = [
  { id: "nba", window: "day", props: true },
  { id: "nfl", window: "week", props: true },
  { id: "ncaaf", window: "week", props: true, params: "groups=80&limit=300" },
  { id: "ncaab", window: "day", props: true, params: "groups=50&limit=400" },
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
      if (sh) leg.books = sh.books;
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
    r.context?.withWithout?.notes[0] || "",
    r.context?.implied != null && Math.abs((r.context.factor || 1) / (r.context.withWithout?.factor || 1) - 1) > 0.02 ? `team total ${r.context.implied.toFixed(1)}` : "",
  ].filter(Boolean).join(" · ");
  return {
    id: `${L.id}:${game.eventId}:${r.aid}:${r.key}:${side}`, league: L.id, gameKey: game.key, eventId: game.eventId, start: game.start, matchup: game.matchup,
    kind: "prop", player: r.who.name, playerId: r.aid, team: r.who.team?.abbreviation, pos: r.who.pos,
    marketKey: r.key, market: r.m.label, line: r.p.line, side, label: `${r.who.name} ${side === "OVER" ? "Over" : "Under"} ${r.p.line} ${r.m.label}`,
    odds, priced: r.p.over != null && r.p.under != null, prob, edge: prob - impliedProb(odds), ev: prob * decimalOdds(odds) - 1,
    grade: res.verdict.grade, lean: true, proj: Number(res.projection.toFixed(2)), why,
    mismatch: !!res.verdict.mismatch,
    book: { line: r.p.line, over: r.p.over, under: r.p.under },
    questionable: r.context?.status?.maybe ? r.context.status.status : undefined,
    roleChange: res.verdict.roleChange,
    context: r.context?.notes?.length ? r.context.notes : undefined,
  };
}

let failedLeagues = 0;
// All-book prices (optional ODDS_API_KEY secret; refreshed once a day, cached otherwise).
const BOOKS = await loadBooks({ key: process.env.ODDS_API_KEY, cacheFile: "cache/oddsapi.json", refresh: process.env.ODDS_API_REFRESH === "1", leagues: LEAGUES.map((c) => c.id) }).catch((e) => { console.log(`odds api: ${e.message}`); return null; });
console.log(BOOKS ? `odds api: ${Object.values(BOOKS.events).reduce((s, x) => s + x.length, 0)} events from ${BOOKS.fetchedAt}` : "odds api: off (no ODDS_API_KEY), using DraftKings only");

async function scanLeague(cfg) {
  const L = leagueById(cfg.id);
  let events = [];
  try { events = await upcomingEvents(cfg, L); } catch (e) { console.log(`${cfg.id}: scoreboard failed ${e.message}`); failedLeagues++; return { games: [], legs: [] }; }
  console.log(`${cfg.id}: ${events.length} upcoming games`);
  if (!events.length) return { games: [], legs: [] };
  const [standings, deep] = await Promise.all([
    api.standings(L).then(standingsTable).catch(() => null),
    loadDeep(L).catch(() => null),
  ]);
  const games = [], legs = [];
  await pool(events, 3, async (e) => {
    try {
      const sum = await api.summary(L, e.id);
      const comp = sum.header.competitions[0];
      const h = comp.competitors.find((c) => c.homeAway === "home"), a = comp.competitors.find((c) => c.homeAway === "away");
      const [schedH, schedA] = await Promise.all([api.schedule(L, h.team.id).catch(() => null), api.schedule(L, a.team.id).catch(() => null)]);
      const gc = gameContext(L, sum, standings, schedH, schedA);
      const game = {
        key: `${L.id}:${e.id}`, league: L.id, eventId: e.id, start: comp.date, matchup: `${a.team.abbreviation} @ ${h.team.abbreviation}`,
        home: { id: h.team.id, abbr: h.team.abbreviation, name: h.team.displayName, logo: h.team.logos?.[0]?.href },
        away: { id: a.team.id, abbr: a.team.abbreviation, name: a.team.displayName, logo: a.team.logos?.[0]?.href },
        lines: { details: gc.odds.details, spreadHome: gc.odds.spreadHome, total: gc.odds.total, mlHome: gc.odds.mlHome, mlAway: gc.odds.mlAway },
      };
      const gameLegs = lineLegs(L, gc, game, matchEvent(BOOKS, L.id, game));
      if (cfg.props) {
        const props = await api.propBets(L, e.id).then((items) => parseProps(items, L.markets)).catch(() => null);
        if (props?.size) {
          const people = await loadPeople(L, [gc.H, gc.A]);
          const rows = propRows(L, props, people);
          await scanRows(L, rows, { game: { H: gc.H, A: gc.A, date: comp.date, lines: { spreadHome: gc.odds.spreadHome, total: gc.odds.total }, report: injuryReport(sum) }, standings, deep, concurrency: 4 });
          game.out = rows.filter((r) => r.out).map((r) => `${r.who.name} (${r.out})`).filter((x, i, a) => a.indexOf(x) === i);
          for (const r of rows) if (r.res?.verdict?.lean) gameLegs.push(propLeg(L, game, r));
        }
      }
      game.nLegs = gameLegs.length;
      games.push(game);
      legs.push(...gameLegs);
    } catch (err) {
      console.log(`  ${cfg.id} ${e.id} failed: ${err.message}`);
    }
  });
  console.log(`${cfg.id}: ${games.length} games, ${legs.length} legs`);
  return { games, legs };
}

// ---------- track record ----------
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY, "utf8")); } catch { return { picks: [] }; }
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
        const v = m ? marketValue(m, g) : null;
        if (v == null) return;
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
const picks = choosePicks(legs);

const history = loadHistory();
const snapshots = snapshotLines(history, legs);
const graded = await gradePending(history);
for (const p of history.picks) if (p.result && p.close && !p.clv) p.clv = clvOf(p);
const known = new Set(history.picks.map((p) => p.id));
const issued = new Date().toISOString();
for (const p of picks) {
  if (known.has(p.id)) continue;
  history.picks.push({ id: p.id, issued, start: p.start, league: p.league, eventId: p.eventId, matchup: p.matchup, kind: p.kind, marketKey: p.marketKey, market: p.market,
    playerId: p.playerId, player: p.player, team: p.team, side: p.side, line: p.line, odds: p.odds, prob: Number(p.prob.toFixed(4)), edge: Number(p.edge.toFixed(4)), grade: p.grade, label: p.label, result: null });
}
history.picks = history.picks.filter((p) => now - new Date(p.start) < 400 * 864e5);
history.updated = issued;
fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
fs.writeFileSync(HISTORY, JSON.stringify(history));

const groups = { basketball: ["nba", "ncaab"], football: ["nfl", "ncaaf"] };
const parlayFor = (ids, n) => bestParlay(legs.filter((l) => l.lean && ids.includes(l.league) && l.grade !== "PASS" && new Date(l.start) > now), n);
const featured = {
  basketball: parlayFor(groups.basketball, 3),
  football: parlayFor(groups.football, 3),
  any: parlayFor([...groups.basketball, ...groups.football], 3),
};
const sgps = games
  .map((g) => ({ game: g.key, matchup: g.matchup, league: g.league, sgp: bestSameGame(legs.filter((l) => l.lean), g.key, 3) }))
  .filter((x) => x.sgp && x.sgp.ev > 0)
  .sort((a, b) => b.sgp.ev - a.sgp.ev)
  .slice(0, 5);

const slim = (l) => ({ ...l, prob: Number(l.prob.toFixed(4)), edge: Number(l.edge.toFixed(4)), ev: Number(l.ev.toFixed(4)) });
const today = {
  generated: issued, date: todayET, games, legs: legs.map(slim), picks: picks.map((p) => p.id),
  featured: Object.fromEntries(Object.entries(featured).map(([k, v]) => [k, v ? { legs: v.legs.map((l) => l.id), american: v.american, prob: v.prob, ev: v.ev } : null])),
  sgps: sgps.map((x) => ({ game: x.game, matchup: x.matchup, league: x.league, legs: x.sgp.legs.map((l) => l.id), american: x.sgp.american, prob: x.sgp.prob, ev: x.sgp.ev })),
  books: BOOKS ? { fetchedAt: BOOKS.fetchedAt, remaining: BOOKS.remaining } : null,
  record: { all: record(history), last30: record(history, 30), last7: record(history, 7), graded, clv: clvSummary(history), calibration: calibration(history), snapshots },
};
const outDir = path.join(SITE, "data", "picks");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "today.json"), JSON.stringify(today));
fs.writeFileSync(path.join(outDir, "history.json"), JSON.stringify(history));

// Phone notification text.
const short = (l) => `${l.grade} · ${l.label}${l.kind === "prop" ? "" : ` (${l.matchup})`} ${fmtOdds(l.odds)}`;
const counts = ["A", "B"].map((g) => `${picks.filter((p) => p.grade === g).length} ${g}`).join(", ");
const lines = picks.slice(0, 6).map(short);
if (featured.basketball) lines.push(`🏀 3-leg parlay ${fmtOdds(featured.basketball.american)} (${pctTxt(featured.basketball.prob)} to hit)`);
if (featured.football) lines.push(`🏈 3-leg parlay ${fmtOdds(featured.football.american)} (${pctTxt(featured.football.prob)} to hit)`);
const rec = today.record.last30;
if (rec.w + rec.l) lines.push(`Last 30 days: ${rec.w}-${rec.l}, ${rec.units >= 0 ? "+" : ""}${rec.units.toFixed(1)}u`);
fs.writeFileSync("notify.json", JSON.stringify({
  skip: failedLeagues === LEAGUES.length,
  title: picks.length ? `PickLab: ${picks.length} picks today (${counts})` : "PickLab: no strong edges today",
  body: picks.length ? lines.join("\n") : "Nothing cleared the bar. Sitting out is a pick too.",
  click: `${SITE_URL}#/today`,
}));
console.log(`picks: ${picks.length}, legs: ${legs.length}, games: ${games.length}, graded: ${graded}`);
