// Today's picks: model picks, a ticket sized to your budget, your own parlay,
// same-game parlays, and the graded track record.
import { leagueById } from "../sports.js";
import { api, standingsTable, parseProps } from "../espn.js";
import * as M from "../model.js";
import { esc, loading, setTitle, pct, fx, signed, fmtDate, fmtTime, toast } from "../ui.js";
import { addPick, addTicket } from "../store.js";
import { loadDeep } from "../deep.js";
import { gameContext, defaultLines, evaluateLines } from "../gamemodel.js";
import { loadPeople, propRows, scanRows } from "../scan.js";
import { injuryReport } from "../context.js";
import { gameWeather } from "../weather.js";
import { planTicket, combine, compatible, choosePicks, bestSameGame, usableLeg } from "../parlay.js";
import { timeAgo } from "../news.js";
import { placeBet } from "../sportsbooks.js";
import { buildMoonshot, oneIn } from "../moonshot.js";
import { moveText } from "../movement.js";
import { bankroll, bankrollOk, suggestedBudget, spend, openBankrollSettings, bankrollMoney } from "../bankroll.js";

const SPORTS = [
  { id: "all", label: "All", leagues: ["nba", "ncaab", "nfl", "ncaaf", "nhl"] },
  { id: "basketball", label: "🏀 All basketball", leagues: ["nba", "ncaab"] },
  { id: "nba", label: "NBA", leagues: ["nba"] },
  { id: "ncaab", label: "College BB", leagues: ["ncaab"] },
  { id: "football", label: "🏈 All football", leagues: ["nfl", "ncaaf"] },
  { id: "nfl", label: "NFL", leagues: ["nfl"] },
  { id: "ncaaf", label: "College FB", leagues: ["ncaaf"] },
  { id: "nhl", label: "🏒 NHL", leagues: ["nhl"] },
];
const LEG_COUNTS = [2, 3, 4, 5, 6, 8, 10];
const MOON_STAKES = [1, 2, 5, 10, 20];
const MOON_TARGETS = [1000, 5000, 10000, 25000, 50000];
const BUDGETS = [5, 10, 25, 50, 100];
const PREFS = "picklab.today.v1";

