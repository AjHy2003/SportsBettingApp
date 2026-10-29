import { leagueById, MARKETS } from "../sports.js";
import { api, loadGamelogs } from "../espn.js";
import * as M from "../model.js";
import { esc, setTitle, pct, signed, fmtDate, fmtTime, toast } from "../ui.js";
import { loadPicks, updatePick, removePick, loadTickets, updateTicket, removeTicket } from "../store.js";
import { marketValue } from "../props.js";
import { legOf, trackLegs, ticketStatus } from "../live.js";

const profit = (p) => (p.result === "W" ? M.payout(p.odds ?? -110) : p.result === "L" ? -1 : 0);
const money = (x) => (x == null || !isFinite(x) ? "—" : `$${Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2).replace(/\.00$/, "")}`);
const REFRESH = 30e3;
const ICON = { won: "✅", lost: "❌", push: "↩️", void: "↩️", upcoming: "⏳", unknown: "·" };
const legStart = (l) => (l.start ? new Date(l.start).getTime() : 0);

// Picks/tickets worth showing on the live board: games from the last ~day through the next two days.
const inWindow = (legs) => legs.some((l) => { const t = legStart(l); return t && t > Date.now() - 30 * 3600e3 && t < Date.now() + 48 * 3600e3; });

export function renderPicks(ctx, q = {}) {
  const { app } = ctx;
  setTitle("My bets");
  let tab = q.tab || (hasLiveOrToday() ? "live" : "history");
  let timer = null, busy = false, lastUpdate = null;

  function hasLiveOrToday() {
    const legs = [...loadTickets().flatMap((t) => t.legs.map(legOf)), ...loadPicks().filter((p) => !p.ticketId && p.eventId).map(legOf)];
    return inWindow(legs);
  }

  function shell() {
    app.innerHTML = `
      <div class="crumbs"><a href="#/">Home</a> › My bets</div>
      <div class="row"><h1>★ My bets</h1><span class="spacer"></span></div>
      <div class="tabs" id="b-tabs"><button data-t="live">📡 Live & today</button><button data-t="history">History</button></div>
      <div id="b-body"></div>`;
    app.querySelectorAll("#b-tabs button").forEach((b) => {
      b.classList.toggle("on", b.dataset.t === tab);
      b.addEventListener("click", () => { tab = b.dataset.t; history.replaceState(null, "", `#/picks?tab=${tab}`); shell(); });
    });
    if (tab === "live") live(); else historyTab();
  }

  // ---------- live ----------
  function legRow(l, st) {
    const g = st.game;
    const score = g && g.state !== "pre" ? `${esc(g.away.abbr)} ${g.away.score ?? ""} – ${esc(g.home.abbr)} ${g.home.score ?? ""} · ${esc(g.detail)}` : l.start ? `${fmtDate(l.start, { weekday: "short" })} ${fmtTime(l.start)}` : "";
    const icon = st.status === "live" ? (st.onTrack === false ? "🟠" : "🟢") : ICON[st.status] || "·";
    const bar = st.status === "live" && st.progress != null
      ? `<div class="lbar"><span style="width:${Math.round(st.progress * 100)}%" class="${st.onTrack === false ? "behind" : ""}"></span></div>` : "";
    return `<div class="lleg ${st.status}">
      <span class="lico">${icon}</span>
      <div style="min-width:0;flex:1">
        <div class="ltitle">${esc(l.label)}</div>
        <div class="small muted">${score}${l.sub && !g ? ` · ${esc(l.sub)}` : ""}</div>
        ${st.text ? `<div class="small ${st.status === "won" ? "pos" : st.status === "lost" ? "neg" : ""}">${esc(st.text)}</div>` : ""}
        ${bar}
      </div>
    </div>`;
  }

  async function live(refresh = false) {
    const body = app.querySelector("#b-body");
    if (!body || busy) return;
    busy = true;
    const showTickets = loadTickets().filter((t) => !t.result || inWindow(t.legs.map(legOf)));
    const picks = loadPicks().filter((p) => !p.ticketId && p.eventId && p.league && leagueById(p.league)?.espn && inWindow([legOf(p)]));
    if (!showTickets.length && !picks.length) {
      body.innerHTML = `<div class="card"><h3>Nothing to track yet</h3><p class="muted">Save a ticket from <a href="#/today">🔥 Today</a> (★ Save all, or ★ Save parlay on your own parlay), or tap ★ Save on any player or game. During the game this page shows every leg live: the score, the stat so far, what it still needs and the pace, refreshed every 30 seconds.</p></div>`;
      busy = false;
      return;
    }
    if (!refresh) body.innerHTML = `<div class="loading"><span class="spinner"></span>Checking your games…</div>`;
    const tLegs = showTickets.map((t) => t.legs.map(legOf));
    const pLegs = picks.map(legOf);
    let statuses;
    try { statuses = await trackLegs([...tLegs.flat(), ...pLegs]); } catch { statuses = null; }
    busy = false;
    if (!ctx.alive() || tab !== "live" || !app.querySelector("#b-body")) return;
    if (!statuses) { body.innerHTML = `<div class="notice warn">Couldn't reach ESPN for live scores. Try again in a moment.</div>`; return; }
    lastUpdate = new Date();

    let k = 0;
    const tStats = tLegs.map((legs) => legs.map(() => statuses[k++]));
    const pStats = pLegs.map(() => statuses[k++]);

    // Settle finished picks and tickets so History stays current.
    picks.forEach((p, i) => {
      const s = pStats[i];
      if (p.result || !["won", "lost", "push", "void"].includes(s.status)) return;
      updatePick(p.id, { result: s.status === "won" ? "W" : s.status === "lost" ? "L" : "P", actual: s.value ?? (s.status === "void" ? "DNP" : null) });
    });
    showTickets.forEach((t, i) => {
      const ts = ticketStatus(tStats[i]);
      if (!t.result && ["won", "lost", "push"].includes(ts)) updateTicket(t.id, { result: ts === "won" ? "W" : ts === "lost" ? "L" : "P" });
      t.legs.forEach((leg, j) => {
        const s = tStats[i][j];
        const pick = loadPicks().find((p) => p.ticketId === t.id && p.eventId === leg.eventId && p.side === leg.side && String(p.athleteId ?? "") === String(leg.athleteId ?? "") && p.market === leg.market);
        if (pick && !pick.result && ["won", "lost", "push", "void"].includes(s.status)) updatePick(pick.id, { result: s.status === "won" ? "W" : s.status === "lost" ? "L" : "P", actual: s.value ?? null });
      });
    });

    const order = { live: 0, upcoming: 1, won: 2, push: 3, lost: 4 };
    const cards = showTickets.map((t, i) => ({ t, st: tStats[i], ts: ticketStatus(tStats[i]) })).sort((a, b) => order[a.ts] - order[b.ts]);
    const anyLive = statuses.some((s) => s.status === "live") || [...tLegs.flat(), ...pLegs].some((l) => { const d = legStart(l) - Date.now(); return d < 15 * 60e3 && d > -4 * 3600e3; });
    const label = (t) => (t.type === "single" ? "Straight bet" : t.type === "sgp" ? `${t.legs.length}-leg same-game parlay` : `${t.legs.length}-leg parlay`);
    const pill = (ts, t) => ts === "won" ? `<span class="pill" style="color:var(--over);border-color:var(--over)">WON ${t.toWin ? `+${money(t.toWin)}` : ""}</span>`
      : ts === "lost" ? `<span class="pill neg" style="border-color:var(--under)">LOST</span>`
      : ts === "live" ? `<span class="pill live">● LIVE</span>` : ts === "push" ? `<span class="pill">PUSH</span>` : `<span class="pill">UPCOMING</span>`;
    const tally = (st) => {
      const c = (x) => st.filter((s) => s.status === x).length;
      return [c("won") && `${c("won")} won`, c("live") && `${c("live")} live`, c("upcoming") && `${c("upcoming")} to go`, c("lost") && `${c("lost")} lost`].filter(Boolean).join(" · ");
    };

    body.innerHTML = `
      <div class="row small muted" style="justify-content:space-between;margin-bottom:10px">
        <span>${anyLive ? `● Live · updates every ${REFRESH / 1000}s` : "No games in progress"} · last checked ${fmtTime(lastUpdate.toISOString())}</span>
        <button class="btn ghost sm" id="b-refresh">↻ Refresh</button>
      </div>
      ${cards.map(({ t, st, ts }) => `<div class="card lticket ${ts}" style="margin-bottom:12px">
        <div class="row" style="justify-content:space-between">
          <div><b>${label(t)}</b> <span class="muted small">· ${money(t.stake)} to win ${money(t.toWin)} · ${M.fmtOdds(t.american)}</span></div>
          <div class="row">${pill(ts, t)}<button class="icon-btn" data-delt="${esc(t.id)}" title="Remove">✕</button></div>
        </div>
        ${t.legs.length > 1 ? `<div class="small muted" style="margin-top:4px">${tally(st)}</div>` : ""}
        <div style="margin-top:6px">${t.legs.map((p, j) => legRow(legOf(p), st[j])).join("")}</div>
      </div>`).join("")}
      ${picks.length ? `<div class="card"><h3>Saved picks</h3>${picks.map((p, i) => legRow(pLegs[i], pStats[i])).join("")}</div>` : ""}
      <p class="small faint">Live stats from ESPN; a few seconds to a minute behind the broadcast. Your book settles the bets, not this page.</p>`;
    body.querySelector("#b-refresh").addEventListener("click", () => live(true));
    body.querySelectorAll("[data-delt]").forEach((b) => b.addEventListener("click", () => { removeTicket(b.dataset.delt); live(); }));
    schedule(anyLive);
  }

  function schedule(anyLive) {
    clearTimeout(timer);
    if (!anyLive) return;
    timer = setTimeout(function tick() {
      if (!ctx.alive() || tab !== "live") return;
      if (document.visibilityState === "visible") live(true);
      else timer = setTimeout(tick, REFRESH);
    }, REFRESH);
  }

  // ---------- history ----------
  function historyTab() {
    clearTimeout(timer);
    const body = app.querySelector("#b-body");
    const picks = loadPicks();
    const graded = picks.filter((p) => p.result && p.result !== "P");
    const w = graded.filter((p) => p.result === "W").length;
    const units = picks.reduce((t, p) => t + profit(p), 0);
    const byGrade = ["A", "B", "C", "PASS"].map((g) => {
      const list = picks.filter((p) => p.grade === g && p.result && p.result !== "P");
      return { g, n: list.length, w: list.filter((p) => p.result === "W").length, u: list.reduce((t, p) => t + profit(p), 0) };
    }).filter((x) => x.n);
    const tickets = loadTickets().filter((t) => t.result);
    const tw = tickets.filter((t) => t.result === "W").length, tl = tickets.filter((t) => t.result === "L").length;
    const tProfit = tickets.reduce((s, t) => s + (t.result === "W" ? t.toWin || 0 : t.result === "L" ? -(t.stake || 0) : 0), 0);
    body.innerHTML = `
      <p class="sub">Stored in this browser only. Units assume 1 unit per pick at the saved odds.</p>
      <div class="kpis">
        <div class="kpi"><div class="k">Record</div><div class="v">${w}-${graded.length - w}${picks.some((p) => p.result === "P") ? `-${picks.filter((p) => p.result === "P").length}` : ""}</div></div>
        <div class="kpi"><div class="k">Win %</div><div class="v">${graded.length ? pct(w / graded.length) : "—"}</div></div>
        <div class="kpi"><div class="k">Units</div><div class="v ${units >= 0 ? "pos" : "neg"}">${signed(units, 2)}</div></div>
        <div class="kpi"><div class="k">ROI</div><div class="v">${graded.length ? pct(units / graded.length, 1) : "—"}</div></div>
        <div class="kpi"><div class="k">Pending</div><div class="v">${picks.filter((p) => !p.result).length}</div></div>
        ${tickets.length ? `<div class="kpi"><div class="k">Tickets</div><div class="v">${tw}-${tl} <span class="small ${tProfit >= 0 ? "pos" : "neg"}">${tProfit >= 0 ? "+" : "−"}${money(Math.abs(tProfit))}</span></div></div>` : ""}
      </div>
      ${byGrade.length ? `<p class="small muted" style="margin-top:10px">By grade: ${byGrade.map((x) => `<b>${x.g}</b> ${x.w}-${x.n - x.w} (${signed(x.u, 1)}u)`).join(" · ")}</p>` : ""}
      <div class="row" style="margin-top:10px"><button class="btn sm" id="grade">Auto-grade finished games</button></div>
      <div class="card" style="margin-top:14px">
        ${picks.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Pick</th><th class="r">Odds</th><th class="r">Model</th><th class="r">Grade</th><th>Result</th><th></th></tr></thead><tbody>
        ${picks.map((p) => `<tr data-id="${p.id}"><td>${fmtDate(p.eventDate || p.created)}</td>
          <td><b>${esc(p.athlete || "")}</b> ${esc(p.side || "")} ${p.line ?? ""} ${esc(p.marketLabel || "")} <span class="faint">${esc(leagueById(p.league)?.name || p.league || "")}${p.opp ? ` vs ${esc(p.opp)}` : ""}</span>${p.actual != null ? ` <span class="faint">· actual ${esc(p.actual)}</span>` : ""}</td>
          <td class="r">${M.fmtOdds(p.odds ?? -110)}</td><td class="r">${pct(p.prob)}</td><td class="r">${esc(p.grade || "")}</td>
          <td><div class="seg">${["W", "L", "P"].map((r) => `<button data-r="${r}" class="${p.result === r ? "on" : ""}">${r}</button>`).join("")}</div></td>
          <td><button class="icon-btn" data-del title="Delete">✕</button></td></tr>`).join("")}
        </tbody></table></div>` : `<div class="muted">No saved picks yet. Hit ★ Save on any analysis.</div>`}
      </div>`;
    body.querySelectorAll("tr[data-id]").forEach((tr) => {
      tr.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => {
        const cur = loadPicks().find((x) => x.id === tr.dataset.id);
        updatePick(tr.dataset.id, { result: cur?.result === b.dataset.r ? null : b.dataset.r });
        historyTab();
      }));
      tr.querySelector("[data-del]").addEventListener("click", () => { removePick(tr.dataset.id); historyTab(); });
    });
    body.querySelector("#grade").addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Grading…";
      const n = await autoGrade();
      toast(n ? `Graded ${n} pick${n === 1 ? "" : "s"}` : "Nothing new to grade yet");
      if (ctx.alive() && tab === "history") historyTab();
    });
  }

  shell();
}

// Topbar dot: a saved bet's game is probably on right now (no network needed).
export function liveBetsNow() {
  const now = Date.now();
  const legs = [...loadTickets().filter((t) => !t.result).flatMap((t) => t.legs), ...loadPicks().filter((p) => !p.result && !p.ticketId)];
  return legs.some((p) => { const t = p.eventDate ? new Date(p.eventDate).getTime() : 0; return t && now >= t && now - t < 4 * 3600e3; });
}

async function autoGrade() {
  let n = 0;
  for (const p of loadPicks()) {
    if (p.result || !p.eventId || !p.eventDate || new Date(p.eventDate) > Date.now()) continue;
    const L = leagueById(p.league);
    if (!L?.espn) continue;
    try {
      if (p.game) {
        const s = await api.summary(L, p.eventId);
        const c = s.header?.competitions?.[0];
        if (!c?.status?.type?.completed) continue;
        const h = Number(c.competitors.find((x) => x.homeAway === "home").score);
        const a = Number(c.competitors.find((x) => x.homeAway === "away").score);
        let r = null;
        if (p.marketLabel === "Total") {
          const t = h + a;
          r = t === p.line ? "P" : (t > p.line) === p.side.startsWith("Over") ? "W" : "L";
        } else if (p.marketLabel === "Spread") {
          const homeSide = p.side.startsWith(p.homeAbbr);
          const adj = h - a + p.line;
          r = adj === 0 ? "P" : (adj > 0) === homeSide ? "W" : "L";
        } else {
          const homeSide = p.side.startsWith(p.homeAbbr);
          r = h === a ? (p.side === "Draw" ? "W" : "L") : p.side === "Draw" ? "L" : (h > a) === homeSide ? "W" : "L";
        }
        updatePick(p.id, { result: r, actual: `${a}-${h}` });
        n++;
      } else if (p.athleteId) {
        const log = await loadGamelogs(L, p.athleteId, L.markets, 1);
        const g = log.games.find((x) => String(x.eventId) === String(p.eventId));
        if (!g) continue;
        const fam = log.family === "baseballPitching" ? "baseball" : log.family;
        const m = (MARKETS[fam] || []).find((x) => x.key === p.market);
        const val = m ? marketValue(m, g) : null;
        if (val == null) continue;
        const r = val === p.line ? "P" : (val > p.line) === (p.side === "OVER") ? "W" : "L";
        updatePick(p.id, { result: r, actual: val });
        n++;
      }
    } catch { /* try again later */ }
  }
  return n;
}
