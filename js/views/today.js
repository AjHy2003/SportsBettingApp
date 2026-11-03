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
import { planTicket, combine, compatible, choosePicks, bestSameGame, usableLeg, bestParlay, isBestBet, wasBestBet } from "../parlay.js";
import { timeAgo } from "../news.js";
import { placeBet } from "../sportsbooks.js";
import { buildMoonshot, oneIn } from "../moonshot.js";
import { moveText } from "../movement.js";
import { bankroll, bankrollOk, suggestedBudget, spend, openBankrollSettings, bankrollMoney } from "../bankroll.js";
import { toPick } from "../slip.js";
import { repriceProp, repriceGame, currentGameLines, currentProps } from "../reprice.js";

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
// Calendar day on this device, e.g. "2026-11-01".
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };

export async function renderToday(ctx, q) {
  const { app } = ctx;
  setTitle("Today's picks");
  app.innerHTML = loading("Loading today's picks…");
  const [today, history, audit] = await Promise.all([getData("data/picks/today.json"), getData("data/picks/history.json"), getData("data/audit.json")]);
  if (!ctx.alive()) return;

  const prefs = { sport: "all", budget: 10, mode: "mix", legs: 3, moonStake: 10, moonTarget: 10000, moonPerGame: 1, aOnly: true, style: "prob", ...loadPrefs() };
  if (q.sport) prefs.sport = q.sport;
  if (q.focus === "moon") Object.assign(prefs, { moonStake: 10, moonTarget: 10000 });
  // days: null = today (or the next day with games for this sport), "all", or one day's key.
  // offGames: games switched off in the game picker.
  const state = { ...prefs, mine: [], sgpGame: q.sgp || null, sgpLegs: null, sgpPicked: [], days: q.day || null, offGames: new Set() };
  // How each grade has actually done (every graded leg the app showed), for the A-only switch.
  const gradeRec = (() => {
    const b = today?.tracked?.byGrade;
    const f = (g) => (b?.[g] && b[g].w + b[g].l ? `${g} ${b[g].w}-${b[g].l}` : null);
    const parts = ["A", "B"].map(f).filter(Boolean);
    return parts.length ? `so far ${parts.join(" · ")}` : "";
  })();
  const now = Date.now();
  const todayKey = dayKey(now), tomorrowKey = dayKey(now + 864e5);
  const allLegs = (today?.legs || []).filter((l) => new Date(l.start) > now);
  const games = (today?.games || []).filter((g) => new Date(g.start) > now);
  const legById = new Map([...(today?.legs || []), ...(today?.alts || [])].map((l) => [l.id, l]));
  const allAlts = (today?.alts || []).filter((l) => new Date(l.start) > now);
  let moonExclude = [];
  // Legs handed over from a shared slip ("Edit in parlay builder").
  try {
    const handed = JSON.parse(sessionStorage.getItem("picklab.mine") || "[]");
    sessionStorage.removeItem("picklab.mine");
    state.mine = handed.filter((id) => legById.has(id));
  } catch { /* ignore */ }

  const stale = today && today.date !== new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replaceAll("-", "");
  const rec = today?.record?.last30;

  app.innerHTML = `<div id="t-root">
    <div class="crumbs"><a href="#/">Home</a> › Today</div>
    <div class="row" style="justify-content:space-between">
      <h1>🔥 Today's picks</h1>
      <div class="small muted">${today ? `Updated ${fmtDate(today.generated, { weekday: "short", month: "short", day: "numeric" })} ${fmtTime(today.generated)}${stale ? ` · <span class="neg">not refreshed today yet</span>` : ""}${today.books ? ` · game lines checked across every major book at ${fmtTime(today.books.fetchedAt)}` : ""} · <a href="#/trends">📈 Trends</a> · <a href="#/live">📡 Live</a>` : ""}${rec && rec.w + rec.l ? ` · Last 30 days <b>${rec.w}-${rec.l}</b> <span class="${rec.units >= 0 ? "pos" : "neg"}">${signed(rec.units, 1)}u</span>` : ""}</div>
    </div>
    ${today ? `<div class="live-bar" id="t-live"></div><div id="t-live-changes"></div>` : ""}
    <a class="check-cta" href="#/check">🔎 <b>Betting at FanDuel or another book?</b> <span class="muted">Check your slip at their exact lines and prices ›</span></a>
    ${today ? "" : `<div class="notice warn" style="margin-bottom:14px">Daily picks are generated on GitHub every 30 minutes through the day. They'll show here after the next run. You can still build a same-game parlay for any game below.</div>`}
    <div class="card">
      <h3>Sport</h3>
      <div class="chips scroll" id="t-sport">${SPORTS.map((s) => `<button class="chip" data-s="${s.id}">${s.label}</button>`).join("")}</div>
      <h3 style="margin-top:12px">Day</h3>
      <div class="chips scroll" id="t-day"></div>
      <div class="small muted" id="t-day-note" style="margin-top:6px"></div>
      <details class="gamepick" id="t-games-d"><summary id="t-games-sum"></summary><div id="t-games"></div></details>
      <div class="grid two" style="margin-top:12px;gap:12px">
        <div><h3>Budget</h3><div class="row"><div class="chips" id="t-budget">${BUDGETS.map((b) => `<button class="chip" data-b="${b}">$${b}</button>`).join("")}</div>
          <div class="field" style="width:92px"><input id="t-custom" type="number" min="1" step="1" placeholder="Custom" inputmode="numeric"/></div></div>
          <div class="small muted" id="t-bank" style="margin-top:6px"></div></div>
        <div><h3>Build</h3><div class="row"><div class="seg" id="t-mode"><button data-m="singles">Straight bets</button><button data-m="parlay">Parlay</button><button data-m="mix">Mix</button></div>
          <div class="seg" id="t-legs">${LEG_COUNTS.map((n) => `<button data-n="${n}">${n} legs</button>`).join("")}</div>
          <div class="field" id="t-legs-custom-f" style="width:84px"><input id="t-legs-custom" type="number" min="2" max="15" step="1" placeholder="Legs" inputmode="numeric" title="Any number of legs, 2-15"/></div></div>
          <div class="row" id="t-style-row" style="margin-top:8px"><span class="small muted">Parlay legs</span><div class="seg" id="t-style"><button data-st="prob" title="The legs with the best chance to hit (that still have an edge)">Most likely to hit</button><button data-st="edge" title="The legs with the biggest edge: bigger payouts, hits less often">Best value</button></div></div>
          <label class="small muted row" style="gap:6px;margin-top:8px;cursor:pointer"><input type="checkbox" id="t-aonly"/> Grade A picks only${gradeRec ? ` <span class="faint">(${gradeRec})</span>` : ""}</label></div>
      </div>
    </div>
    <div class="card best" style="margin-top:14px" id="t-best"></div>
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
        <li>Every day in the late morning (ET) you'll get the top picks and the day's basketball and football parlays, with a link back here.</li>
      </ol>
    </div>
    <p class="small faint" style="margin-top:14px">Stakes use a quarter-Kelly split weighted by edge. Parlay odds multiply the legs' prices; a same-game parlay's real price at the book will differ because books adjust for correlated legs. Every leg's probability is a model estimate. Parlays compound both the edge and the error, so keep them small.</p></div>`;

  const $ = (s) => app.querySelector(s);
  const sportLeagues = () => SPORTS.find((s) => s.id === state.sport)?.leagues || SPORTS[0].leagues;
  const sportLabel = () => SPORTS.find((s) => s.id === state.sport).label;

  // Upcoming games for the chosen sport (from the games list, plus any only known from a leg).
  function sportGames() {
    const m = new Map();
    for (const g of games) if (sportLeagues().includes(g.league)) m.set(g.key, { key: g.key, league: g.league, matchup: g.matchup, start: g.start });
    for (const l of allLegs) if (!m.has(l.gameKey) && sportLeagues().includes(l.league)) m.set(l.gameKey, { key: l.gameKey, league: l.league, matchup: l.matchup, start: l.start });
    return [...m.values()].sort((a, b) => new Date(a.start) - new Date(b.start));
  }
  const sportDays = () => [...new Set(sportGames().map((g) => dayKey(g.start)))].sort();
  // The days in play. Today by default; when this sport has nothing today, the next day it does.
  function activeDays() {
    const avail = sportDays();
    if (state.days === "all") return { days: avail, moved: false };
    const want = state.days || todayKey;
    if (avail.includes(want)) return { days: [want], moved: false };
    return { days: avail.slice(0, 1), moved: avail.length > 0 };
  }
  const dayName = (k, long = false) => {
    if (k === todayKey) return "Today";
    if (k === tomorrowKey) return "Tomorrow";
    const [y, mo, d] = k.split("-").map(Number);
    return new Date(y, mo - 1, d).toLocaleDateString("en-US", long ? { weekday: "long", month: "short", day: "numeric" } : { weekday: "short", month: "numeric", day: "numeric" });
  };
  const scopeLabel = () => {
    const { days } = activeDays();
    return `${state.sport === "all" ? "All sports" : sportLabel()} · ${state.days === "all" ? "all days" : days.length ? dayName(days[0]) : "today"}`;
  };
  const dayGames = () => { const { days } = activeDays(); return sportGames().filter((g) => days.includes(dayKey(g.start))); };
  const inScope = (l) => new Date(l.start) > Date.now() && sportLeagues().includes(l.league) && activeDays().days.includes(dayKey(l.start)) && !state.offGames.has(l.gameKey);
  const legsInSport = () => allLegs.filter(inScope);

  function persist() {
    savePrefs({ sport: state.sport, budget: state.budget, mode: state.mode, legs: state.legs, moonStake: state.moonStake, moonTarget: state.moonTarget, moonPerGame: state.moonPerGame, aOnly: state.aOnly, style: state.style });
  }

  function renderDays() {
    const avail = sportDays(), { days, moved } = activeDays();
    const count = (k) => sportGames().filter((g) => dayKey(g.start) === k).length;
    $("#t-day").innerHTML = avail.length
      ? `${avail.map((k) => `<button class="chip ${state.days !== "all" && days.includes(k) ? "on" : ""}" data-d="${k}">${dayName(k)} <span class="cnt">${count(k)}</span></button>`).join("")}${avail.length > 1 ? `<button class="chip ${state.days === "all" ? "on" : ""}" data-d="all">All days</button>` : ""}`
      : `<span class="small muted">No upcoming ${esc(sportLabel())} games in today's file.</span>`;
    $("#t-day-note").innerHTML = moved ? `No ${esc(sportLabel())} games ${state.days && state.days !== todayKey ? `on ${esc(dayName(state.days))}` : "today"}, so this shows <b>${esc(dayName(days[0], true))}</b>.` : "";
    // Game picker: every game on the chosen day(s), all on by default.
    const list = dayGames();
    const on = list.filter((g) => !state.offGames.has(g.key)).length;
    $("#t-games-d").classList.toggle("hidden", !list.length);
    $("#t-games-sum").innerHTML = `🎯 Games: <b>${on === list.length ? `all ${list.length}` : `${on} of ${list.length}`}</b> <span class="muted">· choose which games to build from</span>`;
    $("#t-games").innerHTML = `<div class="row" style="margin:8px 0 6px;gap:6px"><button class="btn ghost sm" data-gall="1">All</button><button class="btn ghost sm" data-gall="0">None</button><span class="small faint">Tickets, parlays, picks and the moonshot only use the games you leave on.</span></div>
      <div class="chips">${list.map((g) => `<button class="chip gchip ${state.offGames.has(g.key) ? "" : "on"}" data-g="${esc(g.key)}">${esc(g.matchup)} <span class="cnt">${state.days === "all" ? `${fmtDate(g.start, { weekday: "short" })} ` : ""}${fmtTime(g.start)}${sportLeagues().length > 1 ? ` · ${esc(leagueName(g.league))}` : ""}</span></button>`).join("")}</div>`;
  }

  function syncControls() {
    renderDays();
    app.querySelectorAll("#t-sport .chip").forEach((b) => b.classList.toggle("on", b.dataset.s === state.sport));
    app.querySelectorAll("#t-budget .chip").forEach((b) => b.classList.toggle("on", Number(b.dataset.b) === Number(state.budget)));
    app.querySelectorAll("#t-mode button").forEach((b) => b.classList.toggle("on", b.dataset.m === state.mode));
    app.querySelectorAll("#t-legs button").forEach((b) => b.classList.toggle("on", Number(b.dataset.n) === Number(state.legs)));
    $("#t-aonly").checked = !!state.aOnly;
    app.querySelectorAll("#t-style button").forEach((b) => b.classList.toggle("on", b.dataset.st === state.style));
    $("#t-style-row").classList.toggle("hidden", state.mode === "singles");
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

  // What the live re-check changed on a leg since the posted scan.
  function liveLine(l) {
    const lv = l.live;
    if (lv.far) return `<div class="small" style="color:var(--gold)">🔄 DraftKings moved this to ${esc(String(lv.farLine))} (posted ${esc(String(lv.line0))}), past what the live re-check can re-price. It's out of tickets until the next full scan.</div>`;
    if (lv.side0 && l.side !== lv.side0) return `<div class="small live-chg">🔄 <b>Switched:</b> posted as ${esc(lv.label0)} ${M.fmtOdds(lv.odds0)}; DraftKings moved the line through the model's number, so the pick is now <b>${esc(l.label)} ${M.fmtOdds(l.odds)}</b> · ${pct(l.prob)} to hit${lv.grade0 !== l.grade ? ` · was grade ${lv.grade0}` : ""}</div>`;
    const moved = lv.line0 !== l.line || lv.odds0 !== l.odds;
    if (!moved && lv.grade0 === l.grade) return "";
    const ln = (x) => (x == null ? "" : `${x} `);
    return `<div class="small live-chg">🔄 Now ${ln(l.kind === "spread" || l.kind === "ml" ? null : l.line)}${M.fmtOdds(l.odds)}${moved ? ` (posted ${ln(l.kind === "spread" || l.kind === "ml" ? null : lv.line0)}${M.fmtOdds(lv.odds0)}${l.kind === "spread" && lv.label0 !== l.label ? `, ${esc(lv.label0)}` : ""})` : ""} · ${pct(lv.prob0)} → ${pct(l.prob)}${lv.grade0 !== l.grade ? ` · was ${lv.grade0 === "PASS" ? "a pass" : `grade ${lv.grade0}`}` : ""}</div>`;
  }

  function legRow(l, { addable = true, inMine = false } = {}) {
    return `<div class="pick" style="display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)">
      <div class="grade ${l.grade}" style="width:40px;height:40px;font-size:17px;border-radius:11px;position:relative">${l.grade === "PASS" ? "—" : l.grade}${isBestBet(l) ? `<span class="star" title="⭐ Best bet: grade A, 10%+ edge, line not moving against it">⭐</span>` : ""}</div>
      <div style="min-width:0">
        <div style="font-weight:700"><a href="${legLink(l)}" style="color:var(--text)">${esc(l.label)}</a> <span class="muted" style="font-weight:600">${priceTag(l)}</span></div>
        <div class="small muted">${esc(leagueName(l.league))} · ${esc(l.matchup)} · ${fmtDate(l.start, { weekday: "short" })} ${fmtTime(l.start)}</div>
        <div class="small faint">${pct(l.prob)} to hit vs ${pct(M.impliedProb(l.odds), 1)} break-even · edge ${signed(l.edge * 100, 1)}${l.why && !(l.live?.side0 && l.side !== l.live.side0) ? ` · ${esc(l.why)}` : ""}</div>
        ${l.live ? liveLine(l) : ""}
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
      <div class="small muted" style="margin-top:6px">Model: ${pct(b.prob, b.prob < 0.1 ? 1 : 0)} to hit${b.type !== "single" ? ` (about ${b.prob >= 0.5 ? `${Math.round(b.prob * 10)} in 10` : `1 in ${Math.max(2, Math.round(1 / b.prob))}`})` : ""} · expected ${signed(b.expected, 2)} on ${money(b.stake)}</div>
      ${placeBet(b.legs, { stake: b.stake, american: b.american, title: label })}
    </div>`;
  }

  // Picks the tickets and the top-picks list use: graded legs, A only when that's switched on.
  const gradeOk = (l) => l.lean && l.grade !== "PASS" && (!state.aOnly || l.grade === "A");
  // Props without real DraftKings prices are research only (see parlay.js usableLeg).
  function researchOnlyNote() {
    const n = legsInSport().filter((l) => l.kind === "prop" && l.priced === false && l.lean).length;
    return n ? `<div class="notice" style="margin-top:10px">${n} ${esc(scopeLabel().split(" · ")[0])} player prop${n === 1 ? "" : "s"} left out: DraftKings' prices for NFL and college football props aren't available, and judged at an assumed −110 they went 15-31. They're research only (open a player to see the analysis); spreads, totals and moneylines still count.</div>` : "";
  }

  function renderTicket() {
    const legs = legsInSport().filter(gradeOk);
    const t = planTicket(legs, state.budget, state.mode, state.legs, { style: state.style });
    const box = $("#t-ticket");
    if (!t.bets.length) {
      const none = dayGames().length && dayGames().every((g) => state.offGames.has(g.key));
      box.innerHTML = `<h3>Your ${money(state.budget)} ticket</h3><div class="muted">${none ? "No games picked. Open 🎯 Games above and switch some on." : `No ${state.aOnly ? "grade A " : ""}${esc(scopeLabel())} picks with an edge right now${legsInSport().length ? "" : " (no lines posted yet)"}. ${state.aOnly && legsInSport().some((l) => l.lean && ["B", "C"].includes(l.grade)) ? `There are B and C picks: untick <b>Grade A picks only</b> to use them${gradeRec ? ` (${gradeRec})` : ""}. ` : ""}Try another day or sport, or build a same-game parlay below.`}</div>${researchOnlyNote()}`;
      return;
    }
    const oneGame = new Set(legs.map((l) => l.gameKey)).size === 1 ? legs[0].matchup : null;
    box.innerHTML = `<div class="row" style="justify-content:space-between"><h3 style="margin:0">Your ${money(state.budget)} ticket <span class="faint" style="text-transform:none;letter-spacing:0">· ${esc(oneGame || scopeLabel())}</span></h3>
      <div class="row"><button class="btn ghost sm" id="t-copy">Copy</button><button class="btn sm" id="t-save">★ Save all</button></div></div>
      <div class="kpis">
        <div class="kpi"><div class="k">Total stake</div><div class="v">${money(t.totals.stake)}</div></div>
        <div class="kpi"><div class="k">If everything hits</div><div class="v pos">${money(t.totals.maxReturn)}</div></div>
        <div class="kpi"><div class="k">Model expectation</div><div class="v ${t.totals.expectedProfit >= 0 ? "pos" : "neg"}">${signed(t.totals.expectedProfit, 2)}</div></div>
      </div>
      ${t.bets.some((b) => b.type !== "single" && b.legs.length < Number(state.legs)) ? `<div class="notice" style="margin-top:10px">Only ${t.bets.find((b) => b.type !== "single").legs.length} legs have an edge right now, so the parlay is ${t.bets.find((b) => b.type !== "single").legs.length} legs instead of ${state.legs}. Add your own with + to go longer.</div>` : ""}
      ${oneGame && t.bets.some((b) => b.type === "sgp") ? `<div class="notice" style="margin-top:10px">${dayGames().filter((g) => !state.offGames.has(g.key)).length > 1 ? `Every pick with an edge here comes from one game (${esc(oneGame)})` : `Only one game is in play (${esc(oneGame)})`}, so the parlay is a same-game parlay. Pick another day or more games for a regular parlay.</div>` : ""}
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

  const saveLeg = (l, extra = {}) => addPick({ ...toPick(l), ...extra });

  // Save a bet as a ticket (tracked live under ★ My bets) and its legs as picks.
  function saveTicket(type, legs, stake, american, { skipCheck = false, ...extra } = {}) {
    if (!skipCheck && !bankrollOk(stake)) return null;
    const id = addTicket({ type, stake, american, toWin: stake * M.payout(american), prob: extra.prob ?? legs.reduce((p, l) => p * (l.prob || 0.5), 1), ...extra, legs: legs.map(toPick) });
    for (const l of legs) saveLeg(l, { ticketId: id });
    return id;
  }

  function renderPicks() {
    const picks = choosePicks(legsInSport().filter(gradeOk), 15);
    const box = $("#t-picks");
    box.innerHTML = `<h3>Top picks · ${esc(scopeLabel())}${state.aOnly ? " · grade A" : ""}</h3>
      ${picks.length ? picks.map((l) => legRow(l, { inMine: state.mine.includes(l.id) })).join("") : `<div class="muted small">Nothing clears the bar right now. That happens; passing is a pick too.</div>`}
      ${researchOnlyNote()}
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
    const sgpGames = dayGames();
    const options = sgpGames.map((g) => `<option value="${g.key}" ${state.sgpGame === g.key ? "selected" : ""}>${esc(leagueName(g.league))} · ${esc(g.matchup)} · ${fmtDate(g.start, { weekday: "short" })} ${fmtTime(g.start)}</option>`).join("");
    const extra = state.sgpGame && !sgpGames.some((g) => g.key === state.sgpGame) ? `<option value="${esc(state.sgpGame)}" selected>Selected game</option>` : "";
    box.innerHTML = `<h3>Same-game parlay</h3>
      <div class="field"><select id="t-sgp-game"><option value="">Pick a game…</option>${extra}${options}</select></div>
      <div id="t-sgp-body" style="margin-top:8px">${sgpGames.length || extra ? `<div class="muted small">Choose a game to see every leg the model likes, then auto-build or pick your own.</div>` : `<div class="muted small">No upcoming ${esc(scopeLabel())} games in today's file. Open any game page and tap <b>Build a same-game parlay</b>.</div>`}</div>`;
    $("#t-sgp-game").onchange = (e) => { state.sgpGame = e.target.value || null; state.sgpLegs = null; renderSgp(); };
    if (!state.sgpGame) {
      // Featured: the model's best 3-leg same-game parlays from this morning's run.
      const feats = (today?.sgps || []).filter((x) => sportLeagues().includes(x.league) && x.legs.every((id) => legById.has(id)) && new Date(legById.get(x.legs[0]).start) > now && activeDays().days.includes(dayKey(legById.get(x.legs[0]).start)) && (!state.aOnly || x.legs.every((id) => legById.get(id).grade === "A"))).slice(0, 5);
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
    const best = bestSameGame(legs.filter((l) => l.lean && (!state.aOnly || l.grade === "A")), state.sgpGame, Math.min(state.legs, 4));
    body.innerHTML = `${best ? `<div style="border:1px solid var(--line);border-radius:12px;padding:12px">
        <div class="row" style="justify-content:space-between"><b>Model's best ${best.legs.length}-leg SGP</b><span>${M.fmtOdds(best.american)} · ${money(state.budget)} pays <b class="pos">${money(state.budget * best.decimal)}</b></span></div>
        <div class="small" style="margin-top:6px">${best.legs.map((l) => `• ${esc(l.label)} ${M.fmtOdds(l.odds)}`).join("<br/>")}</div>
        <div class="small muted" style="margin-top:6px">Model: ${pct(best.prob, 1)} to hit (treats legs as independent) · <button class="btn ghost sm" id="t-sgp-use">Use these legs</button></div>
        <div class="small faint" style="margin-top:4px">Books price same-game parlays below the legs' separate odds (they know the legs move together), so the payout is usually smaller than the line above.</div></div>` : `<div class="muted small">Not enough ${state.aOnly ? "grade A " : "graded "}legs in this game for a same-game parlay${state.aOnly ? ". Untick <b>Grade A picks only</b> to use B and C legs" : ""}. Skipping is fine.</div>`}
      <div style="margin-top:8px">${legs.slice(0, 25).map((l) => legRow(l, { inMine: state.mine.includes(l.id) })).join("")}</div>`;
    $("#t-sgp-use")?.addEventListener("click", () => { state.mine = best.legs.map((l) => l.id); renderAll(); });
  }

  // Every graded leg the app showed (not just the top picks), graded after the games.
  function trackedBlock() {
    const t = today?.tracked;
    const n = t ? ["A", "B", "C"].reduce((s, g) => s + t.byGrade[g].w + t.byGrade[g].l, 0) + t.alt.w + t.alt.l : 0;
    if (!t || !n) return t ? `<p class="small muted" style="margin:12px 0 0">📋 From now on, every A, B and C leg the app shows (tickets, same-game parlays, top picks) and the moonshots' long shots are graded too, so this record covers everything you can take from the app.</p>` : "";
    const cell = (x) => (x.w + x.l ? `${x.w}-${x.l} <span class="${x.units >= 0 ? "pos" : "neg"}">${signed(x.units, 1)}u</span>` : "—");
    return `<h3 style="margin-top:14px">📋 Every leg the app graded</h3>
      <p class="small muted" style="margin:0 0 6px">Not just the top picks: every A, B and C leg shown in tickets, same-game parlays and pick lists${t.since ? ` since ${fmtDate(t.since)}` : ""}, graded after the games.</p>
      <div class="kpis" style="margin-top:0">${["A", "B", "C"].map((g) => `<div class="kpi"><div class="k">Grade ${g}</div><div class="v" style="font-size:16px">${cell(t.byGrade[g])}</div></div>`).join("")}
        <div class="kpi"><div class="k">Moonshot long shots</div><div class="v" style="font-size:16px">${cell(t.alt)}</div></div></div>`;
  }

  // What the model has learned from its graded picks, per league and bet type.
  // This morning's data audit: prop names, game lines, and grades vs box scores.
  function auditLine() {
    if (!audit?.grading) return "";
    const n = audit.issues?.filter((i) => i.area !== "lines" || !/nhl/.test(i.msg)).length || 0;
    return `<p class="small ${n ? "neg" : "muted"}" style="margin:8px 0 0">🔎 Data checks (this morning): ${audit.grading.agree}/${audit.grading.checked} recent grades match the official box scores · every DraftKings prop name mapped to one market · spreads and totals line up${n ? ` · <b>${n} issue${n === 1 ? "" : "s"} flagged</b>: ${esc(audit.issues.map((i) => i.msg).join("; ").slice(0, 300))}` : ""}.</p>`;
  }

  function learnBlock() {
    const L = today?.learn || {};
    // League rows biggest first, each league's props followed by its overs and unders.
    const top = Object.entries(L).filter(([g, x]) => x.n >= 5 && g.split(":").length === 2).sort((a, b) => b[1].n - a[1].n);
    const rows = top.flatMap(([g, x]) => [[g, x], ...["over", "under"].map((s) => [`${g}:${s}`, L[`${g}:${s}`]]).filter(([, y]) => y && y.n >= 5)]);
    if (!rows.length) return auditLine();
    const name = (g) => {
      const [lg, kind, side] = g.split(":");
      if (side) return `<span style="padding-left:14px">${side === "over" ? "Overs" : "Unders"}</span>`;
      return `${esc(leagueName(lg))} ${kind === "prop" ? "props" : "game lines"}${(lg === "nfl" || lg === "ncaaf") && kind === "prop" ? ` <span class="faint small">(research only now)</span>` : ""}`;
    };
    return `<h3 style="margin-top:14px">📏 Learning from results</h3>
      <p class="small muted" style="margin:0 0 6px">Every scan compares what the picks claimed with what actually hit, and keeps only the share of each edge that has shown up (pulled toward "all of it" until there are enough results). Overs and unders are learned separately. A player's legs from one game count as one result, so one huge night can't swing everything. Fewer, stronger picks where the model has been too confident.</p>
      <div class="table-wrap"><table><thead><tr><th>Picks</th><th class="r">Record</th><th class="r">Model said</th><th class="r" title="Each player-game counted once">Hit</th><th class="r">Break-even</th><th class="r">Edges kept</th></tr></thead><tbody>
      ${rows.map(([g, x]) => `<tr><td>${name(g)}</td><td class="r">${x.w}-${x.n - x.w}${x.ne ? ` <span class="faint small" title="Player-games (games, for game lines)">· ${Math.round(x.ne)}</span>` : ""}</td><td class="r">${pct(x.model)}</td><td class="r ${x.hit >= x.be ? "pos" : "neg"}">${pct(x.hit)}</td><td class="r">${pct(x.be)}</td><td class="r"><b>${Math.round(x.k * 100)}%</b></td></tr>`).join("")}
      </tbody></table></div><p class="small faint" style="margin:4px 0 0">Record counts every leg; the small number is how many separate player-games (games, for game lines) those were, and Hit counts each of those once.</p>${auditLine()}`;
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
      ${learnBlock()}
      ${trackedBlock()}
      ${clvNote}
      <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Date</th><th>Pick</th><th class="r">Odds</th><th class="r">Grade</th><th class="r" title="Line movement after the pick">CLV</th><th class="r">Actual</th><th>Result</th></tr></thead><tbody>
        ${graded.slice(0, 25).map((p) => `<tr><td>${fmtDate(p.start)}</td><td>${esc(p.label)} <span class="faint">${esc(leagueName(p.league))}</span></td><td class="r">${M.fmtOdds(p.odds)}</td><td class="r">${esc(p.grade)}</td><td class="r">${clvCell(p)}</td><td class="r">${esc(p.actual ?? "")}</td><td class="${p.result === "W" ? "o" : p.result === "L" ? "u" : "p"}">${p.result}</td></tr>`).join("")}
      </tbody></table></div>`;
  }

  // ⭐ Best bets: the picks to follow, their running record, and a 2-leg parlay of the top two.
  function renderBest() {
    const box = $("#t-best");
    const best = choosePicks(legsInSport().filter(isBestBet), 8);
    const past = (history?.picks || []).filter((p) => (p.result === "W" || p.result === "L") && (p.best || wasBestBet(p)));
    const w = past.filter((p) => p.result === "W").length, units = past.reduce((u, p) => u + (p.result === "W" ? M.payout(p.odds ?? -110) : -1), 0);
    const rec = past.length ? `<span class="pill ${units >= 0 ? "pos" : "neg"}" title="Graded picks that met the best-bet bar">so far ${w}-${past.length - w} · ${signed(units, 1)}u</span>` : "";
    if (!best.length) {
      box.innerHTML = `<div class="row" style="justify-content:space-between"><h3 style="margin:0">⭐ Best bets · ${esc(scopeLabel())}</h3>${rec}</div><div class="muted small" style="margin-top:6px">None right now: no grade A pick here has a 10%+ edge with the line holding. That's normal on some days; it's better to skip than to force it.</div>`;
      return;
    }
    const two = best.length >= 2 ? bestParlay(best, 2, { by: "prob" }) : null;
    box.innerHTML = `<div class="row" style="justify-content:space-between"><h3 style="margin:0">⭐ Best bets · ${esc(scopeLabel())}</h3>${rec}</div>
      <p class="small muted" style="margin:6px 0 0">The picks to follow: grade A, a 10%+ edge, and the line not moving against them (re-checked live). Bet them straight; if you parlay, keep it to two.</p>
      ${best.map((l) => legRow(l, { inMine: state.mine.includes(l.id) })).join("")}
      ${two ? `<div style="border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:10px">
        <div class="row" style="justify-content:space-between"><b>Best-bets 2-leg parlay</b><span>${M.fmtOdds(two.american)} · ${money(state.budget)} pays <b class="pos">${money(state.budget * two.decimal)}</b></span></div>
        <div class="small" style="margin-top:4px">${two.legs.map((l) => `• ${esc(l.label)} ${M.fmtOdds(l.odds)}`).join("<br/>")}</div>
        <div class="small muted" style="margin-top:6px">Model: ${pct(two.prob, 0)} to hit (about ${two.prob >= 0.5 ? `${Math.round(two.prob * 10)} in 10` : `1 in ${Math.max(2, Math.round(1 / two.prob))}`}). ${(() => { const third = best.find((l) => !two.legs.includes(l) && two.legs.every((x) => compatible(x, l))); return third ? `Adding ${esc(third.label)} would cut that to ${pct(two.prob * third.prob, 0)}.` : ""; })()}</div>
        <div class="row" style="margin-top:8px"><button class="btn ghost sm" id="t-best-mine">+ Use in my parlay</button><button class="btn sm" id="t-best-save">★ Save parlay</button></div>
        ${placeBet(two.legs, { stake: Number(state.budget) || 10, american: two.american, title: "Best-bets 2-leg parlay" })}</div>` : ""}`;
    $("#t-best-mine")?.addEventListener("click", () => { state.mine = two.legs.map((l) => l.id); renderAll(); });
    $("#t-best-save")?.addEventListener("click", () => {
      if (!saveTicket("parlay", two.legs, Number(state.budget) || 10, two.american, { prob: two.prob, kind: "best" })) return;
      toast("Saved · track it live under ★ My bets");
    });
  }

  function renderAll() {
    persist();
    if (lastLive) paintChanges();
    syncControls();
    renderBest();
    renderTicket();
    renderMoon();
    renderPicks();
    renderMine();
  }

  // 🚀 Moonshot: the long-shot parlay with the best model chance of paying the target.
  function renderMoon() {
    const box = $("#t-moon");
    const pool = [...allLegs, ...allAlts].filter((l) => inScope(l) && l.prob > 0 && l.odds != null && usableLeg(l) && !l.mismatch && !l.roleChange && (l.edge ?? 0) > -0.01 && l.odds >= -250);
    const m = pool.length ? buildMoonshot(pool, { stake: Number(state.moonStake), target: Number(state.moonTarget), perGame: Number(state.moonPerGame), exclude: moonExclude }) : null;
    const k$ = (x) => `$${x >= 1000 ? `${(x / 1000).toLocaleString("en-US")}k` : x}`;
    box.innerHTML = `<div class="row" style="justify-content:space-between"><h3 style="margin:0">🚀 Moonshot</h3><span class="small muted">a lottery ticket built from the model's best long-shot legs</span></div>
      <div class="row" style="margin-top:10px;gap:14px">
        <div><div class="small muted">Bet</div><div class="chips" id="t-moon-stake">${MOON_STAKES.map((x) => `<button class="chip ${Number(state.moonStake) === x ? "on" : ""}" data-v="${x}">$${x}</button>`).join("")}</div></div>
        <div><div class="small muted">To win</div><div class="chips" id="t-moon-target">${MOON_TARGETS.map((x) => `<button class="chip ${Number(state.moonTarget) === x ? "on" : ""}" data-v="${x}">${k$(x)}</button>`).join("")}</div></div>
        <label class="small muted row" style="gap:6px;cursor:pointer"><input type="checkbox" id="t-moon-pg" ${Number(state.moonPerGame) === 2 ? "checked" : ""}/> 2 legs per game</label>
      </div>
      ${!m ? `<div class="muted small" style="margin-top:10px">No legs to build with right now${pool.length ? "" : ` for ${esc(scopeLabel())}`}. Try ${[state.sport !== "all" && "All sports", state.days !== "all" && "All days"].filter(Boolean).join(" or ") || "again later"}, or check back when lines post.</div>` : `
      ${m.reached ? "" : `<div class="notice warn" style="margin-top:10px">The ${esc(scopeLabel())} legs can't reach ${k$(Number(state.moonTarget))} on $${state.moonStake}. The biggest ticket available is below; try ${[state.sport !== "all" && "All sports", state.days !== "all" && "All days"].filter(Boolean).concat("a bigger bet or a smaller target").join(", ")}.</div>`}
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
    if (e.target.id === "t-aonly") { state.aOnly = e.target.checked; renderAll(); return; }
    if (e.target.id === "t-moon-pg") { state.moonPerGame = e.target.checked ? 2 : 1; moonExclude = []; persist(); renderMoon(); return; }
    const s = e.target.closest("#t-sport .chip");
    if (s) { state.sport = s.dataset.s; state.offGames = new Set(); state.sgpGame = null; state.sgpLegs = null; moonExclude = []; renderAll(); renderSgp(); return; }
    const d = e.target.closest("#t-day .chip");
    if (d) { state.days = d.dataset.d; state.offGames = new Set(); moonExclude = []; renderAll(); renderSgp(); return; }
    const gm = e.target.closest("#t-games [data-g]");
    if (gm) { const k = gm.dataset.g; if (state.offGames.has(k)) state.offGames.delete(k); else state.offGames.add(k); moonExclude = []; renderAll(); return; }
    const ga = e.target.closest("#t-games [data-gall]");
    if (ga) { state.offGames = ga.dataset.gall === "1" ? new Set() : new Set(dayGames().map((g) => g.key)); moonExclude = []; renderAll(); return; }
    const b = e.target.closest("#t-budget .chip, #t-bank .chip");
    if (b) { state.budget = Number(b.dataset.b); $("#t-custom").value = ""; renderAll(); renderSgp(); return; }
    const stl = e.target.closest("#t-style button");
    if (stl) { state.style = stl.dataset.st; renderAll(); return; }
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

  // ---------- live re-check ----------
  // Every few minutes: pull DraftKings' current lines, re-price every leg at the new
  // line and price with the same model math as the full scan, re-grade, and rebuild.
  const LIVE_EVERY = 3 * 60e3;
  let liveOn = true, liveBusy = false, liveTimer = null, lastLive = null, newer = null;
  const legsByGame = new Map();
  for (const l of today?.legs || []) { if (!legsByGame.has(l.gameKey)) legsByGame.set(l.gameKey, []); legsByGame.get(l.gameKey).push(l); }

  function applyLive(l, r) {
    if (!l || !r) return;
    if (!l.live) l.live = { line0: l.line, odds0: l.odds, prob0: l.prob, grade0: l.grade, label0: l.label, side0: l.side, lean0: l.lean };
    if (r.far) { l.live.far = true; l.live.farLine = r.line; l.grade = "PASS"; return; }
    l.live.far = false;
    Object.assign(l, { line: r.line ?? l.line, odds: r.odds, priced: r.priced, prob: r.prob, edge: r.edge, ev: r.ev, grade: r.grade, label: r.label || l.label });
    if (r.side) l.side = r.side;
    if (r.lean != null) l.lean = r.lean;
  }

  // Picks that switched sides, dropped out, newly qualified or changed grade since the scan.
  function liveChanges() {
    const graded = (g) => ["A", "B", "C"].includes(g);
    const rows = [];
    for (const l of legsInSport()) {
      const lv = l.live;
      if (!lv) continue;
      const was = lv.lean0 && graded(lv.grade0), now = l.lean && graded(l.grade);
      if (l.kind === "prop" && lv.side0 && l.side !== lv.side0 && now) rows.push({ t: "switched", l, text: `${lv.label0} → <b>${esc(l.label)}</b> ${M.fmtOdds(l.odds)} · grade ${l.grade}` });
      else if (was && !now) rows.push({ t: "dropped", l, text: `${esc(lv.label0)} (was ${lv.grade0}) is out: ${lv.far ? "the line jumped too far to re-price" : `at ${esc(String(l.line ?? ""))} ${M.fmtOdds(l.odds)} there's no edge left`}` });
      else if (!was && now) rows.push({ t: "new", l, text: `<b>${esc(l.label)}</b> ${M.fmtOdds(l.odds)} is now a grade ${l.grade} pick` });
      else if (was && now && lv.grade0 !== l.grade) rows.push({ t: "regraded", l, text: `${esc(l.label)}: grade ${lv.grade0} → <b>${l.grade}</b>` });
    }
    return rows;
  }

  function paintChanges() {
    const el = $("#t-live-changes");
    if (!el) return;
    const rows = liveChanges();
    if (!rows.length) { el.innerHTML = ""; return; }
    const n = (t) => rows.filter((r) => r.t === t).length;
    const ICON = { switched: "🔁", dropped: "⛔", new: "🆕", regraded: "↕️" };
    const order = ["switched", "new", "dropped", "regraded"];
    el.innerHTML = `<details class="live-changes" ${n("switched") + n("new") + n("dropped") ? "open" : ""}><summary class="small"><b>What changed</b> since the ${fmtTime(today.generated)} scan: ${order.filter(n).map((t) => `${n(t)} ${t}`).join(" · ")}</summary>
      <div class="small">${rows.sort((a, b) => order.indexOf(a.t) - order.indexOf(b.t)).slice(0, 30).map((r) => `<div class="lc-row"><span>${ICON[r.t]}</span><span><a href="${legLink(r.l)}" style="color:var(--text)">${r.text}</a> <span class="faint">· ${esc(leagueName(r.l.league))} · ${esc(r.l.matchup)}</span></span></div>`).join("")}</div></details>`;
  }

  function paintLive(checking = false) {
    const el = $("#t-live");
    if (!el) return;
    const ls = (today.legs || []).filter((l) => l.live && new Date(l.start) > Date.now());
    const moved = ls.filter((l) => l.live.far || l.live.line0 !== l.line || l.live.odds0 !== l.odds).length;
    const regraded = ls.filter((l) => l.live.grade0 !== l.grade).length;
    el.innerHTML = `<span class="live-pulse ${liveOn ? "" : "off"}"></span><b>Live re-check</b>
      <span class="muted">${checking ? "checking DraftKings' current lines…" : lastLive ? `checked ${fmtTime(new Date(lastLive).toISOString())} · ${moved} line${moved === 1 ? "" : "s"} or price${moved === 1 ? "" : "s"} moved since the ${fmtTime(today.generated)} scan · ${regraded} grade${regraded === 1 ? "" : "s"} changed` : liveOn ? "starting…" : "paused"}</span>
      ${newer ? `<button class="linkbtn" data-live-load style="margin:0">↻ Load the ${fmtTime(newer)} full re-scan</button>` : ""}
      <span class="spacer"></span><button class="linkbtn" data-live-now style="margin:0">Check now</button><button class="linkbtn" data-live-toggle style="margin:0">${liveOn ? "Pause" : "Resume"}</button>`;
  }

  async function liveCheck() {
    if (!today || liveBusy || !ctx.alive()) return;
    liveBusy = true;
    paintLive(true);
    try {
      const upcoming = games.filter((g) => new Date(g.start) > Date.now());
      // Props (one request per game) for games in view with bettable graded props, busiest
      // first, plus anything in My parlay; game lines for every game.
      const propCount = new Map();
      for (const l of legsInSport()) if (l.kind === "prop" && l.rp && usableLeg(l) && ["A", "B", "C"].includes(l.live?.grade0 ?? l.grade)) propCount.set(l.gameKey, (propCount.get(l.gameKey) || 0) + 1);
      const want = new Set([...[...propCount].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k]) => k), ...state.mine.map((id) => legById.get(id)?.gameKey).filter(Boolean), state.sgpGame].filter(Boolean));
      const propGames = upcoming.filter((g) => want.has(g.key) && (legsByGame.get(g.key) || []).some((l) => l.rp));
      const [lines, props, latest] = await Promise.all([currentGameLines(upcoming), currentProps(propGames), getData("data/picks/today.json")]);
      if (!ctx.alive()) return;
      for (const g of upcoming) {
        const legs = legsByGame.get(g.key) || [];
        for (const [id, r] of repriceGame(g, legs, lines.get(String(g.eventId)))) applyLive(legs.find((l) => l.id === id), r);
        const pm = props.get(String(g.eventId));
        if (pm) for (const l of legs) if (l.kind === "prop") { const f = pm.get(String(l.playerId))?.[l.marketKey]; if (f) applyLive(l, repriceProp(l, f)); }
      }
      if (latest?.generated && new Date(latest.generated) > new Date(today.generated)) newer = latest.generated;
      lastLive = Date.now();
      renderAll();
      paintChanges();
      if (state.sgpLegs) renderSgp();
    } catch (e) { console.warn("live re-check:", e); } finally { liveBusy = false; if (ctx.alive()) paintLive(); }
  }

  function scheduleLive() {
    clearTimeout(liveTimer);
    if (!liveOn || !today) return;
    liveTimer = setTimeout(function tick() {
      if (!ctx.alive()) return;
      if (document.visibilityState === "visible") liveCheck().finally(scheduleLive); else liveTimer = setTimeout(tick, 30e3);
    }, LIVE_EVERY);
  }

  $("#t-root").addEventListener("click", (e) => {
    if (e.target.closest("[data-live-toggle]")) { liveOn = !liveOn; paintLive(); if (liveOn) liveCheck().finally(scheduleLive); else clearTimeout(liveTimer); }
    if (e.target.closest("[data-live-now]")) liveCheck().finally(scheduleLive);
    if (e.target.closest("[data-live-load]")) window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  renderAll();
  renderSgp();
  renderRecord();
  if (q.focus === "moon") $("#t-moon").scrollIntoView({ block: "start" });
  if (today) { paintLive(); setTimeout(() => liveCheck().finally(scheduleLive), 1200); }
}

// Compact "today" teaser for the home page.
export async function todayTeaser() {
  const today = await getData("data/picks/today.json");
  if (!today) return "";
  const now = Date.now();
  const legs = (today.legs || []).filter((l) => new Date(l.start) > now);
  // Today's games first; if nothing today has an edge, the next day that does.
  const days = [...new Set(legs.map((l) => dayKey(l.start)))].sort();
  let picks = [], day = null;
  for (const d of days) { picks = choosePicks(legs.filter((l) => dayKey(l.start) === d), 4); if (picks.length) { day = d; break; } }
  if (!picks.length) return "";
  const when = day === dayKey(now) ? "Today's" : `${new Date(picks[0].start).toLocaleDateString("en-US", { weekday: "long" })}'s`;
  return `<div class="card">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">🔥 ${when} top picks</h2><a class="btn sm" href="#/today">Build my ticket ›</a></div>
    <div style="margin-top:6px">${picks.map((l) => `<a class="tp-row" href="#/today"><span class="gbadge ${esc(l.grade)}">${esc(l.grade)}</span><span class="tp-text"><b>${esc(l.label)}</b><span class="muted small">${M.fmtOdds(l.odds)} · ${esc(leagueName(l.league))} · ${fmtTime(l.start)}</span></span></a>`).join("")}</div>
  </div>`;
}
