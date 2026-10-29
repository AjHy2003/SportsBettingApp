import { api, standingsTable, parseProps } from "../espn.js";
import * as M from "../model.js";
import { esc, loading, errorBox, setTitle, pct, fx, signed, fmtDate, fmtTime, cmpRow, toast } from "../ui.js";
import { addPick } from "../store.js";
import { loadDeep, deepGamePanel } from "../deep.js";
import { gameContext, defaultLines, evaluateLines, sideOdds } from "../gamemodel.js";
import { loadPeople, propRows, scanRows } from "../scan.js";
import { injuryReport } from "../context.js";
import { summaryClips, articleOf } from "../news.js";
import { gameWeather, weatherLine } from "../weather.js";
import { clipCard, storyRow, openPlayer } from "../video.js";

export async function renderGame(ctx, L, ev, q) {
  const { app } = ctx;
  app.innerHTML = loading("Loading matchup…");
  let sum;
  try {
    sum = await api.summary(L, ev);
  } catch (e) {
    if (ctx.alive()) app.innerHTML = errorBox(e);
    return;
  }
  const comp0 = sum.header?.competitions?.[0];
  if (!comp0) { app.innerHTML = errorBox("No game data"); return; }
  const homeId = comp0.competitors.find((c) => c.homeAway === "home").team.id;
  const awayId = comp0.competitors.find((c) => c.homeAway === "away").team.id;
  const state0 = comp0.status?.type?.state;

  const [standings, schedH, schedA, deep, propsAll, weather] = await Promise.all([
    api.standings(L).then(standingsTable).catch(() => null),
    api.schedule(L, homeId).catch(() => null),
    api.schedule(L, awayId).catch(() => null),
    loadDeep(L).catch(() => null),
    state0 !== "post" ? api.propBets(L, ev).then((items) => parseProps(items, L.markets)).catch(() => null) : null,
    state0 === "pre" ? gameWeather(L, sum).catch(() => null) : null,
  ]);
  if (!ctx.alive()) return;

  const gc = gameContext(L, sum, standings, schedH, schedA, weather);
  const { comp, home, away, H, A, status, resH, resA, rH, rA, lg, params, wModel, odds, fam } = gc;
  const isSoccer = fam === "soccer";
  const st = defaultLines(odds);
  if (q.sp != null) st.spreadHome = Number(q.sp);
  if (q.t != null) st.total = Number(q.t);

  setTitle(`${A.abbreviation} @ ${H.abbreviation}`);
  const logo = (t) => t.logos?.[0]?.href || t.logo || "";
  const rec = (c) => (c.record || c.records || [])[0]?.summary || "";
  const scoreLine = status.state !== "pre" ? `${away.score ?? ""} – ${home.score ?? ""} · ${esc(status.shortDetail || status.detail || "")}` : `${fmtDate(comp.date, { weekday: "long", month: "short", day: "numeric" })} · ${fmtTime(comp.date)}`;

  app.innerHTML = `
    <div class="crumbs"><a href="#/">Home</a> › <a href="#/l/${L.id}">${esc(L.name)}</a> › ${esc(A.abbreviation)} @ ${esc(H.abbreviation)}</div>
    <div class="card">
      <div class="row" style="justify-content:space-between;gap:16px">
        <div class="row"><img src="${esc(logo(A))}" alt="" style="width:46px;height:46px"/><div><h2 style="margin:0">${esc(A.displayName)}</h2><div class="muted small">${esc(rec(away))} · Away</div></div></div>
        <div style="text-align:center"><div style="font-weight:800;font-size:18px">${scoreLine}</div><div class="muted small">${esc(sum.gameInfo?.venue?.fullName || "")}</div>${weather ? `<div class="small" style="margin-top:2px">${esc(weatherLine(weather))}${gc.wx?.significant ? ` · <span style="color:var(--gold)" title="Model adjustment for wind, rain, snow and cold">scoring ×${gc.wx.total.toFixed(2)}, passing ×${gc.wx.pass.toFixed(2)}</span>` : ""}</div>` : ""}</div>
        <div class="row"><div style="text-align:right"><h2 style="margin:0">${esc(H.displayName)}</h2><div class="muted small">${esc(rec(home))} · Home</div></div><img src="${esc(logo(H))}" alt="" style="width:46px;height:46px"/></div>
      </div>
      ${status.state === "pre" ? `<div class="row" style="margin-top:10px"><a class="btn sm" href="#/today?sgp=${L.id}:${ev}">Build a same-game parlay ›</a></div>` : ""}
    </div>
    <div id="g-media"></div>
    <div class="grid two" style="margin-top:14px">
      <div class="card">
        <h3>Lines ${odds.provider ? `<span class="faint" style="text-transform:none;letter-spacing:0">· ${esc(odds.provider)}</span>` : ""}</h3>
        <div class="form-row">
          ${isSoccer ? "" : `<div class="field"><label>${esc(H.abbreviation)} spread</label><input id="g-sp" type="number" step="0.5"/></div>
          <div class="field"><label>${esc(H.abbreviation)} odds</label><input id="g-spo-h" type="number"/></div>
          <div class="field"><label>${esc(A.abbreviation)} odds</label><input id="g-spo-a" type="number"/></div>`}
        </div>
        <div class="form-row" style="margin-top:10px">
          <div class="field"><label>Total</label><input id="g-t" type="number" step="0.5"/></div>
          <div class="field"><label>Over odds</label><input id="g-oo" type="number"/></div>
          <div class="field"><label>Under odds</label><input id="g-uo" type="number"/></div>
        </div>
        <div class="form-row" style="margin-top:10px">
          <div class="field"><label>${esc(A.abbreviation)} ML</label><input id="g-mla" type="number"/></div>
          ${isSoccer ? `<div class="field"><label>Draw</label><input id="g-draw" type="number"/></div>` : ""}
          <div class="field"><label>${esc(H.abbreviation)} ML</label><input id="g-mlh" type="number"/></div>
        </div>
      </div>
      <div class="card" id="g-model"></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>Team comparison</h3><div class="cmp" id="g-cmp"></div></div>
    <div id="g-deep"></div>
    <div class="grid two" style="margin-top:14px">
      <div class="card"><h3>${esc(A.abbreviation)} recent</h3><div class="table-wrap">${recentTable(resA)}</div></div>
      <div class="card"><h3>${esc(H.abbreviation)} recent</h3><div class="table-wrap">${recentTable(resH)}</div></div>
    </div>
    <div class="grid two" style="margin-top:14px">
      <div class="card"><h3>Injuries</h3>${injuries(sum)}</div>
      <div class="card"><h3>Head to head</h3>${h2h(sum, resH, A)}</div>
    </div>
    <div class="card" style="margin-top:14px" id="g-props"></div>`;

  const $ = (s) => app.querySelector(s);
  const setv = (sel, v) => { const el = $(sel); if (el) el.value = v ?? ""; };
  setv("#g-sp", st.spreadHome); setv("#g-spo-h", st.spreadHomeOdds); setv("#g-spo-a", st.spreadAwayOdds);
  setv("#g-t", st.total); setv("#g-oo", st.overOdds); setv("#g-uo", st.underOdds);
  setv("#g-mla", st.mlAway); setv("#g-mlh", st.mlHome); setv("#g-draw", st.draw);
  const binds = { "#g-sp": "spreadHome", "#g-spo-h": "spreadHomeOdds", "#g-spo-a": "spreadAwayOdds", "#g-t": "total", "#g-oo": "overOdds", "#g-uo": "underOdds", "#g-mla": "mlAway", "#g-mlh": "mlHome", "#g-draw": "draw" };
  for (const [sel, key] of Object.entries(binds)) $(sel)?.addEventListener("input", (e) => { st[key] = e.target.value === "" ? null : Number(e.target.value); renderModel(); });

  $("#g-deep").innerHTML = deep ? deepGamePanel(L, deep, H, A) || "" : "";

  // Highlights (the full-game package first) and this game's recap/preview plus team news.
  const mine = (a) => a.teams.includes(String(H.id)) || a.teams.includes(String(A.id));
  const feed = (sum.news?.articles || []).map((a) => articleOf(a, L)).filter(mine);
  const clips = [
    ...summaryClips(sum, { league: L.id }).sort((a, b) => /game highlights/i.test(b.headline) - /game highlights/i.test(a.headline)),
    ...feed.filter((a) => a.kind === "video").slice(0, 4),
  ];
  const stories = [sum.article?.headline ? articleOf(sum.article, L) : null, ...feed.filter((a) => a.kind === "news" || a.kind === "story").slice(0, 3)].filter(Boolean);
  if (clips.length || stories.length) {
    $("#g-media").innerHTML = `<div class="card" style="margin-top:14px">
      ${clips.length ? `<div class="row" style="justify-content:space-between"><h3 style="margin:0">🎬 Highlights</h3>${clips.length > 1 ? `<button class="btn sm" id="g-playall">▶ Play all (${clips.length})</button>` : ""}</div>
      <div class="clip-grid compact" id="g-clips" style="margin-top:10px">${clips.map((c, i) => clipCard(c, i)).join("")}</div>` : ""}
      ${stories.length ? `<h3 style="margin:${clips.length ? "16px" : "0"} 0 4px">📰 ${stories[0].kind === "recap" ? "Recap & news" : stories[0].kind === "preview" ? "Preview & news" : "News"}</h3><div class="story-list">${stories.map((a) => storyRow(a)).join("")}</div>` : ""}
    </div>`;
    $("#g-clips")?.addEventListener("click", (e) => { const b = e.target.closest("[data-clip]"); if (b) openPlayer(clips, Number(b.dataset.clip)); });
    $("#g-playall")?.addEventListener("click", () => openPlayer(clips, 0, { autoNext: true }));
  }

  const unit = { basketball: "PPG", football: "PPG", baseball: "Runs/G", hockey: "Goals/G", soccer: "Goals/G" }[fam] || "PPG";
  const statRows = [
    cmpRow(`${unit} (season)`, rA.pfSeason, rH.pfSeason),
    cmpRow(`${unit} allowed`, rA.paSeason, rH.paSeason, { higherIsBetter: false }),
    cmpRow(`${unit} last 5`, rA.pf5, rH.pf5),
    cmpRow(`Allowed last 5`, rA.pa5, rH.pa5, { higherIsBetter: false }),
    cmpRow("Avg margin", rA.margin, rH.margin, { fmt: (v) => signed(v) }),
  ];
  // Pre-game season stats ESPN attaches to the box score (NFL: yards for/allowed).
  const bt = sum.boxscore?.teams || [];
  const bH = bt.find((t) => String(t.team?.id) === String(H.id));
  const bA = bt.find((t) => String(t.team?.id) === String(A.id));
  if (bH && bA && status.state === "pre") {
    for (const s of bH.statistics || []) {
      // Only the yardage splits are useful here (NFL); other leagues send records and totals.
      if (!/Yards/i.test(s.name)) continue;
      const o = (bA.statistics || []).find((x) => x.name === s.name);
      if (!o) continue;
      const a = parseFloat(o.displayValue), h = parseFloat(s.displayValue);
      if (!isFinite(a) || !isFinite(h)) continue;
      statRows.push(cmpRow(s.label || s.displayName || s.name, a, h, { higherIsBetter: !/Allowed/i.test(s.name) }));
    }
  }
  $("#g-cmp").innerHTML = `<div class="a"><b>${esc(A.abbreviation)}</b></div><div class="lbl"></div><div class="b"><b>${esc(H.abbreviation)}</b></div>${statRows.join("")}`;

  function renderModel() {
    const { g, rows } = evaluateLines(gc, st);
    const pred = sum.predictor;
    const dec = isSoccer || fam === "hockey" || fam === "baseball" ? 2 : 1;
    $("#g-model").innerHTML = `
      <h3>Model</h3>
      <div class="kpis" style="margin-top:0">
        <div class="kpi"><div class="k">${esc(A.abbreviation)}</div><div class="v">${fx(g.projAway, dec)}</div></div>
        <div class="kpi"><div class="k">${esc(H.abbreviation)}</div><div class="v">${fx(g.projHome, dec)}</div></div>
        <div class="kpi"><div class="k">Margin (H)</div><div class="v">${signed(g.margin, dec)}</div></div>
        <div class="kpi"><div class="k">Total</div><div class="v">${fx(g.total, dec)}</div></div>
      </div>
      <table style="margin-top:12px"><thead><tr><th>Market</th><th>Pick</th><th class="r">Prob</th><th class="r">Edge</th><th class="r">Grade</th><th></th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td>${r.label}<div class="faint small">${esc(r.info)}</div></td><td><b>${esc(r.v.side || `lean ${r.v.lean}`)}</b></td><td class="r">${pct(r.v.prob, 1)}</td><td class="r ${r.v.edge > 0 ? "pos" : "neg"}">${signed(r.v.edge * 100, 1)}</td><td class="r"><b>${r.v.grade}</b></td><td><button class="btn ghost sm" data-save="${i}">★</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">Enter a spread or total to evaluate.</td></tr>`}
      </tbody></table>
      ${pred?.homeTeam?.gameProjection ? `<p class="small muted" style="margin:10px 0 0">ESPN Matchup Predictor: ${esc(H.abbreviation)} ${fx(Number(pred.homeTeam.gameProjection))}% to win.</p>` : ""}
      <details class="explain" style="margin-top:8px"><summary>How this is calculated</summary>
        <p>Each team's scoring rate = season ${unit} shrunk toward the league average (${fx(lg, dec)}) by sample size, blended 70/30 with the last 5 games. Projected score = team offense × opponent defense ÷ league average, plus ${fx(params.hfa, 2)} home edge. ${params.kind === "poisson" ? "Scores are modelled as Poisson, so low-scoring sports get real draw/one-goal probabilities." : `Margin SD ${params.sdMargin}, total SD ${params.sdTotal}.`} Because game lines are very efficient, the final probability is ${Math.round(wModel * 100)}% this model and ${Math.round((1 - wModel) * 100)}% the sportsbook's no-vig price, so a grade only appears when the stats disagree with the market by a lot. The model doesn't know about injuries, rest or weather.</p>
      </details>`;
    $("#g-model").querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", () => {
      const r = rows[Number(b.dataset.save)];
      const side = r.v.side || r.v.lean;
      addPick({ league: L.id, eventId: ev, eventDate: comp.date, athlete: `${A.abbreviation} @ ${H.abbreviation}`, marketLabel: r.label, market: r.key, side, prob: r.v.prob, grade: r.v.grade, game: true, homeId: H.id, awayId: A.id, homeAbbr: H.abbreviation, awayAbbr: A.abbreviation, line: r.line ?? null, odds: sideOdds(r, side) });
      toast(`Saved: ${side}`);
    }));
  }
  renderModel();
  renderPropsBoard(ctx, L, ev, comp, H, A, propsAll, standings, deep, { spreadHome: odds.spreadHome, total: odds.total }, injuryReport(sum), weather);
}

function recentTable(res) {
  if (!res.length) return `<div class="muted small">No completed games this season.</div>`;
  return `<table><thead><tr><th>Date</th><th>Opp</th><th class="r">Score</th><th class="r">Margin</th></tr></thead><tbody>
    ${res.slice(0, 8).map((g) => `<tr><td>${fmtDate(g.date)}</td><td>${g.home ? "vs" : "@"} ${esc(g.opp)}</td><td class="r ${g.win ? "o" : "u"}">${g.win ? "W" : "L"} ${g.pf}-${g.pa}</td><td class="r">${signed(g.pf - g.pa, 0)}</td></tr>`).join("")}
  </tbody></table>`;
}

function injuries(sum) {
  const teams = sum.injuries || [];
  const rows = teams.flatMap((t) => (t.injuries || []).map((i) => ({ team: t.team?.abbreviation, name: i.athlete?.displayName, pos: i.athlete?.position?.abbreviation, status: i.status })));
  if (!rows.length) return `<div class="muted small">No injuries reported.</div>`;
  return `<div class="table-wrap"><table><tbody>${rows.slice(0, 30).map((r) => `<tr><td>${esc(r.team)}</td><td>${esc(r.name)} <span class="faint">${esc(r.pos || "")}</span></td><td class="${/out/i.test(r.status) ? "neg" : ""}">${esc(r.status)}</td></tr>`).join("")}</tbody></table></div>`;
}

function h2h(sum, resH, A) {
  const meetings = resH.filter((g) => String(g.oppId) === String(A.id));
  const series = sum.seasonseries?.[0];
  const lines = [];
  if (series?.summary) lines.push(`<p class="small">${esc(series.summary)}</p>`);
  if (!meetings.length) return lines.join("") + `<div class="muted small">No meetings yet this season.</div>`;
  return lines.join("") + recentTable(meetings);
}

// ---------- props board ----------
async function renderPropsBoard(ctx, L, ev, comp, H, A, propsAll, standings, deep, lines, report, weather) {
  const box = ctx.app.querySelector("#g-props");
  if (!propsAll || !propsAll.size) {
    box.innerHTML = `<h3>Player props</h3><div class="muted small">No player prop lines posted for this game yet. Open any player from search to analyze your own line.</div>`;
    return;
  }
  box.innerHTML = `<h3>Player props</h3>${loading("Loading rosters…")}`;
  const people = await loadPeople(L, [H, A]);
  if (!ctx.alive()) return;
  const rows = propRows(L, propsAll, people);

  const draw = () => {
    rows.sort((a, b) => (b.edge ?? -9) - (a.edge ?? -9) || a.who.name.localeCompare(b.who.name));
    box.innerHTML = `
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">Player props · DraftKings</h3>
        <button class="btn sm" id="scan">${rows.some((r) => r.res) ? "Re-scan" : "Scan all props"}</button></div>
      <p class="small muted">Scan runs the full model on every posted line (game logs for each player, so it takes a few seconds) and sorts by edge.</p>
      <div class="table-wrap"><table><thead><tr><th>Player</th><th>Market</th><th class="r">Line</th><th class="r">Over</th><th class="r">Under</th><th class="r">Proj</th><th class="r">P(over)</th><th>Pick</th><th class="r">Edge</th><th class="r">Grade</th><th></th></tr></thead><tbody>
      ${rows.map((r) => {
        const v = r.res?.verdict;
        const flag = r.out ? ` <span class="pill neg">${esc(r.out)}</span>` : r.context?.status?.maybe ? ` <span class="pill" style="color:var(--gold)">${esc(r.context.status.status)}</span>` : r.res?.verdict?.roleChange ? ` <span class="pill" style="color:var(--gold)" title="${esc(r.res.verdict.roleChange.join(", "))} out: likely a bigger role tonight">role change</span>` : r.context?.withWithout?.notes.length ? ` <span class="pill gold" title="${esc(r.context.withWithout.notes[0])}">teammate out</span>` : "";
        return `<tr class="${v && v.grade !== "PASS" ? "hl" : ""}"><td>${esc(r.who.name)} <span class="faint">${esc(r.who.team?.abbreviation || "")} ${esc(r.who.pos || "")}</span>${flag}</td><td>${esc(r.m.label)}</td>
        <td class="r">${r.p.line}</td><td class="r">${M.fmtOdds(r.p.over)}</td><td class="r">${M.fmtOdds(r.p.under)}</td>
        <td class="r">${r.res ? fx(r.res.projection) : r.err ? "—" : ""}</td><td class="r">${r.res ? pct(r.res.pOver) : ""}</td>
        <td>${v ? `<b class="${v.lean === "OVER" ? "pos" : "neg"}">${v.lean}</b>` : ""}</td><td class="r">${v ? signed(v.edge * 100, 1) : ""}</td><td class="r"><b>${v ? v.grade : ""}</b></td>
        <td><a class="btn ghost sm" href="#/l/${L.id}/p/${r.aid}?m=${r.key}&line=${r.p.line}${r.p.over != null ? `&oo=${r.p.over}` : ""}${r.p.under != null ? `&uo=${r.p.under}` : ""}">Analyze ›</a></td></tr>`;
      }).join("")}</tbody></table></div>`;
    box.querySelector("#scan").addEventListener("click", scan);
  };
  async function scan() {
    const btn = box.querySelector("#scan");
    btn.disabled = true;
    btn.textContent = "Scanning…";
    await scanRows(L, rows, {
      game: { H, A, date: comp.date, lines, report, weather }, standings, deep,
      onProgress: (d, n) => { if (ctx.alive()) btn.textContent = `Scanning ${d}/${n}…`; },
    });
    if (ctx.alive()) draw();
  }
  draw();
}
