import { api, getJSON } from "../espn.js";
import * as M from "../model.js";
import { esc, loading, errorBox, setTitle, pct, fx, fmtDate, gameChart, wireChartTips, toast } from "../ui.js";
import { addPick } from "../store.js";

const MISSED = 80; // finishing position assigned to CUT / WD / DQ

function parsePos(s) {
  const t = String(s || "").toUpperCase();
  if (!t || /CUT|MC|WD|DQ|MDF/.test(t)) return null;
  const n = parseInt(t.replace(/^T/, ""), 10);
  return isFinite(n) ? n : null;
}

// Recent tournaments from the athlete overview.
function golferHistory(ov) {
  const out = [];
  for (const tour of ov?.recentTournaments || []) {
    for (const ev of tour.eventsStats || []) {
      const c = ev.competitions?.[0]?.competitors?.[0];
      if (!c) continue;
      const posTxt = c.status?.position?.displayName;
      const pos = parsePos(posTxt);
      const rounds = (c.linescores?.items || []).map((x) => x.value).filter((v) => v > 50 && v < 100);
      out.push({ event: ev.id, name: ev.name || ev.shortName, date: ev.date, posTxt, pos, cut: pos == null && /CUT|MC/i.test(posTxt || ""), rounds, tour: tour.slug });
    }
  }
  return out.sort((a, b) => new Date(b.date) - new Date(a.date));
}

export async function renderGolf(ctx, L, q) {
  const { app } = ctx;
  setTitle(L.name);
  app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › ${esc(L.name)}</div><h1>${L.icon} ${esc(L.name)}</h1>${loading("Loading tournament…")}`;
  let sb;
  try {
    sb = await api.scoreboard(L);
  } catch (e) {
    if (ctx.alive()) app.innerHTML += errorBox(e);
    return;
  }
  if (!ctx.alive()) return;
  const ev = sb.events?.[0];
  const comp = ev?.competitions?.[0];
  const field = (comp?.competitors || []).map((c) => ({ id: c.id, name: c.athlete?.displayName, flag: c.athlete?.flag?.href, score: c.score, pos: c.order, rounds: (c.linescores || []).map((l) => l.value).filter((v) => v > 50) }));
  const state = ev?.status?.type?.state;

  app.innerHTML = `
    <div class="crumbs"><a href="#/">Home</a> › ${esc(L.name)}</div>
    <h1>${L.icon} ${esc(L.name)}</h1>
    <div class="card"><h2 style="margin:0">${esc(ev?.name || "No current tournament")}</h2>
      <div class="muted small">${ev ? `${fmtDate(ev.date, { month: "short", day: "numeric" })} · ${esc(ev.status?.type?.detail || "")} · ${field.length} players` : ""}</div></div>
    <div class="grid two" style="margin-top:14px">
      <div class="card" id="gp">${q.player ? loading("Loading golfer…") : `<div class="muted">Tap a golfer in the field (or search one) to see recent finishes and price top-5/10/20, make-cut and round-score bets.</div>`}</div>
      <div class="card"><h3>Field ${state === "pre" ? "(tee sheet)" : "(leaderboard)"}</h3>
        <div class="table-wrap" style="max-height:620px;overflow:auto"><table><thead><tr><th>#</th><th>Player</th><th class="r">Score</th><th class="r">Rounds</th></tr></thead><tbody>
        ${field.map((p) => `<tr data-p="${esc(p.id)}" style="cursor:pointer" class="${q.player === p.id ? "hl" : ""}"><td>${state === "pre" ? "" : p.pos}</td><td>${p.flag ? `<img src="${esc(p.flag)}" alt="" style="width:16px;vertical-align:-2px"/> ` : ""}${esc(p.name)}</td><td class="r">${esc(p.score ?? "")}</td><td class="r faint">${p.rounds.join(" ")}</td></tr>`).join("")}
        </tbody></table></div></div>
    </div>`;
  wireChartTips(app);
  app.querySelectorAll("tr[data-p]").forEach((tr) => tr.addEventListener("click", () => { location.hash = `#/l/${L.id}?player=${tr.dataset.p}`; }));
  if (q.player) renderGolfer(ctx, L, q.player, ev);
}

