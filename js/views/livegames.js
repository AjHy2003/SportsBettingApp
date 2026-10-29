// 📡 Live games: score, ESPN's live win probability and DraftKings' live moneyline,
// with the gap between them. Refreshes every 30 seconds while open.
import { leagueById } from "../sports.js";
import * as M from "../model.js";
import { esc, setTitle, pct, signed, fmtTime } from "../ui.js";
import { liveBoard, liveOdds, liveEdge } from "../liveboard.js";

const LEAGUES = ["nba", "nfl", "ncaaf", "ncaab", "nhl"];
const REFRESH = 30e3;

export async function renderLiveGames(ctx) {
  const { app } = ctx;
  setTitle("Live games");
  let timer = null;
  app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › Live games</div>
    <div class="row" style="justify-content:space-between"><h1>📡 Live games</h1><div class="row small muted"><span id="lg-upd"></span><button class="btn ghost sm" id="lg-ref">↻ Refresh</button></div></div>
    <p class="small muted" style="margin-top:0">ESPN's live win probability next to DraftKings' live moneyline (vig removed). A big gap is worth a look, not a sure thing: ESPN's number is a model too, and live prices move by the second.</p>
    <div id="lg-body"><div class="loading"><span class="spinner"></span>Checking games…</div></div>`;
  const $ = (s) => app.querySelector(s);

  async function load() {
    clearTimeout(timer);
    let games;
    try { games = await liveBoard(LEAGUES); } catch { games = null; }
    if (!ctx.alive()) return;
    if (!games) { $("#lg-body").innerHTML = `<div class="notice warn">Couldn't reach ESPN. Try ↻ Refresh.</div>`; return; }
    const live = games.filter((g) => g.state === "in");
    const odds = await Promise.all(live.map((g) => liveOdds(leagueById(g.league), g.eventId).catch(() => null)));
    if (!ctx.alive()) return;
    const card = (g, o) => {
      const e = liveEdge(g, o);
      return `<a class="card lgame ${e?.big ? "big" : ""}" href="#/l/${g.league}/g/${g.eventId}">
        <div class="row" style="justify-content:space-between"><span class="small muted">${esc(leagueById(g.league)?.name || g.league)}</span><span class="pill live">● ${esc(g.detail)}</span></div>
        <div class="lg-score"><span>${esc(g.away.abbr)} <b>${g.away.score ?? ""}</b></span><span class="faint">@</span><span>${esc(g.home.abbr)} <b>${g.home.score ?? ""}</b></span></div>
        ${g.winHome != null ? `<div class="wpbar" title="ESPN win probability"><span style="width:${Math.round((1 - g.winHome) * 100)}%"></span></div>
          <div class="row small" style="justify-content:space-between"><span>ESPN: ${esc(g.away.abbr)} ${pct(1 - g.winHome)}</span><span>${esc(g.home.abbr)} ${pct(g.winHome)}</span></div>` : `<div class="small faint">No live win probability for this league.</div>`}
        ${o ? `<div class="small muted" style="margin-top:6px">Live: ${esc(g.away.abbr)} ${M.fmtOdds(o.mlAway)} / ${esc(g.home.abbr)} ${M.fmtOdds(o.mlHome)}${o.spreadHome != null ? ` · spread ${esc(g.home.abbr)} ${o.spreadHome > 0 ? "+" : ""}${o.spreadHome}` : ""}${o.total != null ? ` · total ${o.total}` : ""}</div>` : `<div class="small faint" style="margin-top:6px">No live odds posted right now.</div>`}
        ${e ? `<div class="small ${e.big ? "pos" : "muted"}" style="margin-top:4px">${e.big ? "⚡ " : ""}ESPN gives <b>${esc(e.team)}</b> ${pct(e.side === "home" ? e.espnHome : 1 - e.espnHome)} vs the market's ${pct(e.side === "home" ? e.marketHome : 1 - e.marketHome)} (${signed(Math.abs(e.diff) * 100, 1)} pts) at ${M.fmtOdds(e.ml)}</div>` : ""}
      </a>`;
    };
    const upcoming = games.filter((g) => g.state === "pre").slice(0, 12);
    $("#lg-body").innerHTML = `
      ${live.length ? `<div class="lg-grid">${live.map((g, i) => card(g, odds[i])).join("")}</div>` : `<div class="card"><h3>No games live right now</h3><p class="muted small" style="margin:0">This page fills in when games tip off; it updates every 30 seconds while open.</p></div>`}
      ${upcoming.length ? `<div class="card" style="margin-top:14px"><h3>Coming up</h3>${upcoming.map((g) => `<a class="lg-next" href="#/l/${g.league}/g/${g.eventId}"><span>${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</span><span class="faint small">${esc(leagueById(g.league)?.name || "")} · ${fmtTime(g.start)}</span></a>`).join("")}</div>` : ""}`;
    $("#lg-upd").textContent = `Updated ${fmtTime(new Date().toISOString())}`;
    if (live.length || upcoming.some((g) => new Date(g.start) - Date.now() < 30 * 60e3)) {
      timer = setTimeout(function tick() {
        if (!ctx.alive()) return;
        if (document.visibilityState === "visible") load(); else timer = setTimeout(tick, REFRESH);
      }, REFRESH);
    }
  }
  $("#lg-ref").addEventListener("click", load);
  await load();
}
