import * as M from "../model.js";
import { esc, setTitle, pct, fx, signed, hitTile, gameChart, wireChartTips, toast } from "../ui.js";
import { addPick } from "../store.js";

const EXAMPLES = {
  "Tennis — aces": "12, 8, 15, 9, 11, 6, 14, 10",
  "UFC — significant strikes": "64, 41, 88, 52, 30, 71",
  "Cricket — batter runs": "45, 12, 78, 33, 0, 56, 21, 90, 14, 38",
  "Boxing — rounds lasted": "12, 7, 12, 4, 10, 12",
  "Darts — 180s": "6, 4, 9, 5, 7, 3",
};

export function renderCustom({ app }, q) {
  setTitle("Custom calculator");
  app.innerHTML = `
    <div class="crumbs"><a href="#/">Home</a> › Custom calculator</div>
    <h1>🧮 Custom prop calculator</h1>
    <p class="sub">For any sport or stat that isn't covered automatically — boxing, cricket, swimming, darts, esports, tennis aces. Paste recent results (most recent first) and your line.</p>
    <div class="grid two">
      <div class="card">
        <div class="field"><label for="c-name">What are you betting?</label><input id="c-name" placeholder="e.g. Sinner aces" value="${esc(q.name || "")}"/></div>
        <div class="field" style="margin-top:10px"><label for="c-vals">Recent results (most recent first)</label><textarea id="c-vals" rows="3" placeholder="12, 8, 15, 9, 11">${esc(q.v || "")}</textarea></div>
        <div class="chips" style="margin-top:8px">${Object.keys(EXAMPLES).map((k) => `<button class="chip" data-ex="${esc(k)}">${esc(k)}</button>`).join("")}</div>
        <div class="form-row" style="margin-top:12px">
          <div class="field"><label for="c-line">Line</label><input id="c-line" type="number" step="0.5" value="${esc(q.line || "")}"/></div>
          <div class="field"><label for="c-oo">Over odds</label><input id="c-oo" type="number" placeholder="-110"/></div>
          <div class="field"><label for="c-uo">Under odds</label><input id="c-uo" type="number" placeholder="-110"/></div>
        </div>
        <div class="form-row" style="margin-top:10px">
          <div class="field"><label for="c-dist">Stat type</label><select id="c-dist">
            <option value="auto">Auto-detect</option><option value="negbin">Count (strikes, aces, shots)</option><option value="poisson">Rare count (goals, TDs, 180s)</option><option value="normal">Large total (yards, runs, points)</option><option value="continuous">Time / decimal (seconds, distance)</option></select></div>
          <div class="field"><label for="c-adj">Matchup adj. %</label><input id="c-adj" type="number" step="5" value="0"/></div>
        </div>
        <p class="small faint" style="margin:8px 0 0">Matchup adj.: your read on the opponent, venue or conditions, e.g. −10 vs an elite returner, +10 on a fast court.</p>
      </div>
      <div class="card" id="c-verdict"><div class="muted">Enter at least 3 results and a line.</div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>Hit rate</h3><div class="hits" id="c-hits"></div></div>
    <div class="card" style="margin-top:14px"><h3>Results</h3><div id="c-chart"></div></div>
    <div class="card" style="margin-top:14px">
      <h3>Odds tools</h3>
      <div class="form-row">
        <div class="field"><label>American odds</label><input id="t-am" type="number" placeholder="+150"/></div>
        <div class="field"><label>Implied %</label><input id="t-pct" type="number" step="0.1" placeholder="40"/></div>
        <div class="field"><label>Parlay legs (odds, comma separated)</label><input id="t-par" placeholder="-110, -110, +120"/></div>
      </div>
      <div id="t-out" class="small" style="margin-top:8px"></div>
    </div>`;

  const $ = (s) => app.querySelector(s);
  wireChartTips(app);

  function calc() {
    const raw = $("#c-vals").value.trim();
    const values = raw ? raw.split(/[\s,;]+/).filter(Boolean).map(Number).filter(isFinite) : [];
    const line = Number($("#c-line").value);
    if (values.length < 3 || !$("#c-line").value) {
      $("#c-verdict").innerHTML = `<div class="muted">Enter at least 3 results and a line.</div>`;
      $("#c-hits").innerHTML = "";
      $("#c-chart").innerHTML = values.length ? gameChart(values.map((v, i) => ({ value: v, opp: `#${i + 1}` })), line, null) : "";
      return;
    }
    let dist = $("#c-dist").value;
    if (dist === "auto") {
      const allInt = values.every(Number.isInteger);
      const m = M.mean(values);
      dist = !allInt ? "continuous" : m < 3 ? "poisson" : m < 40 ? "negbin" : "normal";
    }
    const games = values.map((v) => ({ value: v }));
    const res = M.analyzeProp(games, { line, oddsOver: $("#c-oo").value || null, oddsUnder: $("#c-uo").value || null, dist, roleAdj: Number($("#c-adj").value) || 0, halfLife: 8 });
    const v = res.verdict;
    const name = $("#c-name").value || "Custom prop";
    $("#c-verdict").innerHTML = `
      <div class="verdict"><div class="grade ${v.grade}">${v.grade}</div><div>
        <div class="call">${v.side ? `<span class="${v.lean === "OVER" ? "over" : "under"}">${v.side}</span> ${line}` : `PASS <span class="muted" style="font-size:14px">· leans ${v.lean.toLowerCase()}</span>`}</div>
        <div class="small muted">Model ${pct(v.prob, 1)} · edge ${signed(v.edge * 100, 1)} pts · EV ${signed(v.ev * 100, 1)}%</div></div></div>
      <div class="kpis">
        <div class="kpi"><div class="k">Projection</div><div class="v">${fx(res.projection)}</div></div>
        <div class="kpi"><div class="k">P(over)</div><div class="v">${pct(res.pOver)}</div></div>
        <div class="kpi"><div class="k">Fair over</div><div class="v">${M.fmtOdds(res.fairOver)}</div></div>
        <div class="kpi"><div class="k">Avg / Med</div><div class="v">${fx(res.avg)} <small>/ ${fx(res.median)}</small></div></div>
      </div>
      <button class="btn sm" id="c-save" style="margin-top:12px">★ Save pick</button>
      <p class="small faint" style="margin:10px 0 0">Model: ${dist === "normal" ? "normal" : dist === "poisson" ? "Poisson" : dist === "continuous" ? "continuous normal" : "negative binomial"} fit to these ${res.n} results with recent ones weighted more, blended with the raw hit rate.</p>`;
    $("#c-save").onclick = () => { addPick({ league: "custom", athlete: name, marketLabel: name, side: v.side || v.lean, line, odds: v.lean === "OVER" ? res.oddsOver : res.oddsUnder, prob: v.prob, grade: v.grade }); toast("Saved"); };
    const side = v.lean === "UNDER" ? "under" : "over";
    $("#c-hits").innerHTML = [["Last 5", values.slice(0, 5)], ["Last 10", values.slice(0, 10)], ["All", values]].map(([l, a]) => hitTile(l, M.hitRate(a, line), side)).join("");
    $("#c-chart").innerHTML = gameChart(values.map((x, i) => ({ value: x, opp: `#${i + 1}` })), line, res.projection);
  }

  function tools() {
    const am = Number($("#t-am").value);
    const p = Number($("#t-pct").value) / 100;
    const legs = $("#t-par").value.split(/[,\s]+/).map(Number).filter((x) => x && isFinite(x));
    const out = [];
    if (am) out.push(`${M.fmtOdds(am)} → implied <b>${pct(M.impliedProb(am), 1)}</b>, pays ${fx(M.payout(am) * 100, 0)} per 100.`);
    if (p > 0 && p < 1) out.push(`${pct(p, 1)} → fair odds <b>${M.fmtOdds(M.toAmerican(p))}</b>.`);
    if (legs.length >= 2) {
      const dec = legs.reduce((d, o) => d * (1 + M.payout(o)), 1);
      const ip = legs.reduce((t, o) => t * M.impliedProb(o), 1);
      out.push(`${legs.length}-leg parlay pays <b>${M.fmtOdds(M.toAmerican(1 / dec))}</b> (${fx(dec, 2)}x); needs every leg — ${pct(ip, 1)} if each leg is priced fairly.`);
    }
    $("#t-out").innerHTML = out.join("<br/>");
  }

  app.querySelectorAll("[data-ex]").forEach((b) => b.addEventListener("click", () => {
    $("#c-vals").value = EXAMPLES[b.dataset.ex];
    $("#c-name").value = b.dataset.ex;
    const m = M.median($("#c-vals").value.split(/[,\s]+/).map(Number));
    $("#c-line").value = Math.round(m) + 0.5;
    calc();
  }));
  ["#c-vals", "#c-line", "#c-oo", "#c-uo", "#c-dist", "#c-adj", "#c-name"].forEach((s) => $(s).addEventListener("input", calc));
  ["#t-am", "#t-pct", "#t-par"].forEach((s) => $(s).addEventListener("input", tools));
  calc();
}