async function renderGolfer(ctx, L, id, ev) {
  const box = ctx.app.querySelector("#gp");
  let ath, ov;
  try {
    [ath, ov] = await Promise.all([api.athlete(L, id).catch(() => null), api.overview(L, id)]);
  } catch (e) {
    box.innerHTML = errorBox(e);
    return;
  }
  if (!ctx.alive()) return;
  const a = ath?.athlete || {};
  const hist = golferHistory(ov);
  if (!hist.length) { box.innerHTML = `<h3>${esc(a.displayName || "Golfer")}</h3><div class="muted">No recent tournament history on ESPN.</div>`; return; }
  const fin = hist.map((h) => ({ pos: h.pos ?? MISSED, field: 140, event: h.event }));
  const rounds = hist.flatMap((h) => h.rounds);
  const made = hist.filter((h) => h.pos != null).length;
  const probs = {
    win: M.topNProb(fin.slice(0, 20), 1, 6, 0.01),
    top5: M.topNProb(fin.slice(0, 20), 5, 6, 0.04),
    top10: M.topNProb(fin.slice(0, 20), 10, 6, 0.08),
    top20: M.topNProb(fin.slice(0, 20), 20, 6, 0.16),
    cut: (made + 3 * 0.6) / (hist.length + 3),
  };
  const stats = ov.statistics?.splits?.find((s) => /PGA|LPGA|Tour/i.test(s.displayName)) || ov.statistics?.splits?.[0];
  const labels = ov.statistics?.labels || [];
  setTitle(a.displayName);
  box.innerHTML = `
    <div class="phead"><img src="${esc(a.headshot?.href || "")}" alt="" onerror="this.style.visibility='hidden'"/><div><h2 style="margin:0">${esc(a.displayName || "")}</h2>
      <div class="meta">${stats ? labels.map((l, i) => `${esc(l)} ${esc(stats.stats[i])}`).join(" · ") : ""}</div></div></div>
    <div class="kpis">
      <div class="kpi"><div class="k">Top 5</div><div class="v">${pct(probs.top5)}</div></div>
      <div class="kpi"><div class="k">Top 10</div><div class="v">${pct(probs.top10)}</div></div>
      <div class="kpi"><div class="k">Top 20</div><div class="v">${pct(probs.top20)}</div></div>
      <div class="kpi"><div class="k">Make cut</div><div class="v">${pct(probs.cut)}</div></div>
      <div class="kpi"><div class="k">Round avg</div><div class="v">${fx(M.mean(rounds))} <small>±${fx(M.stdev(rounds))}</small></div></div>
    </div>
    <div class="form-row" style="margin-top:12px">
      <div class="field"><label>Market</label><select id="gm"><option value="top5">Top 5</option><option value="top10" selected>Top 10</option><option value="top20">Top 20</option><option value="cut">Make cut</option><option value="win">Win</option><option value="round">Round score</option></select></div>
      <div class="field hidden" id="gl-f"><label>Round line</label><input id="gl" type="number" step="0.5" value="${Math.round(M.mean(rounds)) + 0.5}"/></div>
      <div class="field"><label>Odds</label><input id="go" type="number" placeholder="+250"/></div>
    </div>
    <div id="gout" style="margin-top:10px"></div>
    <h3 style="margin-top:14px">Recent finishes</h3>
    ${gameChart(hist.slice(0, 16).map((h) => ({ value: h.pos ?? MISSED, date: h.date, opp: (h.name || "").split(" ")[0], home: true, result: h.posTxt, score: h.name })), 20.5, null, { height: 170, invert: true })}
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Event</th><th class="r">Finish</th><th class="r">Rounds</th></tr></thead><tbody>
    ${hist.slice(0, 15).map((h) => `<tr><td>${fmtDate(h.date)}</td><td>${esc(h.name)}</td><td class="r ${h.pos != null && h.pos <= 10 ? "o" : h.pos == null ? "u" : ""}">${esc(h.posTxt || "")}</td><td class="r faint">${h.rounds.join(" ")}</td></tr>`).join("")}
    </tbody></table></div>`;

  const $ = (s) => box.querySelector(s);
  const calc = () => {
    const mk = $("#gm").value;
    $("#gl-f").classList.toggle("hidden", mk !== "round");
    const odds = Number($("#go").value);
    let p, label;
    if (mk === "round") {
      const line = Number($("#gl").value);
      const pr = M.normalProbs(line, M.ewma(rounds, 12), Math.max(2.2, M.stdev(rounds)), true);
      p = pr.under / (1 - pr.push);
      label = `Round score under ${line}`;
    } else {
      p = probs[mk];
      label = { top5: "Top 5 finish", top10: "Top 10 finish", top20: "Top 20 finish", cut: "Makes the cut", win: "Wins" }[mk];
    }
    let v = "";
    if (odds) {
      const edge = p - M.impliedProb(odds);
      const grade = edge >= 0.05 ? "A" : edge >= 0.03 ? "B" : edge >= 0.015 ? "C" : "PASS";
      v = `<div class="verdict" style="margin-top:8px"><div class="grade ${grade}">${grade}</div><div><div class="small muted">Edge ${(edge * 100).toFixed(1)} pts · EV ${(M.expectedValue(p, 0, odds) * 100).toFixed(1)}%</div><button class="btn sm" id="gsave" style="margin-top:6px">★ Save</button></div></div>`;
    }
    $("#gout").innerHTML = `<b>${esc(label)}</b>: <span style="font-size:20px;font-weight:800">${pct(p, 1)}</span> <span class="muted">fair ${M.fmtOdds(M.toAmerican(Math.min(0.995, Math.max(0.002, p))))}</span>${mk === "round" ? ` <span class="muted small">(${pct(1 - p, 1)} over)</span>` : ""}${v}`;
    $("#gsave")?.addEventListener("click", () => { addPick({ league: L.id, athlete: a.displayName, athleteId: id, marketLabel: label, market: mk, side: "YES", odds, prob: p, eventDate: ev?.date, race: ev?.name }); toast("Saved"); });
  };
  ["#gm", "#gl", "#go"].forEach((s) => $(s).addEventListener("input", calc));
  calc();
}
