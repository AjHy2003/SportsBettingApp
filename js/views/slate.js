import { api, gameOdds, competitorsOf } from "../espn.js";
import { esc, loading, errorBox, setTitle, ymd, fmtTime } from "../ui.js";
import { fmtOdds } from "../model.js";

const EXTRA = {
  ncaaf: "groups=80&limit=300",
  ncaab: "groups=50&limit=400",
  ncaaw: "groups=50&limit=400",
};

const isWeekly = (L) => L.markets === "football";

export async function renderSlate(ctx, L, q) {
  const { app } = ctx;
  setTitle(L.name);
  const today = new Date();
  const date = q.d || ymd(today);
  const params = [EXTRA[L.id], isWeekly(L) && q.week ? `week=${q.week}&seasontype=${q.st || 2}` : !isWeekly(L) ? `dates=${date}` : ""].filter(Boolean).join("&");

  app.innerHTML = `
    <div class="crumbs"><a href="#/">Home</a> › ${esc(L.name)}</div>
    <div class="row"><h1>${L.icon} ${esc(L.name)}</h1><span class="spacer"></span><a class="btn ghost sm" href="#/custom">Custom calculator</a></div>
    <div id="nav"></div>
    <div id="games">${loading("Loading games…")}</div>`;

  let sb;
  try {
    sb = await api.scoreboard(L, params);
  } catch (e) {
    if (ctx.alive()) app.querySelector("#games").innerHTML = errorBox(e);
    return;
  }
  if (!ctx.alive()) return;

  const nav = app.querySelector("#nav");
  if (isWeekly(L)) {
    const wk = sb.week?.number;
    const st = sb.season?.type ?? 2;
    nav.innerHTML = wk ? `<div class="row" style="margin-bottom:12px">
      <a class="btn ghost sm" href="#/l/${L.id}?week=${Math.max(1, wk - 1)}&st=${st}">‹ Week ${Math.max(1, wk - 1)}</a>
      <b>Week ${wk}</b>
      <a class="btn ghost sm" href="#/l/${L.id}?week=${wk + 1}&st=${st}">Week ${wk + 1} ›</a></div>` : "";
  } else {
    const days = [];
    for (let i = -2; i <= 6; i++) { const d = new Date(today); d.setDate(d.getDate() + i); days.push(d); }
    nav.innerHTML = `<div class="datebar">${days.map((d) => {
      const v = ymd(d);
      const lbl = v === ymd(today) ? "Today" : d.toLocaleDateString(undefined, { weekday: "short" });
      return `<button class="${v === date ? "on" : ""}" data-d="${v}">${lbl}<small>${d.getMonth() + 1}/${d.getDate()}</small></button>`;
    }).join("")}</div>`;
    nav.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { location.hash = `#/l/${L.id}?d=${b.dataset.d}`; }));
  }

  const events = sb.events || [];
  const box = app.querySelector("#games");
  if (!events.length) {
    box.innerHTML = `<div class="notice">No ${esc(L.name)} games on this ${isWeekly(L) ? "week" : "day"}. Try another date${L.markets === "baseball" ? " — the MLB season may be over; player pages still show last season's game logs" : ""}.</div>`;
    return;
  }
  box.innerHTML = `<div class="grid three">${events.map((e) => gameCard(L, e)).join("")}</div>`;
}

function gameCard(L, e) {
  const { home, away, comp } = competitorsOf(e);
  if (!home || !away) return "";
  const st = e.status?.type || comp.status?.type || {};
  const odds = gameOdds(comp);
  const showScore = st.state !== "pre";
  const team = (c) => `
    <div class="gc-team">
      <img src="${esc(c.team?.logo || "")}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/>
      <div class="nm">${esc(c.team?.shortDisplayName || c.team?.displayName || c.athlete?.displayName || "")}<span class="rec">${esc(c.records?.[0]?.summary || "")}</span></div>
      <div></div>
      <div class="score">${showScore ? esc(c.score ?? "") : ""}</div>
    </div>`;
  const when = st.state === "pre" ? `${new Date(e.date).toLocaleDateString(undefined, { weekday: "short" })} ${fmtTime(e.date)}` : st.shortDetail || st.detail || "";
  const pills = [];
  if (odds) {
    if (odds.spreadHome != null && L.markets !== "soccer") pills.push(`<span class="pill">Spread <b>${esc(odds.details || "")}</b></span>`);
    if (odds.total != null) pills.push(`<span class="pill">O/U <b>${odds.total}</b></span>`);
    if (odds.mlAway != null || odds.mlHome != null) pills.push(`<span class="pill">ML <b>${fmtOdds(odds.mlAway)} / ${fmtOdds(odds.mlHome)}</b></span>`);
    if (odds.draw != null) pills.push(`<span class="pill">Draw <b>${fmtOdds(odds.draw)}</b></span>`);
  }
  return `<a class="card game-card" href="#/l/${L.id}/g/${e.id}">
    <div class="gc-top"><span>${esc(when)}</span>${st.state === "in" ? `<span class="pill live">LIVE</span>` : `<span>${esc(comp.venue?.fullName || "")}</span>`}</div>
    ${team(away)}${team(home)}
    <div class="gc-lines">${pills.join("") || `<span class="pill">No lines posted yet</span>`}</div>
  </a>`;
}
