import { api, loadGamelogs, parseProps, standingsTable, pickcenterOdds } from "../espn.js";
import * as M from "../model.js";
import { esc, loading, errorBox, setTitle, pct, fx, signed, fmtDate, fmtTime, hitTile, gameChart, wireChartTips, toast } from "../ui.js";
import { addPick } from "../store.js";
import { loadDeep, loadDeepPlayer, deepPlayerPanel } from "../deep.js";
import { mergeDeepStats } from "../scan.js";
import { MODEL_SAMPLE, marketsFor, defaultMarket, opponentFactor, runProp, playedGames, combineOpponent, PREV_SEASON_W, OLD_TEAM_W } from "../props.js";
import { injuryReport, playerContext, roleChange } from "../context.js";
import { articleOf } from "../news.js";
import { clipCard, storyRow, openPlayer } from "../video.js";

export async function renderPlayer(ctx, L, id, q) {
  const { app } = ctx;
  app.innerHTML = loading("Loading player…");
  const fam0 = L.markets;
  let ath, ov, log;
  try {
    [ath, ov, log] = await Promise.all([
      api.athlete(L, id).catch(() => null),
      api.overview(L, id).catch(() => null),
      loadGamelogs(L, id, fam0),
    ]);
  } catch (e) {
    if (ctx.alive()) app.innerHTML = errorBox(e, "ESPN may not have a game log for this player.");
    return;
  }
  if (!ctx.alive()) return;

  const a = ath?.athlete || { displayName: log.games[0] ? "Player" : "Unknown player", id };
  const fam = log.family;
  const games = playedGames(log, ath?.athlete?.team?.id);
  setTitle(a.displayName);

  // Next game + lines.
  const next = await findNextGame(L, a.team?.id || games[0]?.teamId, ov);
  if (!ctx.alive()) return;

  const upcoming = next && next.state !== "post";
  const [propsAll, standings, deep, deepPlayer, nextSum] = await Promise.all([
    upcoming ? api.propBets(L, next.id).then((items) => parseProps(items, L.markets)).catch(() => null) : null,
    api.standings(L).then(standingsTable).catch(() => null),
    loadDeep(L).catch(() => null),
    loadDeepPlayer(L, id).catch(() => null),
    upcoming ? api.summary(L, next.id).catch(() => null) : null,
  ]);
  if (!ctx.alive()) return;
  const myProps = propsAll?.get(String(id)) || {};
  mergeDeepStats(L, games, deepPlayer);
  if (deepPlayer) {
    if (!a.position && deepPlayer.pos) a.position = { abbreviation: deepPlayer.pos };
    if (!a.team?.abbreviation && deepPlayer.team) a.team = { ...(a.team || {}), abbreviation: deepPlayer.team };
    if (a.displayName === "Player" && deepPlayer.name) a.displayName = deepPlayer.name;
  }

  const markets = marketsFor(fam, games);
  if (!markets.length) {
    app.innerHTML = `${header(L, a, next, ov)}<div class="notice">No stat history found for ${esc(a.displayName)} yet.</div>`;
    return;
  }

  const startKey = q.m && markets.find((m) => m.key === q.m) ? q.m : defaultMarket(markets, games);
  const state = {
    market: startKey,
    line: q.line != null ? Number(q.line) : null,
    oddsOver: q.oo ?? null,
    oddsUnder: q.uo ?? null,
    win: "L20",
    loc: "all",
    vsOpp: false,
    minutes: "",
    role: 0,
    useOpp: true,
    useCtx: true,
  };
  // Tonight's game context (Vegas lines, injuries) per market, computed lazily.
  const nextOdds = nextSum ? pickcenterOdds(nextSum.pickcenter?.[0]) : null;
  const nextLines = nextOdds ? { spreadHome: nextOdds.spreadHome, total: nextOdds.total } : null;
  const report = nextSum ? injuryReport(nextSum) : null;
  const teamId = a.team?.id || games[0]?.teamId;
  const ctxCache = new Map();
  function contextFor(m) {
    if (!next || (!nextLines && !report)) return null;
    if (!ctxCache.has(m.key)) {
      ctxCache.set(m.key, null);
      playerContext({ L, fam, m, games, teamId, teamAbbr: a.team?.abbreviation, isHome: next.home, lines: nextLines, standings, report, playerId: id })
        .then((c) => { ctxCache.set(m.key, c); if (ctx.alive() && state.market === m.key) render(); })
        .catch(() => { ctxCache.set(m.key, { factor: 1, minutesFactor: 1, notes: [] }); if (ctx.alive() && state.market === m.key) render(); });
    }
    return ctxCache.get(m.key);
  }

  app.innerHTML = `
    <div class="crumbs"><a href="#/">Home</a> › <a href="#/l/${L.id}">${esc(L.name)}</a> › ${esc(a.displayName)}</div>
    ${header(L, a, next, ov)}
    <div class="card" style="margin-top:14px">
      <h3>Market</h3>
      <div class="chips scroll" id="mk">${markets.map((m) => `<button class="chip" data-k="${m.key}">${esc(m.label)}${myProps[m.key] ? ` <span class="pill gold" style="padding:0 6px">${myProps[m.key].line}</span>` : ""}</button>`).join("")}</div>
    </div>
    <div class="grid two" style="margin-top:14px">
      <div class="card">
        <h3>Your line</h3>
        <div class="form-row">
          <div class="field"><label for="f-line">Line</label><input id="f-line" type="number" step="0.5" inputmode="decimal"/></div>
          <div class="field"><label for="f-oo">Over odds</label><input id="f-oo" type="number" inputmode="numeric" placeholder="-110"/></div>
          <div class="field"><label for="f-uo">Under odds</label><input id="f-uo" type="number" inputmode="numeric" placeholder="-110"/></div>
        </div>
        <div id="book" class="small muted" style="margin-top:8px"></div>
        <div class="form-row" style="margin-top:12px">
          <div class="field" id="min-field"><label for="f-min">Expected minutes</label><input id="f-min" type="number" step="1" inputmode="numeric" placeholder="auto"/></div>
          <div class="field"><label for="f-role">Role / injury adj. %</label><input id="f-role" type="number" step="5" value="0" inputmode="numeric"/></div>
          <div class="field"><label for="f-opp">Opponent adj.</label><select id="f-opp"><option value="1">On</option><option value="0">Off</option></select></div>
          <div class="field"><label for="f-ctx">Tonight's context</label><select id="f-ctx"><option value="1">On</option><option value="0">Off</option></select></div>
        </div>
        <p class="small faint" style="margin:8px 0 0">Tonight's context = Vegas team total, game script, blowout risk and injured teammates (with/without splits), applied automatically. Role adj. is for anything else you know, e.g. −20 for a minutes limit.</p>
      </div>
      <div class="card" id="verdict"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">Hit rate</h3><span class="small muted" id="hr-side"></span></div>
      <div class="hits" id="hits" style="margin-top:10px"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="row" style="margin-bottom:10px">
        <div class="seg" id="win">${["L5", "L10", "L20", "Season", "Last season", "All"].map((w) => `<button data-w="${w}">${w}</button>`).join("")}</div>
        <div class="seg" id="loc"><button data-l="all">All</button><button data-l="home">Home</button><button data-l="away">Away</button></div>
        ${next?.oppId ? `<button class="chip" id="vsopp">vs ${esc(next.opp)} only</button>` : ""}
      </div>
      <div id="chart"></div>
    </div>
    <div class="grid two" style="margin-top:14px">
      <div class="card"><h3>Splits</h3><div id="splits"></div></div>
      <div class="card"><h3>Matchup & context</h3><div id="context"></div></div>
    </div>
    <div id="deep"></div>
    <div id="p-news"></div>
    <div class="card" style="margin-top:14px"><h3>Game log</h3><div class="table-wrap" id="log"></div></div>
    <details class="explain card" style="margin-top:14px"><summary>How this was calculated</summary><div id="notes"></div></details>`;

  // Player news and video from ESPN.
  const pNews = (ov?.news || []).map((x) => articleOf(x, L)).filter((x) => x.headline);
  const pClips = pNews.filter((x) => x.kind === "video").slice(0, 6);
  const pStories = pNews.filter((x) => x.kind !== "video").slice(0, 5);
  if (pNews.length) {
    const box = app.querySelector("#p-news");
    box.innerHTML = `<div class="card" style="margin-top:14px">
      <h3>📰 ${esc(a.displayName)} news</h3>
      ${pStories.length ? `<div class="story-list">${pStories.map((x) => storyRow(x)).join("")}</div>` : ""}
      ${pClips.length ? `<div class="clip-grid compact" id="p-clips" style="margin-top:12px">${pClips.map((c, i) => clipCard(c, i)).join("")}</div>` : ""}
    </div>`;
    box.querySelector("#p-clips")?.addEventListener("click", (e) => { const b = e.target.closest("[data-clip]"); if (b) openPlayer(pClips, Number(b.dataset.clip)); });
  }

  const $ = (s) => app.querySelector(s);
  wireChartTips(app);

  const market = () => markets.find((m) => m.key === state.market);

  function seedLine() {
    const m = market();
    const p = myProps[m.key];
    if (p) {
      state.line = p.line;
      state.oddsOver = p.over;
      state.oddsUnder = p.under;
      state.lineSource = "book";
    } else {
      state.lineSource = "seed";
      // Placeholder near the projection (books hang main lines close to the expected value).
      const proj = runProp(fam, m, games, { line: 0.5 }).res.projection;
      state.line = isFinite(proj) ? Math.max(0.5, Math.floor(proj) + 0.5) : 0.5;
      state.oddsOver = null;
      state.oddsUnder = null;
    }
  }
  if (state.line == null) seedLine();
  else state.lineSource = "user";

  function syncInputs() {
    $("#f-line").value = state.line ?? "";
    $("#f-oo").value = state.oddsOver ?? "";
    $("#f-uo").value = state.oddsUnder ?? "";
    app.querySelectorAll("#mk .chip").forEach((b) => b.classList.toggle("on", b.dataset.k === state.market));
    app.querySelectorAll("#win button").forEach((b) => b.classList.toggle("on", b.dataset.w === state.win));
    app.querySelectorAll("#loc button").forEach((b) => b.classList.toggle("on", b.dataset.l === state.loc));
    $("#vsopp")?.classList.toggle("on", state.vsOpp);
    $("#min-field").classList.toggle("hidden", !market().perMinute);
  }

  const oppAdjust = (m) => opponentFactor({ L, fam, m, next, standings, deep, athlete: a });

  function windowGames(list) {
    let g = list;
    if (state.loc !== "all") g = g.filter((x) => x.home === (state.loc === "home"));
    if (state.vsOpp && next?.oppId) g = g.filter((x) => String(x.oppId) === String(next.oppId));
    const curSeason = log.season;
    switch (state.win) {
      case "L5": return g.slice(0, 5);
      case "L10": return g.slice(0, 10);
      case "L20": return g.slice(0, 20);
      case "Season": return g.filter((x) => x.season === curSeason);
      case "Last season": return g.filter((x) => x.season !== curSeason);
      default: return g;
    }
  }

  function render() {
    const m = market();
    const line = Number(state.line);
    const opp0 = state.useOpp ? oppAdjust(m) : { factor: 1, why: "Opponent adjustment turned off." };
    const gctx = state.useCtx ? contextFor(m) : null;
    const opp = combineOpponent(opp0, gctx);
    const { res, withVal } = runProp(fam, m, games, { line, oddsOver: state.oddsOver, oddsUnder: state.oddsUnder, opp: opp0, role: state.role, minutes: state.minutes, posted: myProps[m.key], context: gctx });
    if (gctx?.status?.maybe && res.verdict && ["A", "B"].includes(res.verdict.grade)) { res.verdict.grade = "C"; res.verdict.questionable = true; }
    if (gctx?.status?.out && res.verdict) { res.verdict.grade = "PASS"; res.verdict.side = null; }
    const rc = res.verdict && roleChange(gctx, a.position?.abbreviation, res.verdict.lean, line, res.projection);
    if (rc) { res.verdict.grade = "PASS"; res.verdict.side = null; res.verdict.roleChange = rc; }

    // Book info
    const p = myProps[m.key];
    $("#book").innerHTML = p
      ? `DraftKings: <b>${p.line}</b> (o ${M.fmtOdds(p.over)} / u ${M.fmtOdds(p.under)})${p.open != null && p.open !== p.line ? ` · opened ${p.open}` : ""}${p.alts > 1 ? ` · ${p.alts} lines posted, showing the main one` : ""}`
      : next ? `No posted ${esc(m.label.toLowerCase())} line found for the next game; the starting line is set near the projection.` : "";

    // Verdict (no grade on a placeholder line the user hasn't confirmed)
    const v = state.lineSource === "seed" ? { ...(res.verdict || {}), side: null, grade: "—", placeholder: true } : res.verdict || {};
    const sideCls = v.lean === "OVER" ? "over" : "under";
    const hrAll = M.hitRate(withVal.slice(0, 10).map((g) => g.value), line);
    $("#verdict").innerHTML = `
      <div class="verdict">
        <div class="grade ${v.grade}">${v.grade || "—"}</div>
        <div>
          <div class="call">${v.placeholder ? `Enter your line <span class="muted" style="font-size:14px;font-weight:600">· leans ${v.lean === "OVER" ? "over" : "under"} ${line}</span>` : v.side ? `<span class="${sideCls}">${v.side}</span> ${line} ${esc(m.label)}` : `PASS <span class="muted" style="font-size:14px;font-weight:600">· leans ${v.lean === "OVER" ? "over" : "under"}</span>`}</div>
          ${v.placeholder ? `<div class="small muted">No sportsbook line is posted for this market yet. Type the line and odds from your book above to get a grade.</div>` : ""}
          ${v.capped && !v.placeholder ? `<div class="small faint">Capped at B: no market price to compare against.</div>` : ""}
          ${gctx?.status ? `<div class="notice warn" style="margin-top:6px">Injury report: <b>${esc(gctx.status.status)}</b>${gctx.status.out ? " — no grade; props are usually voided if the player doesn't play." : v.questionable ? " — grade capped at C until the status clears." : ""}</div>` : ""}
          ${v.roleChange ? `<div class="notice warn" style="margin-top:6px">${esc(v.roleChange.join(", "))} ${v.roleChange.length > 1 ? "are" : "is"} out tonight, and this player has rarely played without ${v.roleChange.length > 1 ? "them" : "that teammate"}. A line this far above the projection is likely the book pricing a bigger role. No grade on the under.</div>` : ""}
          ${v.mismatch && !v.placeholder ? `<div class="notice warn" style="margin-top:6px">The line (${line}) is far from recent production (projection ${fx(res.projection)}). Books move a line this far when they know something the box score doesn't: an injury, a new starting role, a minutes limit. ${v.grade === "PASS" ? "No grade until you've checked the news." : "Grade capped at C."}</div>` : ""}
          <div class="small muted">${v.lean ? `Model ${pct(v.prob, 1)} vs ${pct(M.impliedProb(v.lean === "OVER" ? res.oddsOver : res.oddsUnder), 1)} needed to break even · edge ${signed(v.edge * 100, 1)} pts · EV ${signed(v.ev * 100, 1)}%` : ""}</div>
          ${res.statsOver != null ? `<div class="small faint">Over: stats only ${pct(res.statsOver)}${res.marketProb != null ? ` · market ${pct(res.marketProb)} · blended ${pct(res.pOver / (1 - res.pPush))}` : " · no market anchor"}</div>` : ""}
        </div>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="k">Projection</div><div class="v">${fx(res.projection)}</div></div>
        <div class="kpi"><div class="k">P(over)</div><div class="v ${res.pOver > 0.5 ? "pos" : "neg"}">${pct(res.pOver)}</div></div>
        <div class="kpi"><div class="k">Fair odds</div><div class="v">${M.fmtOdds(v.lean === "OVER" ? res.fairOver : res.fairUnder)} <small>${v.lean === "OVER" ? "o" : "u"}</small></div></div>
        <div class="kpi"><div class="k">Avg / Med</div><div class="v">${fx(res.avg)} <small>/ ${fx(res.median)}</small></div></div>
        <div class="kpi"><div class="k">L10 over</div><div class="v">${hrAll.over}/${hrAll.over + hrAll.under}</div></div>
        ${res.expMinutes ? `<div class="kpi"><div class="k">Exp. min</div><div class="v">${fx(res.expMinutes)}</div></div>` : ""}
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn sm" id="save">★ Save pick</button>
        ${res.pPush > 0.02 ? `<span class="small muted">Push chance ${pct(res.pPush)}</span>` : ""}
      </div>`;
    $("#save").onclick = () => {
      const side = v.side || v.lean;
      const ok = addPick({
        league: L.id, athleteId: id, athlete: a.displayName, market: m.key, marketLabel: m.label, line,
        side, odds: side === "OVER" ? res.oddsOver : res.oddsUnder, prob: v.prob, grade: v.grade,
        eventId: next?.id, eventDate: next?.date, opp: next?.opp, projection: res.projection,
      });
      toast(ok ? `Saved: ${a.displayName} ${side} ${line} ${m.label}` : "Couldn't save (storage blocked)");
    };

    // Hit-rate tiles
    const side = v.lean === "UNDER" ? "under" : "over";
    $("#hr-side").textContent = `Showing ${side} hit rates at ${line}`;
    const vals = (arr) => arr.map((g) => g.value);
    const cur = withVal.filter((g) => g.season === log.season);
    const prev = withVal.filter((g) => g.season !== log.season);
    const tiles = [
      ["L5", M.hitRate(vals(withVal.slice(0, 5)), line)],
      ["L10", M.hitRate(vals(withVal.slice(0, 10)), line)],
      ["L20", M.hitRate(vals(withVal.slice(0, 20)), line)],
      ["This season", M.hitRate(vals(cur), line)],
      ["Last season", M.hitRate(vals(prev), line)],
    ];
    if (next) {
      tiles.push([next.home ? "Home" : "Away", M.hitRate(vals(withVal.filter((g) => g.home === next.home).slice(0, 20)), line)]);
      if (next.oppId) tiles.push([`vs ${next.opp}`, M.hitRate(vals(withVal.filter((g) => String(g.oppId) === String(next.oppId))), line)]);
    }
    $("#hits").innerHTML = tiles.map(([l, h]) => hitTile(l, h, side)).join("");

    // Chart
    const wg = windowGames(withVal);
    $("#chart").innerHTML = gameChart(wg, line, res.projection);

    // Splits
    const avgOf = (arr) => (arr.length ? M.mean(arr.map((g) => g.value)) : NaN);
    const rows = [
      ["Home", withVal.filter((g) => g.home)],
      ["Away", withVal.filter((g) => !g.home)],
      ["Wins", withVal.filter((g) => g.result === "W")],
      ["Losses", withVal.filter((g) => g.result === "L")],
    ];
    if (fam === "basketball" || fam === "hockey") {
      rows.push(["0 days rest (B2B)", withVal.filter((g) => g.rest === 0)]);
      rows.push(["1+ days rest", withVal.filter((g) => g.rest > 0)]);
    }
    if (next?.oppId) rows.push([`vs ${next.opp}`, withVal.filter((g) => String(g.oppId) === String(next.oppId))]);
    $("#splits").innerHTML = `<table><thead><tr><th>Split</th><th class="r">G</th><th class="r">Avg</th><th class="r">Over ${line}</th></tr></thead><tbody>
      ${rows.map(([lbl, arr]) => {
        const h = M.hitRate(vals(arr), line);
        return `<tr><td>${esc(lbl)}</td><td class="r">${arr.length}</td><td class="r">${fx(avgOf(arr))}</td><td class="r">${arr.length ? `${h.over}/${h.over + h.under}` : "—"}</td></tr>`;
      }).join("")}</tbody></table>`;

    // Context
    const restNext = next && games[0] ? Math.round((new Date(next.date) - new Date(games[0].date)) / 864e5) - 1 : null;
    $("#context").innerHTML = `
      <div class="small" style="display:grid;gap:8px">
        ${next ? `<div><b>Next:</b> ${next.home ? "vs" : "@"} ${esc(next.oppName || next.opp)} · ${fmtDate(next.date, { weekday: "short", month: "short", day: "numeric" })} ${fmtTime(next.date)}${restNext != null && restNext >= 0 && (fam === "basketball" || fam === "hockey") ? ` · ${restNext === 0 ? "<b>back-to-back</b>" : `${restNext} day${restNext === 1 ? "" : "s"} rest`}` : ""}</div>` : ""}
        <div><b>Opponent:</b> ${esc(opp.why)}</div>
        ${opp.extra || ""}
        ${gctx?.notes?.length ? `<div><b>Tonight:</b><ul style="margin:4px 0 0;padding-left:18px">${gctx.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : state.useCtx && next && nextSum && !gctx ? `<div class="faint">Checking tonight's lines and injury report…</div>` : ""}
        ${gctx?.outMates?.length ? `<div><b>Out for ${esc(a.team?.abbreviation || "the team")}:</b> ${gctx.outMates.map((x) => `${esc(x.name)} <span class="faint">(${esc(x.status)})</span>`).join(", ")}</div>` : ""}
        <div><b>Sample:</b> ${res.n} games (most recent ${MODEL_SAMPLE} max, newer games weigh more). SD ${fx(res.sd)}, range ${fx(res.min, 0)}–${fx(res.max, 0)}.</div>
      </div>`;

    // Deep panel
    $("#deep").innerHTML = deepPlayerPanel(L, deep, deepPlayer, next) || "";

    // Game log
    const cols = logColumns(fam).filter(([k]) => wg.some((g) => g.stats[k] != null && g.stats[k] !== 0));
    $("#log").innerHTML = `<table><thead><tr><th>Date</th><th>Opp</th><th>Result</th>${cols.map((c) => `<th class="r">${c[1]}</th>`).join("")}<th class="r">${esc(m.label)}</th><th></th></tr></thead><tbody>
      ${wg.map((g) => {
        const cls = g.value > line ? "o" : g.value < line ? "u" : "p";
        return `<tr><td>${fmtDate(g.date)}${g.seasonType === "post" ? ` <span class="pill">PO</span>` : ""}${g.oldTeam ? ` <span class="pill" title="Played for a previous team">old team</span>` : ""}</td><td>${g.home ? "vs" : "@"} ${esc(g.opp)}</td><td>${esc(g.result || "")} ${esc(g.score || "")}</td>
          ${cols.map((c) => { const x = g.stats[c[0]]; return `<td class="r">${x == null ? "—" : Number.isInteger(x) ? x : x.toFixed(1)}</td>`; }).join("")}
          <td class="r ${cls}">${fx(g.value, Number.isInteger(g.value) ? 0 : 1)}</td><td class="${cls}">${cls === "o" ? "O" : cls === "u" ? "U" : "P"}</td></tr>`;
      }).join("")}</tbody></table>`;

    $("#notes").innerHTML = `<ul>
      <li>Base: ${res.recent != null ? `recency-weighted avg ${fx(res.recent)} blended with ${fx(res.avg)} overall` : ""}${res.expMinutes ? `, converted to a per-minute rate × ${fx(res.expMinutes)} expected minutes` : ""}.</li>
      ${res.notes.map((n) => `<li>${esc(n)}</li>`).join("")}
      <li>Distribution: ${m.dist === "normal" ? "normal (yardage/points style stat)" : m.dist === "poisson" ? "Poisson (rare-event count)" : "negative binomial (count with extra game-to-game swing)"} fit to the player's own variance; blended ${res.n >= 8 ? "65/35" : "80/20"} with the recency-weighted hit rate (${pct(res.empirical)}).</li>
      <li>Break-even at ${M.fmtOdds(res.oddsOver)} is ${pct(M.impliedProb(res.oddsOver), 1)}; no-vig market says over ${pct(res.bookFair?.a, 1)}.</li>
      ${games.some((g) => g.oldTeam) ? `<li>Changed teams: games for a previous team count ${OLD_TEAM_W * 100}% as much.</li>` : ""}
      <li>Last season's games count ${PREV_SEASON_W * 100}% as much as this season's.</li>
      ${res.marketWeight ? `<li>Stats alone say over ${pct(res.statsOver, 1)}; blended ${Math.round(res.marketWeight * 100)}% with the market's ${pct(res.marketProb, 1)}${res.marketProb === 0.5 && !(state.oddsOver && state.oddsUnder) ? " (a posted main line without prices is treated as 50/50)" : " (no-vig)"}, because sportsbooks already price in news the box score can't see, like injuries and role changes.</li>` : `<li>No market price to anchor to (custom line without both odds), so this is the stats model alone. Treat it with extra caution.</li>`}
      <li>Grades: A ≥ 8 pts of edge, B ≥ 5, C ≥ 2.5, otherwise PASS. Fewer than 5 games caps the grade at C.</li>
    </ul>`;
    syncInputs();
  }

  // Events
  app.querySelector("#mk").addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    state.market = b.dataset.k;
    seedLine();
    render();
  });
  $("#win").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.win = b.dataset.w; render(); } });
  $("#loc").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.loc = b.dataset.l; render(); } });
  $("#vsopp")?.addEventListener("click", () => { state.vsOpp = !state.vsOpp; render(); });
  const bind = (sel, key, parse = (v) => v) => $(sel).addEventListener("input", (e) => { state[key] = parse(e.target.value); render(); });
  $("#f-line").addEventListener("input", () => { state.lineSource = "user"; });
  bind("#f-line", "line", (v) => (v === "" ? null : Number(v)));
  bind("#f-oo", "oddsOver", (v) => (v === "" ? null : Number(v)));
  bind("#f-uo", "oddsUnder", (v) => (v === "" ? null : Number(v)));
  bind("#f-min", "minutes");
  bind("#f-role", "role", (v) => Number(v) || 0);
  $("#f-opp").addEventListener("change", (e) => { state.useOpp = e.target.value === "1"; render(); });
  $("#f-ctx").addEventListener("change", (e) => { state.useCtx = e.target.value === "1"; render(); });

  render();
}

// Upcoming (or in-progress) game: athlete overview first, team schedule as fallback.
async function findNextGame(L, teamId, ov) {
  const myTeamId = String(teamId || "");
  const ng = ov?.nextGame?.league?.events?.[0];
  const state = ng && (ng.fullStatus?.type?.state || ng.status);
  if (ng && state !== "post" && myTeamId) {
    const me = ng.competitors?.find((c) => String(c.id) === myTeamId);
    const op = ng.competitors?.find((c) => String(c.id) !== myTeamId);
    return { id: ng.id, date: ng.date, state, home: me?.homeAway === "home", opp: op?.abbreviation, oppId: op?.id, oppName: op?.displayName };
  }
  if (!myTeamId) return null;
  try {
    const sched = await api.schedule(L, myTeamId);
    const e = (sched.events || []).find((x) => x.competitions?.[0]?.status?.type?.state !== "post" && new Date(x.date) > Date.now() - 4 * 3600e3);
    if (!e) return null;
    const c = e.competitions[0];
    const me = c.competitors.find((x) => String(x.team?.id ?? x.id) === myTeamId);
    const op = c.competitors.find((x) => x !== me);
    return { id: e.id, date: e.date, state: c.status?.type?.state, home: me?.homeAway === "home", opp: op?.team?.abbreviation, oppId: op?.team?.id, oppName: op?.team?.displayName };
  } catch {
    return null;
  }
}

function logColumns(fam) {
  return {
    basketball: [["min", "MIN"], ["pts", "PTS"], ["reb", "REB"], ["ast", "AST"], ["fg3m", "3PM"], ["fga", "FGA"]],
    football: [["pass_att", "ATT"], ["pass_yds", "PYD"], ["rush_att", "CAR"], ["rush_yds", "RYD"], ["tgt", "TGT"], ["rec", "REC"], ["rec_yds", "YDS"]],
    baseball: [["ab", "AB"], ["h", "H"], ["tb", "TB"], ["hr", "HR"], ["rbi", "RBI"], ["so", "K"]],
    baseballPitching: [["ip", "IP"], ["k", "K"], ["p_h", "H"], ["er", "ER"], ["p_bb", "BB"]],
    hockey: [["min", "TOI"], ["g", "G"], ["a", "A"], ["sog", "SOG"], ["hits", "HIT"], ["blk", "BLK"], ["saves", "SV"]],
    soccer: [["g", "G"], ["a", "A"], ["shots", "SH"], ["sot", "SOT"]],
  }[fam] || [];
}

function header(L, a, next, ov) {
  const logo = a.team?.logos?.[0]?.href;
  const inj = a.injuries?.[0];
  const news = ov?.rotowire;
  return `<div class="card">
    <div class="phead">
      <img src="${esc(a.headshot?.href || "")}" alt="" onerror="this.style.visibility='hidden'"/>
      <div style="min-width:0">
        <h1 style="margin:0">${esc(a.displayName)}</h1>
        <div class="meta">${logo ? `<img src="${esc(logo)}" alt="" style="width:18px;height:18px;vertical-align:-4px;border:0;border-radius:0;background:none"/> ` : ""}${esc(a.team?.displayName || "")} · ${esc(a.position?.abbreviation || a.position?.name || "")}${a.jersey ? ` · #${esc(a.jersey)}` : ""}${a.status?.type && a.status.type !== "active" ? ` · <span class="neg">${esc(a.status.name)}</span>` : ""}</div>
        ${next ? `<div class="meta" style="margin-top:4px">Next: <b>${next.home ? "vs" : "@"} ${esc(next.opp)}</b> · ${fmtDate(next.date, { weekday: "short", month: "short", day: "numeric" })} ${fmtTime(next.date)}${next.state === "in" ? ` <span class="pill live">LIVE</span>` : ""} · <a href="#/l/${L.id}/g/${next.id}">game page ›</a></div>` : ""}
      </div>
    </div>
    ${inj ? `<div class="notice warn" style="margin-top:10px">Injury: ${esc(inj.status || "")} ${esc(inj.details?.type || "")}</div>` : ""}
    ${news?.headline ? `<p class="small muted" style="margin:10px 0 0"><b>Latest:</b> ${esc(news.headline)}${news.story ? ` <details class="more" style="display:inline"><summary>more</summary><span class="faint">${esc(news.story)}</span></details>` : ""}</p>` : ""}
  </div>`;
}
