import { leagueById, MARKETS } from "../sports.js";
import { api, loadGamelogs } from "../espn.js";
import * as M from "../model.js";
import { esc, setTitle, pct, fx, signed, fmtDate, toast } from "../ui.js";
import { loadPicks, updatePick, removePick } from "../store.js";
import { marketValue } from "../props.js";

const profit = (p) => (p.result === "W" ? M.payout(p.odds ?? -110) : p.result === "L" ? -1 : 0);

export function renderPicks(ctx) {
  const { app } = ctx;
  setTitle("Saved picks");
  const draw = () => {
    const picks = loadPicks();
    const graded = picks.filter((p) => p.result && p.result !== "P");
    const w = graded.filter((p) => p.result === "W").length;
    const units = picks.reduce((t, p) => t + profit(p), 0);
    const byGrade = ["A", "B", "C", "PASS"].map((g) => {
      const list = picks.filter((p) => p.grade === g && p.result && p.result !== "P");
      return { g, n: list.length, w: list.filter((p) => p.result === "W").length, u: list.reduce((t, p) => t + profit(p), 0) };
    }).filter((x) => x.n);
    app.innerHTML = `
      <div class="crumbs"><a href="#/">Home</a> › Saved picks</div>
      <div class="row"><h1>★ Saved picks</h1><span class="spacer"></span><button class="btn sm" id="grade">Auto-grade finished games</button></div>
      <p class="sub">Stored in this browser only. Units assume 1 unit per pick at the saved odds.</p>
      <div class="kpis">
        <div class="kpi"><div class="k">Record</div><div class="v">${w}-${graded.length - w}${picks.some((p) => p.result === "P") ? `-${picks.filter((p) => p.result === "P").length}` : ""}</div></div>
        <div class="kpi"><div class="k">Win %</div><div class="v">${graded.length ? pct(w / graded.length) : "—"}</div></div>
        <div class="kpi"><div class="k">Units</div><div class="v ${units >= 0 ? "pos" : "neg"}">${signed(units, 2)}</div></div>
        <div class="kpi"><div class="k">ROI</div><div class="v">${graded.length ? pct(units / graded.length, 1) : "—"}</div></div>
        <div class="kpi"><div class="k">Pending</div><div class="v">${picks.filter((p) => !p.result).length}</div></div>
      </div>
      ${byGrade.length ? `<p class="small muted" style="margin-top:10px">By grade: ${byGrade.map((x) => `<b>${x.g}</b> ${x.w}-${x.n - x.w} (${signed(x.u, 1)}u)`).join(" · ")}</p>` : ""}
      <div class="card" style="margin-top:14px">
        ${picks.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Pick</th><th class="r">Odds</th><th class="r">Model</th><th class="r">Grade</th><th>Result</th><th></th></tr></thead><tbody>
        ${picks.map((p) => `<tr data-id="${p.id}"><td>${fmtDate(p.eventDate || p.created)}</td>
          <td><b>${esc(p.athlete || "")}</b> ${esc(p.side || "")} ${p.line ?? ""} ${esc(p.marketLabel || "")} <span class="faint">${esc(leagueById(p.league)?.name || p.league || "")}${p.opp ? ` vs ${esc(p.opp)}` : ""}</span>${p.actual != null ? ` <span class="faint">· actual ${p.actual}</span>` : ""}</td>
          <td class="r">${M.fmtOdds(p.odds ?? -110)}</td><td class="r">${pct(p.prob)}</td><td class="r">${esc(p.grade || "")}</td>
          <td><div class="seg">${["W", "L", "P"].map((r) => `<button data-r="${r}" class="${p.result === r ? "on" : ""}">${r}</button>`).join("")}</div></td>
          <td><button class="icon-btn" data-del title="Delete">✕</button></td></tr>`).join("")}
        </tbody></table></div>` : `<div class="muted">No saved picks yet. Hit ★ Save on any analysis.</div>`}
      </div>`;
    app.querySelectorAll("tr[data-id]").forEach((tr) => {
      tr.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => {
        const cur = loadPicks().find((x) => x.id === tr.dataset.id);
        updatePick(tr.dataset.id, { result: cur?.result === b.dataset.r ? null : b.dataset.r });
        draw();
      }));
      tr.querySelector("[data-del]").addEventListener("click", () => { removePick(tr.dataset.id); draw(); });
    });
    app.querySelector("#grade").addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Grading…";
      const n = await autoGrade();
      toast(n ? `Graded ${n} pick${n === 1 ? "" : "s"}` : "Nothing new to grade yet");
      if (ctx.alive()) draw();
    });
  };
  draw();
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