const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS) || "{}"); } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* ignore */ } };
const money = (x) => (x == null || !isFinite(x) ? "—" : `$${x >= 100 ? x.toFixed(0) : x.toFixed(2).replace(/\.00$/, "")}`);
const getData = (p) => fetch(p, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const leagueName = (id) => leagueById(id)?.name || id;

export async function renderToday(ctx, q) {
  const { app } = ctx;
  setTitle("Today's picks");
  app.innerHTML = loading("Loading today's picks…");
  const [today, history] = await Promise.all([getData("data/picks/today.json"), getData("data/picks/history.json")]);
  if (!ctx.alive()) return;

  const prefs = { sport: "all", budget: 10, mode: "mix", legs: 3, moonStake: 10, moonTarget: 10000, moonPerGame: 1, ...loadPrefs() };
  if (q.sport) prefs.sport = q.sport;
  if (q.focus === "moon") Object.assign(prefs, { moonStake: 10, moonTarget: 10000 });
  const state = { ...prefs, mine: [], sgpGame: q.sgp || null, sgpLegs: null, sgpPicked: [] };
  const now = Date.now();
  const allLegs = (today?.legs || []).filter((l) => new Date(l.start) > now);
  const games = (today?.games || []).filter((g) => new Date(g.start) > now);
  const legById = new Map([...(today?.legs || []), ...(today?.alts || [])].map((l) => [l.id, l]));
  const allAlts = (today?.alts || []).filter((l) => new Date(l.start) > now);
  let moonExclude = [];

  const stale = today && today.date !== new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replaceAll("-", "");
  const rec = today?.record?.last30;

  app.innerHTML = `<div id="t-root">
    <div class="crumbs"><a href="#/">Home</a> › Today</div>
    <div class="row" style="justify-content:space-between">
      <h1>🔥 Today's picks</h1>
      <div class="small muted">${today ? `Updated ${fmtDate(today.generated, { weekday: "short", month: "short", day: "numeric" })} ${fmtTime(today.generated)}${stale ? ` · <span class="neg">not refreshed today yet</span>` : ""}${today.books ? ` · game lines checked across every major book at ${fmtTime(today.books.fetchedAt)}` : ""} · <a href="#/trends">📈 Trends</a> · <a href="#/live">📡 Live</a>` : ""}${rec && rec.w + rec.l ? ` · Last 30 days <b>${rec.w}-${rec.l}</b> <span class="${rec.units >= 0 ? "pos" : "neg"}">${signed(rec.units, 1)}u</span>` : ""}</div>
    </div>
    ${today ? "" : `<div class="notice warn" style="margin-bottom:14px">Daily picks are generated on GitHub each morning (around 5am, 11:45am and 5pm ET). They'll show here after the first run. You can still build a same-game parlay for any game below.</div>`}
    <div class="card">
      <h3>Sport</h3>
      <div class="chips scroll" id="t-sport">${SPORTS.map((s) => `<button class="chip" data-s="${s.id}">${s.label}</button>`).join("")}</div>
      <div class="grid two" style="margin-top:12px;gap:12px">
        <div><h3>Budget</h3><div class="row"><div class="chips" id="t-budget">${BUDGETS.map((b) => `<button class="chip" data-b="${b}">$${b}</button>`).join("")}</div>
          <div class="field" style="width:92px"><input id="t-custom" type="number" min="1" step="1" placeholder="Custom" inputmode="numeric"/></div></div>
          <div class="small muted" id="t-bank" style="margin-top:6px"></div></div>
        <div><h3>Build</h3><div class="row"><div class="seg" id="t-mode"><button data-m="singles">Straight bets</button><button data-m="parlay">Parlay</button><button data-m="mix">Mix</button></div>
          <div class="seg" id="t-legs">${LEG_COUNTS.map((n) => `<button data-n="${n}">${n} legs</button>`).join("")}</div>
          <div class="field" id="t-legs-custom-f" style="width:84px"><input id="t-legs-custom" type="number" min="2" max="15" step="1" placeholder="Legs" inputmode="numeric" title="Any number of legs, 2-15"/></div></div></div>
      </div>
    </div>
    <div class="card" style="margin-top:14px" id="t-ticket"></div>
    <div class="card moon" style="margin-top:14px" id="t-moon"></div>
    <div class="grid two" style="margin-top:14px">
      <div class="card" id="t-picks"></div>
      <div>
        <div class="card" id="t-mine"></div>
        <div class="card" style="margin-top:14px" id="t-sgp"></div>
      </div>
    </div>
    <div class="card" style="margin-top:14px" id="t-record"></div>
    ${today?.topStories?.length ? `<div class="card" style="margin-top:14px">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">🗞️ Today's top stories</h3><a class="small" href="#/news">News & highlights ›</a></div>
      <div style="margin-top:6px">${today.topStories.map((st) => `<a class="news-line" href="${esc(st.url)}" target="_blank" rel="noopener"><b>${esc(leagueName(st.league))}</b> · ${esc(st.headline)} <span class="faint">· ${timeAgo(st.published)}</span></a>`).join("")}</div>
    </div>` : ""}
    <div class="card" style="margin-top:14px">
      <h3>Get these on your phone</h3>
      <ol class="small muted" style="padding-left:18px;margin:0">
        <li>Install the free <b>ntfy</b> app (App Store / Google Play).</li>
        <li>Tap <b>+</b> and subscribe to your private topic name (the one saved in this repo's <code>NTFY_TOPIC</code> secret).</li>
        <li>Every day around 11:45am ET you'll get the top picks and the day's basketball and football parlays, with a link back here.</li>
      </ol>
    </div>
    <p class="small faint" style="margin-top:14px">Stakes use a quarter-Kelly split weighted by edge. Parlay odds multiply the legs' prices; a same-game parlay's real price at the book will differ because books adjust for correlated legs. Every leg's probability is a model estimate. Parlays compound both the edge and the error, so keep them small.</p></div>`;

  const $ = (s) => app.querySelector(s);
  const sportLeagues = () => SPORTS.find((s) => s.id === state.sport)?.leagues || SPORTS[0].leagues;
  const legsInSport = () => allLegs.filter((l) => sportLeagues().includes(l.league));

  function persist() {
    savePrefs({ sport: state.sport, budget: state.budget, mode: state.mode, legs: state.legs, moonStake: state.moonStake, moonTarget: state.moonTarget, moonPerGame: state.moonPerGame });
  }

  function syncControls() {
    app.querySelectorAll("#t-sport .chip").forEach((b) => b.classList.toggle("on", b.dataset.s === state.sport));
    app.querySelectorAll("#t-budget .chip").forEach((b) => b.classList.toggle("on", Number(b.dataset.b) === Number(state.budget)));
    app.querySelectorAll("#t-mode button").forEach((b) => b.classList.toggle("on", b.dataset.m === state.mode));
    app.querySelectorAll("#t-legs button").forEach((b) => b.classList.toggle("on", Number(b.dataset.n) === Number(state.legs)));
    $("#t-legs").classList.toggle("hidden", state.mode === "singles");
    $("#t-legs-custom-f").classList.toggle("hidden", state.mode === "singles");
    if (!LEG_COUNTS.includes(Number(state.legs))) $("#t-legs-custom").value = state.legs;
    // Bankroll: a suggested budget for today and what's left of your limits.
    const bk = bankroll(), sug = suggestedBudget(), sp = spend();
    $("#t-bank").innerHTML = bk.bankroll
      ? `🏦 Suggested today: <button class="chip ${Number(state.budget) === sug ? "on" : ""}" data-b="${sug}" style="padding:2px 9px">$${sug}</button> · spent today ${bankrollMoney(sp.day)}${bk.dailyLimit ? ` of ${bankrollMoney(bk.dailyLimit)}` : ""}${bk.weeklyLimit ? ` · this week ${bankrollMoney(sp.week)} of ${bankrollMoney(bk.weeklyLimit)}` : ""} · <button class="linkbtn" data-bank style="margin:0">edit</button>`
      : `<button class="linkbtn" data-bank style="margin:0">🏦 Set your bankroll</button> to get a suggested daily budget and spending limits.`;
    if (!BUDGETS.includes(Number(state.budget))) $("#t-custom").value = state.budget;
  }

  const legLink = (l) => (l.kind === "prop" ? `#/l/${l.league}/p/${l.playerId}?m=${l.marketKey}&line=${l.line}${l.odds != null && l.priced ? `&${l.side === "OVER" ? "oo" : "uo"}=${l.odds}` : ""}` : `#/l/${l.league}/g/${l.eventId}`);
  const priceTag = (l) => `${M.fmtOdds(l.odds)}${l.priced === false ? `<span class="faint" title="Book posted the line without a price; assumed -110"> est.</span>` : ""}`;

  function legRow(l, { addable = true, inMine = false } = {}) {
    return `<div class="pick" style="display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)">
      <div class="grade ${l.grade}" style="width:40px;height:40px;font-size:17px;border-radius:11px">${l.grade === "PASS" ? "—" : l.grade}</div>
      <div style="min-width:0">
        <div style="font-weight:700"><a href="${legLink(l)}" style="color:var(--text)">${esc(l.label)}</a> <span class="muted" style="font-weight:600">${priceTag(l)}</span></div>
        <div class="small muted">${esc(leagueName(l.league))} · ${esc(l.matchup)} · ${fmtDate(l.start, { weekday: "short" })} ${fmtTime(l.start)}</div>
        <div class="small faint">${pct(l.prob)} to hit vs ${pct(M.impliedProb(l.odds), 1)} break-even · edge ${signed(l.edge * 100, 1)}${l.why ? ` · ${esc(l.why)}` : ""}</div>
        ${l.mismatch ? `<div class="small" style="color:var(--gold)">${l.kind === "prop" ? "Line is far from the player's recent numbers — likely a role change. Check the news." : "Our team model is far from the market here; it's probably missing news. Graded down."}</div>` : ""}
        ${l.questionable ? `<div class="small" style="color:var(--gold)">Injury report: ${esc(l.questionable)}. Kept out of tickets until the status clears.</div>` : ""}
        ${l.move ? `<div class="small ${l.move.toward ? "pos" : l.move.strong ? "neg" : "muted"}">${esc(moveText(l.move))}${l.moveCap ? " — graded down to C" : ""}</div>` : ""}
        ${l.bestBook ? `<div class="small pos">Better price: ${M.fmtOdds(l.bestBook.odds)} at ${esc(l.bestBook.title)} (DraftKings ${M.fmtOdds(l.odds)})</div>` : ""}
        ${l.news?.url ? `<a class="news-line" href="${esc(l.news.url)}" target="_blank" rel="noopener">${l.news.video ? "🎬" : "📰"} ${esc(l.news.headline)} <span class="faint">· ${timeAgo(l.news.published)}</span></a>` : ""}
      </div>
      <div class="pick-actions">
        ${addable ? `<button class="btn ${inMine ? "" : "ghost"} sm" data-add="${esc(l.id)}" title="Add to my parlay">${inMine ? "✓" : "+"}</button>` : ""}
        ${l.dk ? `<a class="bookchip" style="--bc:#53d337" href="${esc(l.dk)}" target="_blank" rel="noopener" title="${l.dkExact ? "Open DraftKings with this bet in your slip" : "Open this game on DraftKings"}">DK${l.dkExact ? " ＋" : " ↗"}</a>` : ""}
      </div>
    </div>`;
  }

  function betCard(b, i) {
    const label = b.type === "single" ? "Straight" : b.type === "sgp" ? `${b.legs.length}-leg same-game parlay` : `${b.legs.length}-leg parlay`;
    return `<div style="border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:10px">
      <div class="row" style="justify-content:space-between"><b>${label}</b><span><b>${money(b.stake)}</b> to win <b class="pos">${money(b.toWin)}</b> · ${M.fmtOdds(b.american)}</span></div>
      <div class="small" style="margin-top:6px">${b.legs.map((l) => `• ${esc(l.label)} <span class="faint">${esc(l.kind === "prop" ? l.matchup : "")} ${M.fmtOdds(l.odds)}</span>`).join("<br/>")}</div>
      <div class="small muted" style="margin-top:6px">Model: ${pct(b.prob, b.prob < 0.1 ? 1 : 0)} to hit · expected ${signed(b.expected, 2)} on ${money(b.stake)}</div>
      ${placeBet(b.legs, { stake: b.stake, american: b.american, title: label })}
    </div>`;
  }

  function renderTicket() {
    const legs = legsInSport().filter((l) => l.lean && l.grade !== "PASS");
    const t = planTicket(legs, state.budget, state.mode, state.legs);
    const box = $("#t-ticket");
    if (!t.bets.length) {
      box.innerHTML = `<h3>Your ${money(state.budget)} ticket</h3><div class="muted">No ${esc(SPORTS.find((s) => s.id === state.sport).label)} picks with an edge right now${legs.length ? "" : " (no games or lines posted yet)"}. Try another sport, or build a same-game parlay below.</div>`;
      return;
    }
    box.innerHTML = `<div class="row" style="justify-content:space-between"><h3 style="margin:0">Your ${money(state.budget)} ticket</h3>
      <div class="row"><button class="btn ghost sm" id="t-copy">Copy</button><button class="btn sm" id="t-save">★ Save all</button></div></div>
      <div class="kpis">
        <div class="kpi"><div class="k">Total stake</div><div class="v">${money(t.totals.stake)}</div></div>
        <div class="kpi"><div class="k">If everything hits</div><div class="v pos">${money(t.totals.maxReturn)}</div></div>
        <div class="kpi"><div class="k">Model expectation</div><div class="v ${t.totals.expectedProfit >= 0 ? "pos" : "neg"}">${signed(t.totals.expectedProfit, 2)}</div></div>
      </div>
      ${t.bets.some((b) => b.type !== "single" && b.legs.length < Number(state.legs)) ? `<div class="notice" style="margin-top:10px">Only ${t.bets.find((b) => b.type !== "single").legs.length} legs have an edge right now, so the parlay is ${t.bets.find((b) => b.type !== "single").legs.length} legs instead of ${state.legs}. Add your own with + to go longer.</div>` : ""}
      ${t.bets.map(betCard).join("")}`;
    $("#t-copy").onclick = () => {
      const txt = t.bets.map((b) => `${b.type === "single" ? "Straight" : `${b.legs.length}-leg parlay`} ${money(b.stake)} @ ${M.fmtOdds(b.american)}\n${b.legs.map((l) => `  ${l.label} ${M.fmtOdds(l.odds)}`).join("\n")}`).join("\n\n");
      navigator.clipboard?.writeText(txt).then(() => toast("Ticket copied"), () => toast("Copy failed"));
    };
    $("#t-save").onclick = () => {
      if (!bankrollOk(t.totals.stake)) return;
      for (const b of t.bets) saveTicket(b.type, b.legs, b.stake, b.american, { prob: b.prob, skipCheck: true });
      renderAll();
      toast(`Saved ${t.bets.length} bet${t.bets.length === 1 ? "" : "s"} · track them live under ★ My bets`);
    };
  }

  // A leg in the saved-pick shape (store.js), which the live tracker also reads.
  function toPick(l) {
    if (l.kind === "prop") return { league: l.league, athleteId: l.playerId, athlete: l.player, market: l.marketKey, marketLabel: l.market, line: l.line, side: l.side, odds: l.odds, prob: l.prob, grade: l.grade, eventId: l.eventId, eventDate: l.start, opp: l.matchup };
    const g = games.find((x) => x.key === l.gameKey);
    const [awayAbbr, homeAbbr] = String(l.matchup || "").split(" @ ");
    return { league: l.league, eventId: l.eventId, eventDate: l.start, athlete: l.matchup, marketLabel: l.market, market: l.kind, game: true, homeAbbr: g?.home.abbr || homeAbbr, awayAbbr: g?.away.abbr || awayAbbr,
      side: l.kind === "total" ? (l.side === "OVER" ? `Over ${l.line}` : `Under ${l.line}`) : l.label, line: l.kind === "spread" ? (l.side === "HOME" ? l.line : -l.line) : l.line, odds: l.odds, prob: l.prob, grade: l.grade };
  }
  const saveLeg = (l, extra = {}) => addPick({ ...toPick(l), ...extra });

  // Save a bet as a ticket (tracked live under ★ My bets) and its legs as picks.
  function saveTicket(type, legs, stake, american, { skipCheck = false, ...extra } = {}) {
    if (!skipCheck && !bankrollOk(stake)) return null;
    const id = addTicket({ type, stake, american, toWin: stake * M.payout(american), prob: extra.prob ?? legs.reduce((p, l) => p * (l.prob || 0.5), 1), ...extra, legs: legs.map(toPick) });
    for (const l of legs) saveLeg(l, { ticketId: id });
    return id;
  }

  function renderPicks() {
    const picks = choosePicks(legsInSport(), 15);
    const box = $("#t-picks");
    box.innerHTML = `<h3>Top picks · ${esc(SPORTS.find((s) => s.id === state.sport).label)}</h3>
      ${picks.length ? picks.map((l) => legRow(l, { inMine: state.mine.includes(l.id) })).join("") : `<div class="muted small">Nothing clears the bar right now. That happens; passing is a pick too.</div>`}
      ${today?.featured ? `<p class="small muted" style="margin:10px 0 0">Tap <b>+</b> to add legs to your own parlay.</p>` : ""}`;
  }

  function renderMine() {
    const legs = state.mine.map((id) => legById.get(id) || state.sgpLegs?.find((l) => l.id === id)).filter(Boolean);
    const box = $("#t-mine");
    if (!legs.length) {
      box.innerHTML = `<h3>My parlay</h3><div class="muted small">Add legs with <b>+</b> from the picks or the same-game builder. You'll see the combined odds and what ${money(state.budget)} pays.</div>`;
      return;
    }
    const c = combine(legs);
    const sameGame = new Set(legs.map((l) => l.gameKey)).size < legs.length;
    const conflicts = legs.some((a, i) => legs.some((b, j) => j > i && !compatible(a, b, a.gameKey === b.gameKey)));
    box.innerHTML = `<div class="row" style="justify-content:space-between"><h3 style="margin:0">My parlay · ${legs.length} legs</h3><div class="row"><button class="btn ghost sm" id="t-clear">Clear</button><button class="btn sm" id="t-save-mine">★ Save parlay</button></div></div>
      <div class="kpis"><div class="kpi"><div class="k">Odds</div><div class="v">${M.fmtOdds(c.american)}</div></div>
        <div class="kpi"><div class="k">${money(state.budget)} pays</div><div class="v pos">${money(state.budget * c.decimal)}</div></div>
        <div class="kpi"><div class="k">Model hit chance</div><div class="v">${pct(c.prob, 1)}</div></div></div>
      ${conflicts ? `<div class="notice warn" style="margin-top:8px">Some legs overlap (same player, or spread + moneyline on one game). Books often won't allow these together.</div>` : ""}
      ${sameGame ? `<p class="small muted">Includes same-game legs: the book's price will differ from this estimate.</p>` : ""}
      ${legs.map((l) => legRow(l, { inMine: true })).join("")}
      ${placeBet(legs, { stake: Number(state.budget) || 10, american: c.american, title: `${legs.length}-leg parlay` })}`;
    $("#t-clear").onclick = () => { state.mine = []; renderAll(); };
    $("#t-save-mine").onclick = () => {
      if (!saveTicket(sameGame ? "sgp" : legs.length > 1 ? "parlay" : "single", legs, Number(state.budget) || 10, c.american, { prob: c.prob })) return;
      toast("Parlay saved · track it live under ★ My bets");
    };
  }

  async function loadSgpLegs(key) {
    const [lid, ev] = key.split(":");
    const fromToday = allLegs.filter((l) => l.gameKey === key);
    if (fromToday.length) return fromToday;
    // Not in today's file (other leagues, later games): evaluate live.
    const L = leagueById(lid);
    const sum = await api.summary(L, ev);
    const comp = sum.header.competitions[0];
    const h = comp.competitors.find((c) => c.homeAway === "home"), a = comp.competitors.find((c) => c.homeAway === "away");
    const [standings, schedH, schedA, deep, props, weather] = await Promise.all([
      api.standings(L).then(standingsTable).catch(() => null), api.schedule(L, h.team.id).catch(() => null), api.schedule(L, a.team.id).catch(() => null),
      loadDeep(L).catch(() => null), api.propBets(L, ev).then((items) => parseProps(items, L.markets)).catch(() => null), gameWeather(L, sum).catch(() => null),
    ]);
    const gc = gameContext(L, sum, standings, schedH, schedA, weather);
    const matchup = `${a.team.abbreviation} @ ${h.team.abbreviation}`;
    const st = defaultLines(gc.odds);
    const out = [];
    for (const r of evaluateLines(gc, st).rows) {
      if (!r.sides) continue;
      const s = r.sides.find((x) => x.label === r.v.lean) || r.sides[0];
      const home = s.side === "A";
      out.push({ id: `${lid}:${ev}:${r.key}:${s.side}`, league: lid, gameKey: key, eventId: ev, start: comp.date, matchup, kind: r.key, marketKey: r.key, market: r.label, label: s.label,
        side: r.key === "total" ? (home ? "OVER" : "UNDER") : home ? "HOME" : "AWAY", line: r.key === "spread" ? (home ? st.spreadHome : -st.spreadHome) : r.key === "total" ? st.total : null,
        odds: s.odds ?? -110, priced: s.odds != null, prob: s.prob, edge: s.prob - M.impliedProb(s.odds ?? -110), grade: r.v.grade, lean: true, why: r.info,
        dk: gc.odds.dk?.[r.key]?.[s.side] || gc.odds.dk?.game || undefined, dkExact: !!gc.odds.dk?.[r.key]?.[s.side] || undefined });
    }
    if (props?.size) {
      const people = await loadPeople(L, [gc.H, gc.A]);
      const rows = await scanRows(L, propRows(L, props, people), { game: { H: gc.H, A: gc.A, date: comp.date, lines: { spreadHome: gc.odds.spreadHome, total: gc.odds.total }, report: injuryReport(sum), weather }, standings, deep });
      for (const r of rows) {
        if (!r.res) continue;
        const side = r.res.verdict.lean;
        const prob = (side === "OVER" ? r.res.pOver : r.res.pUnder) / (1 - (r.res.pPush || 0));
        const odds = (side === "OVER" ? r.p.over : r.p.under) ?? -110;
        out.push({ id: `${lid}:${ev}:${r.aid}:${r.key}:${side}`, league: lid, gameKey: key, eventId: ev, start: comp.date, matchup, kind: "prop", player: r.who.name, playerId: r.aid, team: r.who.team?.abbreviation, dk: gc.odds.dk?.game || undefined,
          marketKey: r.key, market: r.m.label, line: r.p.line, side, label: `${r.who.name} ${side === "OVER" ? "Over" : "Under"} ${r.p.line} ${r.m.label}`, odds, priced: r.p.over != null && r.p.under != null,
          prob, edge: prob - M.impliedProb(odds), grade: r.res.verdict.grade, lean: true, mismatch: !!r.res.verdict.mismatch, questionable: r.context?.status?.maybe ? r.context.status.status : undefined,
          why: [`Projection ${r.res.projection.toFixed(1)} vs line ${r.p.line}`, r.context?.withWithout?.notes[0]].filter(Boolean).join(" · ") });
      }
    }
    return out;
  }

  async function renderSgp() {
    const box = $("#t-sgp");
    const sgpGames = games.filter((g) => sportLeagues().includes(g.league));
    const options = sgpGames.map((g) => `<option value="${g.key}" ${state.sgpGame === g.key ? "selected" : ""}>${esc(leagueName(g.league))} · ${esc(g.matchup)} · ${fmtDate(g.start, { weekday: "short" })} ${fmtTime(g.start)}</option>`).join("");
    const extra = state.sgpGame && !sgpGames.some((g) => g.key === state.sgpGame) ? `<option value="${esc(state.sgpGame)}" selected>Selected game</option>` : "";
    box.innerHTML = `<h3>Same-game parlay</h3>
      <div class="field"><select id="t-sgp-game"><option value="">Pick a game…</option>${extra}${options}</select></div>
      <div id="t-sgp-body" style="margin-top:8px">${sgpGames.length || extra ? `<div class="muted small">Choose a game to see every leg the model likes, then auto-build or pick your own.</div>` : `<div class="muted small">No upcoming ${esc(SPORTS.find((s) => s.id === state.sport).label)} games in today's file. Open any game page and tap <b>Build a same-game parlay</b>.</div>`}</div>`;
    $("#t-sgp-game").onchange = (e) => { state.sgpGame = e.target.value || null; state.sgpLegs = null; renderSgp(); };
    if (!state.sgpGame) {
      // Featured: the model's best 3-leg same-game parlays from this morning's run.
      const feats = (today?.sgps || []).filter((x) => sportLeagues().includes(x.league) && x.legs.every((id) => legById.has(id)) && new Date(legById.get(x.legs[0]).start) > now);
      if (feats.length) {
        $("#t-sgp-body").innerHTML = `<p class="small muted" style="margin:0 0 6px">Featured today:</p>${feats.map((x, i) => `<div style="border:1px solid var(--line);border-radius:12px;padding:10px;margin-top:8px">
          <div class="row" style="justify-content:space-between"><b>${esc(leagueName(x.league))} · ${esc(x.matchup)}</b><span>${M.fmtOdds(x.american)} · ${pct(x.prob, 1)} to hit</span></div>
          <div class="small" style="margin-top:4px">${x.legs.map((id) => `• ${esc(legById.get(id).label)}`).join("<br/>")}</div>
          <button class="btn ghost sm" style="margin-top:6px" data-feat="${i}">Open in builder</button></div>`).join("")}`;
        $("#t-sgp-body").querySelectorAll("[data-feat]").forEach((b) => b.addEventListener("click", () => {
          const x = feats[Number(b.dataset.feat)];
          state.sgpGame = x.game;
          state.sgpLegs = null;
          state.mine = [...x.legs];
          renderAll();
          renderSgp();
        }));
      }
      return;
    }
    const body = $("#t-sgp-body");
    if (!state.sgpLegs) {
      body.innerHTML = loading("Scoring every leg in this game…");
      try { state.sgpLegs = await loadSgpLegs(state.sgpGame); } catch (e) { body.innerHTML = `<div class="notice warn">Couldn't load this game: ${esc(e.message)}</div>`; return; }
      if (!ctx.alive()) return;
    }
    const legs = [...state.sgpLegs].sort((a, b) => b.edge - a.edge);
    const best = bestSameGame(legs, state.sgpGame, Math.min(state.legs, 4));
    body.innerHTML = `${best ? `<div style="border:1px solid var(--line);border-radius:12px;padding:12px">
        <div class="row" style="justify-content:space-between"><b>Model's best ${best.legs.length}-leg SGP</b><span>${M.fmtOdds(best.american)} · ${money(state.budget)} pays <b class="pos">${money(state.budget * best.decimal)}</b></span></div>
        <div class="small" style="margin-top:6px">${best.legs.map((l) => `• ${esc(l.label)} ${M.fmtOdds(l.odds)}`).join("<br/>")}</div>
        <div class="small muted" style="margin-top:6px">Model: ${pct(best.prob, 1)} to hit (treats legs as independent) · <button class="btn ghost sm" id="t-sgp-use">Use these legs</button></div></div>` : `<div class="muted small">Not enough compatible legs in this game yet.</div>`}
      <div style="margin-top:8px">${legs.slice(0, 25).map((l) => legRow(l, { inMine: state.mine.includes(l.id) })).join("")}</div>`;
    $("#t-sgp-use")?.addEventListener("click", () => { state.mine = best.legs.map((l) => l.id); renderAll(); });
  }

  function renderRecord() {
    const box = $("#t-record");
    const r = today?.record;
    const graded = (history?.picks || []).filter((p) => p.result && p.result !== "VOID").sort((a, b) => new Date(b.start) - new Date(a.start));
    const clv = r?.clv;
    const clvBlock = clv?.moved ? `<div class="kpi"><div class="k">Beat the later line</div><div class="v ${clv.rate >= 0.5 ? "pos" : "neg"}">${pct(clv.rate)} <small>${clv.beat}/${clv.moved}</small></div></div>` : "";
    const clvNote = `<p class="small muted" style="margin:8px 0 0"><b>Closing line value:</b> after a pick is posted, every later run checks the line again until the game starts. If the line moves our way (an over at 24.5 that later shows 25.5, a +3.5 that becomes +2.5), the market agreed with the pick. Beating the later line more than half the time is the quickest sign of a real edge, well before the win-loss record means anything.</p>`;
    if (!r || !(r.all.w + r.all.l)) {
      box.innerHTML = `<h3>Track record</h3>${clvBlock ? `<div class="kpis">${clvBlock}</div>` : ""}<div class="muted small">Every pick posted here is logged and graded automatically after the game. The record builds from the first day.</div>${clvNote}`;
      return;
    }
    const line = (lbl, x) => `<div class="kpi"><div class="k">${lbl}</div><div class="v">${x.w}-${x.l} <small class="${x.units >= 0 ? "pos" : "neg"}">${signed(x.units, 1)}u</small></div></div>`;
    const cal = (r.calibration || []).filter((b) => b.n);
    const clvCell = (p) => {
      const c = p.clv;
      if (!c || (c.pts === 0 && Math.abs(c.prob) < 0.005)) return `<span class="faint">—</span>`;
      const good = c.pts > 0 || (c.pts === 0 && c.prob > 0);
      return `<span class="${good ? "pos" : "neg"}">${c.pts ? signed(c.pts, 1) : signed(c.prob * 100, 1) + "%"}</span>`;
    };
    box.innerHTML = `<h3>Track record</h3>
      <div class="kpis">${line("Last 7 days", r.last7)}${line("Last 30 days", r.last30)}${line("All time", r.all)}
        ${["A", "B", "C"].map((g) => r.all.byGrade[g].w + r.all.byGrade[g].l ? line(`Grade ${g}`, r.all.byGrade[g]) : "").join("")}${clvBlock}</div>
      ${cal.length ? `<h3 style="margin-top:14px">Calibration</h3><div class="table-wrap"><table><thead><tr><th>Model said</th><th class="r">Picks</th><th class="r">Expected hit %</th><th class="r">Actual hit %</th></tr></thead><tbody>
        ${cal.map((b) => `<tr><td>${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%</td><td class="r">${b.n}</td><td class="r">${pct(b.predicted, 1)}</td><td class="r ${b.actual >= b.predicted - 0.03 ? "pos" : "neg"}">${pct(b.actual, 1)}</td></tr>`).join("")}
      </tbody></table></div><p class="small faint" style="margin:6px 0 0">Small samples swing a lot; read this after a few hundred picks.</p>` : ""}
      ${clvNote}
      <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Date</th><th>Pick</th><th class="r">Odds</th><th class="r">Grade</th><th class="r" title="Line movement after the pick">CLV</th><th class="r">Actual</th><th>Result</th></tr></thead><tbody>
        ${graded.slice(0, 25).map((p) => `<tr><td>${fmtDate(p.start)}</td><td>${esc(p.label)} <span class="faint">${esc(leagueName(p.league))}</span></td><td class="r">${M.fmtOdds(p.odds)}</td><td class="r">${esc(p.grade)}</td><td class="r">${clvCell(p)}</td><td class="r">${esc(p.actual ?? "")}</td><td class="${p.result === "W" ? "o" : p.result === "L" ? "u" : "p"}">${p.result}</td></tr>`).join("")}
      </tbody></table></div>`;
  }

  function renderAll() {
    persist();
    syncControls();
    renderTicket();
    renderMoon();
    renderPicks();
    renderMine();
  }

  // 🚀 Moonshot: the long-shot parlay with the best model chance of paying the target.
  function renderMoon() {
    const box = $("#t-moon");
    const leagues = sportLeagues();
    const pool = [...allLegs, ...allAlts].filter((l) => leagues.includes(l.league) && l.prob > 0 && l.odds != null && usableLeg(l) && !l.mismatch && !l.roleChange && (l.edge ?? 0) > -0.01 && l.odds >= -250);
    const m = pool.length ? buildMoonshot(pool, { stake: Number(state.moonStake), target: Number(state.moonTarget), perGame: Number(state.moonPerGame), exclude: moonExclude }) : null;
    const k$ = (x) => `$${x >= 1000 ? `${(x / 1000).toLocaleString("en-US")}k` : x}`;
    box.innerHTML = `<div class="row" style="justify-content:space-between"><h3 style="margin:0">🚀 Moonshot</h3><span class="small muted">a lottery ticket built from the model's best long-shot legs</span></div>
      <div class="row" style="margin-top:10px;gap:14px">
        <div><div class="small muted">Bet</div><div class="chips" id="t-moon-stake">${MOON_STAKES.map((x) => `<button class="chip ${Number(state.moonStake) === x ? "on" : ""}" data-v="${x}">$${x}</button>`).join("")}</div></div>
        <div><div class="small muted">To win</div><div class="chips" id="t-moon-target">${MOON_TARGETS.map((x) => `<button class="chip ${Number(state.moonTarget) === x ? "on" : ""}" data-v="${x}">${k$(x)}</button>`).join("")}</div></div>
        <label class="small muted row" style="gap:6px;cursor:pointer"><input type="checkbox" id="t-moon-pg" ${Number(state.moonPerGame) === 2 ? "checked" : ""}/> 2 legs per game</label>
      </div>
      ${!m ? `<div class="muted small" style="margin-top:10px">No legs to build with right now${pool.length ? "" : ` for ${esc(SPORTS.find((s) => s.id === state.sport).label)}`}. Try All sports, or check back when lines post.</div>` : `
      ${m.reached ? "" : `<div class="notice warn" style="margin-top:10px">Today's ${esc(SPORTS.find((s) => s.id === state.sport).label)} legs can't reach ${k$(Number(state.moonTarget))} on $${state.moonStake}. The biggest ticket available is below; try All sports, a bigger bet or a smaller target.</div>`}
      <div class="kpis" style="margin-top:10px">
        <div class="kpi"><div class="k">Odds</div><div class="v">${M.fmtOdds(m.american)}</div></div>
        <div class="kpi"><div class="k">$${state.moonStake} wins</div><div class="v pos">$${Math.round(m.payout).toLocaleString("en-US")}</div></div>
        <div class="kpi"><div class="k">Real chance (est.)</div><div class="v">1 in ${oneIn(m.prob)}</div></div>
      </div>
      <p class="small muted" style="margin:8px 0 0">${m.legs.length} legs · the book's price implies 1 in ${oneIn(1 / m.decimal)}${m.legs.some((l) => l.alt) ? " · includes DraftKings alt lines (X+)" : ""}. The estimate counts only half of each leg's model edge (a quarter for alt lines, and never more than 1.6× the book's own odds), because big edges are usually overstated and a parlay multiplies the error. Even built from the best legs, a moonshot almost always loses: play it with lottery-ticket money only.</p>
      ${m.legs.map((l) => legRow(l, { addable: false })).join("")}
      <div class="row" style="margin-top:10px"><button class="btn ghost sm" id="t-moon-again">🎲 Another combo</button><button class="btn sm" id="t-moon-save">★ Save moonshot</button></div>
      ${placeBet(m.legs, { stake: Number(state.moonStake), american: m.american, title: `${m.legs.length}-leg moonshot` })}`}`;
    if (!m) return;
    $("#t-moon-again").onclick = () => {
      // Swap out one of the current legs at random for a different ticket.
      const pickOne = m.legs[Math.floor(Math.random() * m.legs.length)];
      moonExclude = [...moonExclude, pickOne.id].slice(-Math.max(3, Math.floor(pool.length / 4)));
      renderMoon();
    };
    $("#t-moon-save").onclick = () => {
      if (!saveTicket("parlay", m.legs, Number(state.moonStake), m.american, { prob: m.prob, kind: "moonshot" })) return;
      toast("Moonshot saved · track it live under ★ My bets");
    };
  }

  // Events
  $("#t-root").addEventListener("click", (e) => {
    const ms = e.target.closest("#t-moon-stake .chip"), mt = e.target.closest("#t-moon-target .chip");
    if (ms || mt) { if (ms) state.moonStake = Number(ms.dataset.v); if (mt) state.moonTarget = Number(mt.dataset.v); moonExclude = []; persist(); renderMoon(); return; }
    if (e.target.id === "t-moon-pg") { state.moonPerGame = e.target.checked ? 2 : 1; moonExclude = []; persist(); renderMoon(); return; }
    const s = e.target.closest("#t-sport .chip");
    if (s) { state.sport = s.dataset.s; state.sgpGame = null; state.sgpLegs = null; renderAll(); renderSgp(); return; }
    const b = e.target.closest("#t-budget .chip, #t-bank .chip");
    if (b) { state.budget = Number(b.dataset.b); $("#t-custom").value = ""; renderAll(); renderSgp(); return; }
    const m = e.target.closest("#t-mode button");
    if (m) { state.mode = m.dataset.m; renderAll(); return; }
    const n = e.target.closest("#t-legs button");
    if (n) { state.legs = Number(n.dataset.n); $("#t-legs-custom").value = ""; renderAll(); renderSgp(); return; }
    if (e.target.closest("[data-bank]")) { openBankrollSettings(() => { if (ctx.alive()) renderAll(); }); return; }
    const add = e.target.closest("[data-add]");
    if (add) {
      const id = add.dataset.add;
      state.mine = state.mine.includes(id) ? state.mine.filter((x) => x !== id) : [...state.mine, id];
      renderAll();
      if (state.sgpLegs) renderSgp();
    }
  });
  $("#t-custom").addEventListener("input", (e) => { const v = Number(e.target.value); if (v >= 1) { state.budget = v; renderAll(); } });
  $("#t-legs-custom").addEventListener("input", (e) => { const v = Math.round(Number(e.target.value)); if (v >= 2 && v <= 15) { state.legs = v; renderAll(); renderSgp(); } });

  renderAll();
  renderSgp();
  renderRecord();
  if (q.focus === "moon") $("#t-moon").scrollIntoView({ block: "start" });
}

// Compact "today" teaser for the home page.
export async function todayTeaser() {
  const today = await getData("data/picks/today.json");
  if (!today) return "";
  const now = Date.now();
  const legs = (today.legs || []).filter((l) => new Date(l.start) > now);
  const picks = choosePicks(legs, 4);
  if (!picks.length) return "";
  return `<div class="card">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">🔥 Today's top picks</h2><a class="btn sm" href="#/today">Build my ticket ›</a></div>
    <div style="margin-top:6px">${picks.map((l) => `<a class="tp-row" href="#/today"><span class="gbadge ${esc(l.grade)}">${esc(l.grade)}</span><span class="tp-text"><b>${esc(l.label)}</b><span class="muted small">${M.fmtOdds(l.odds)} · ${esc(leagueName(l.league))} · ${fmtTime(l.start)}</span></span></a>`).join("")}</div>
  </div>`;
}
