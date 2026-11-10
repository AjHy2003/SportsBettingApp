// 📋 Pick history: every pick the app posted (or every leg it showed), filterable by grade,
// period, sport, bet type and result, with the record for whatever is selected.
import { leagueById } from "../sports.js";
import * as M from "../model.js";
import { $, esc, loading, setTitle, pct, signed, fmtDate } from "../ui.js";
import { betType, summarize, wasBest, clvBeat } from "../record.js";

const getData = (p) => fetch(p, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const leagueName = (id) => leagueById(id)?.name || id;
const PAGE = 150;

const TYPES = [["", "All types"], ["current", "Kinds still posted"], ["prop", "Props"], ["lines", "Spreads & totals"], ["ml", "Moneylines"], ["longshot", "Long-shot ML"], ["nflprops", "NFL props"]];
const RESULTS = [["", "All"], ["W", "Won"], ["L", "Lost"], ["open", "Not graded yet"], ["other", "Push / void"]];
const PERIODS = [["", "All time"], ["30", "30 days"], ["7", "7 days"], ["1", "Last day"]];

export async function renderRecord(ctx, q) {
  const { app } = ctx;
  setTitle("Pick history");
  app.innerHTML = loading("Loading pick history…");
  const f = {
    src: ["all", "moon"].includes(q.src) ? q.src : "posted", kind: q.kind || "", grade: q.grade || "", days: q.days || "", sport: q.sport || "", type: q.type || "", res: q.res || "",
    best: q.best === "1", pmin: q.pmin != null ? Number(q.pmin) : null, pmax: q.pmax != null ? Number(q.pmax) : null,
  };
  const data = { posted: await getData("data/picks/history.json"), all: null, moon: null };
  if (!ctx.alive()) return;
  if (f.src === "all") data.all = await getData("data/picks/tracked.json");
  if (f.src === "moon") data.moon = await getData("data/picks/moonshots.json");
  if (!ctx.alive()) return;
  let shown = PAGE;

  app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › <a href="#/today">Today</a> › Pick history</div>
    <div class="card"><h1 style="margin:0">📋 Pick history</h1>
      <p class="small muted" style="margin:6px 0 0">Every pick the app posted, graded after the game. Tap the filters to see any grade, sport, bet type or stretch of days, and tap a pick to open the player or game.</p>
      <div id="r-filters" style="margin-top:12px"></div></div>
    <div class="card" style="margin-top:14px" id="r-sum"></div>
    <div class="card" style="margin-top:14px" id="r-list"></div>`;

  const rowsOf = () => (f.src === "all" ? (data.all?.picks || []) : (data.posted?.picks || []));
  const now = Date.now();
  const matches = (p, skip = "") => {
    if (skip !== "grade" && f.grade && p.grade !== f.grade) return false;
    if (skip !== "days" && f.days && new Date(p.start) < now - Number(f.days) * 864e5) return false;
    if (skip !== "sport" && f.sport && p.league !== f.sport) return false;
    if (skip !== "type" && f.type) {
      const t = betType(p);
      if (f.type === "current" ? !!t.gone : t.key !== f.type) return false;
    }
    if (skip !== "res" && f.res) {
      if (f.res === "open" ? !!p.result : f.res === "other" ? !["P", "VOID"].includes(p.result) : p.result !== f.res) return false;
    }
    if (f.best && !wasBest(p)) return false;
    if (f.pmin != null && !(p.prob >= f.pmin && p.prob < (f.pmax ?? 1.01))) return false;
    return true;
  };

  function syncUrl() {
    const qs = new URLSearchParams();
    if (f.src !== "posted") qs.set("src", f.src);
    for (const k of f.src === "moon" ? ["kind", "days", "res"] : ["grade", "days", "sport", "type", "res"]) if (f[k]) qs.set(k, f[k]);
    if (f.best) qs.set("best", "1");
    if (f.pmin != null) { qs.set("pmin", f.pmin); if (f.pmax != null) qs.set("pmax", f.pmax); }
    const h = `#/record${qs.toString() ? `?${qs}` : ""}`;
    if (location.hash !== h) history.replaceState(null, "", h);
  }

  const srcChips = () => `<div class="chips"><button class="chip ${f.src === "posted" ? "on" : ""}" data-src="posted">Posted picks</button><button class="chip ${f.src === "all" ? "on" : ""}" data-src="all">Every leg the app showed</button><button class="chip ${f.src === "moon" ? "on" : ""}" data-src="moon">🚀 Daily moonshots</button></div>`;

  function renderFilters() {
    if (f.src === "moon") return moonFilters();
    const all = rowsOf();
    // Counts on each chip: how many picks that choice would show with the other filters kept.
    const count = (key, val) => all.filter((p) => { const keep = f[key]; f[key] = val; const ok = matches(p); f[key] = keep; return ok; }).length;
    const row = (label, key, opts) => `<div class="row" style="gap:8px;align-items:center;margin-top:8px"><span class="small faint" style="min-width:58px">${label}</span>
      <div class="chips scroll" style="flex:1;min-width:0">${opts.map(([v, t]) => `<button class="chip ${String(f[key]) === v ? "on" : ""}" data-k="${key}" data-v="${esc(v)}">${esc(t)} <span class="cnt">${count(key, v)}</span></button>`).join("")}</div></div>`;
    const grades = [["", "All"], ["A", "A"], ["B", "B"], ["C", "C"], ...(f.src === "all" ? [["ALT", "Moonshot long shots"]] : [])];
    const sports = [["", "All"], ...[...new Set(all.map((p) => p.league))].sort((a, b) => all.filter((p) => p.league === b).length - all.filter((p) => p.league === a).length).map((id) => [id, leagueName(id)])];
    const extra = [];
    if (f.best) extra.push(`⭐ Best bets only <button class="btn ghost sm" data-clear="best">✕</button>`);
    if (f.pmin != null) extra.push(`Model said ${Math.round(f.pmin * 100)}–${Math.round(Math.min(f.pmax ?? 1, 1) * 100)}% <button class="btn ghost sm" data-clear="prob">✕</button>`);
    $("#r-filters").innerHTML = `
      ${srcChips()}
      ${f.src === "all" ? `<p class="small faint" style="margin:6px 0 0">Every A, B and C leg shown in tickets, same-game parlays and pick lists (and the moonshots' long shots) since Nov 2, not just the posted picks.</p>` : ""}
      ${row("Grade", "grade", grades)}${row("Period", "days", PERIODS)}${row("Sport", "sport", sports)}${row("Type", "type", TYPES)}${row("Result", "res", RESULTS)}
      ${f.src === "posted" ? `<div class="row" style="gap:8px;margin-top:8px"><span class="small faint" style="min-width:58px"></span><button class="chip ${f.best ? "on" : ""}" data-best="1">⭐ Best bets only</button></div>` : ""}
      ${extra.length ? `<div class="small muted" style="margin-top:8px">${extra.join(" · ")}</div>` : ""}`;
  }

  function renderSummary(rows) {
    if (f.src === "all" && !data.all) { $("#r-sum").innerHTML = `<div class="muted">The every-leg history isn't published yet; it appears after the next scan.</div>`; return; }
    const s = summarize(rows);
    const kpi = (k, v, title = "") => `<div class="kpi"${title ? ` title="${esc(title)}"` : ""}><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $("#r-sum").innerHTML = `<h3 style="margin:0">${esc(describe())}</h3>
      <div class="kpis">
        ${kpi("Record", `${s.w}-${s.l}${s.p ? `-${s.p}` : ""}`, "Won-lost(-pushed)")}
        ${kpi("Units", `<span class="${s.units >= 0 ? "pos" : "neg"}">${signed(s.units, 1)}u</span>`, "Profit betting 1 unit on each")}
        ${kpi("Hit", `${pct(s.hit)} <small>needed ${pct(s.need)}</small>`, "Hit rate vs the rate the prices needed to break even")}
        ${kpi("Model said", pct(s.modelAvg), "The model's average chance for these picks")}
        ${s.clvN ? kpi("Beat later line", `<span class="${s.clvBeat / s.clvN >= 0.5 ? "pos" : "neg"}">${pct(s.clvBeat / s.clvN)}</span> <small>${s.clvBeat}/${s.clvN}</small>`, "The line moved toward the pick after it was posted") : ""}
      </div>${s.pending || s.v ? `<p class="small faint" style="margin:8px 0 0">${s.pending ? `${s.pending} not graded yet` : ""}${s.pending && s.v ? " · " : ""}${s.v ? `${s.v} voided (player didn't play or a data fix)` : ""}.</p>` : ""}`;
  }

  function describe() {
    const parts = [];
    if (f.best) parts.push("⭐ Best bets");
    if (f.grade) parts.push(f.grade === "ALT" ? "Moonshot long shots" : `Grade ${f.grade}`);
    if (f.sport) parts.push(leagueName(f.sport));
    if (f.type) parts.push(TYPES.find(([v]) => v === f.type)?.[1] || "");
    if (f.res) parts.push(RESULTS.find(([v]) => v === f.res)?.[1].toLowerCase() || "");
    if (f.days) parts.push(PERIODS.find(([v]) => v === f.days)?.[1].toLowerCase() || "");
    return `${parts.length ? parts.join(" · ") : f.src === "all" ? "Every leg shown" : "All posted picks"}`;
  }

  const link = (p) => (p.kind === "prop" && p.playerId ? `#/l/${p.league}/p/${p.playerId}` : p.eventId ? `#/l/${p.league}/g/${p.eventId}` : null);
  const resCell = (p) => {
    const r = p.result;
    const cls = r === "W" ? "pos" : r === "L" ? "neg" : "faint";
    const txt = r === "W" ? "Won" : r === "L" ? "Lost" : r === "P" ? "Push" : r === "VOID" ? "Void" : new Date(p.start) > Date.now() ? "Upcoming" : "Pending";
    return `<div style="text-align:right;flex:0 0 auto"><b class="${cls}">${txt}</b>${p.actual != null && p.actual !== "" ? `<div class="small faint">${p.kind === "prop" ? "had " : ""}${esc(p.actual)}</div>` : ""}</div>`;
  };
  const clvTxt = (p) => { const c = clvBeat(p); return c == null ? "" : ` · <span class="${c ? "pos" : "neg"}" title="Line movement after the pick">line ${c ? "moved our way" : "moved against"}</span>`; };

  function renderList(rows) {
    const box = $("#r-list");
    if (!rows.length) { box.innerHTML = `<div class="muted">No picks match these filters.</div>`; return; }
    const list = rows.slice(0, shown);
    const days = new Map();
    for (const p of list) {
      const d = fmtDate(p.start, { weekday: "short", month: "short", day: "numeric" });
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(p);
    }
    box.innerHTML = [...days.entries()].map(([d, ps]) => {
      const s = summarize(ps);
      return `<div class="row" style="justify-content:space-between;margin:${d === [...days.keys()][0] ? 0 : 14}px 0 2px"><h3 style="margin:0">${esc(d)}</h3>${s.n ? `<span class="small"><b>${s.w}-${s.l}</b> <span class="${s.units >= 0 ? "pos" : "neg"}">${signed(s.units, 1)}u</span></span>` : ""}</div>
        ${ps.map((p) => {
          const href = link(p), t = betType(p);
          return `<div class="tp-row" style="align-items:flex-start"><span class="gbadge ${esc(p.grade)}">${p.grade === "ALT" ? "🚀" : esc(p.grade || "—")}</span>
            <div style="flex:1;min-width:0">${href ? `<a href="${href}"><b>${esc(p.label)}</b></a>` : `<b>${esc(p.label)}</b>`}${wasBest(p) && f.src === "posted" ? " ⭐" : ""}
              <div class="small muted">${esc(leagueName(p.league))}${p.matchup ? ` · ${esc(p.matchup)}` : ""} · ${M.fmtOdds(p.odds)} · model ${pct(p.prob)}${t.gone ? ` · <span class="faint">${esc(t.name.toLowerCase())}, ${t.gone}</span>` : ""}${clvTxt(p)}</div></div>
            ${resCell(p)}</div>`;
        }).join("")}`;
    }).join("") + (rows.length > shown ? `<div style="text-align:center;margin-top:12px"><button class="btn ghost" id="r-more">Show more (${rows.length - shown} left)</button></div>` : "");
    $("#r-more")?.addEventListener("click", () => { shown += PAGE; render(); });
  }

  // ---------- 🚀 daily moonshots ----------
  const KINDS = [["", "All"], ["all", "All sports"], ["basketball", "🏀 Basketball"], ["football", "🏈 Football"], ["hockey", "🏒 Hockey"]];
  const MRES = [["", "All"], ["W", "Hit"], ["L", "Missed"], ["open", "Not settled"]];
  const kindName = (k) => KINDS.find(([v]) => v === k)?.[1] || k;
  const moonMatch = (t, skip = "") => {
    if (skip !== "kind" && f.kind && t.kind !== f.kind) return false;
    if (skip !== "days" && f.days && new Date(`${t.day}T23:59:00`) < now - Number(f.days) * 864e5) return false;
    if (skip !== "res" && f.res) { if (f.res === "open" ? ["W", "L", "VOID"].includes(t.result) : t.result !== f.res) return false; }
    return true;
  };
  function moonFilters() {
    const all = data.moon?.tickets || [];
    const count = (key, val) => all.filter((t) => { const keep = f[key]; f[key] = val; const ok = moonMatch(t); f[key] = keep; return ok; }).length;
    const row = (label, key, opts) => `<div class="row" style="gap:8px;align-items:center;margin-top:8px"><span class="small faint" style="min-width:58px">${label}</span>
      <div class="chips scroll" style="flex:1;min-width:0">${opts.map(([v, t]) => `<button class="chip ${String(f[key]) === v ? "on" : ""}" data-k="${key}" data-v="${esc(v)}">${esc(t)} <span class="cnt">${count(key, v)}</span></button>`).join("")}</div></div>`;
    $("#r-filters").innerHTML = `${srcChips()}
      <p class="small faint" style="margin:6px 0 0">The daily $10 → $10,000 moonshots (the all-sports one is the one in the notification), as they stood when their first game started, graded leg by leg. Logging started Nov 10.</p>
      ${row("Sport", "kind", KINDS)}${row("Period", "days", PERIODS)}${row("Result", "res", MRES)}`;
  }
  const legIcon = (l) => (l.result === "W" ? "✅" : l.result === "L" ? "❌" : l.result === "P" || l.result === "VOID" ? "➖" : new Date(l.start) > Date.now() ? "🕒" : "⏳");
  function moonSummary(ts) {
    if (!data.moon) { $("#r-sum").innerHTML = `<div class="muted">The moonshot log isn't published yet; it appears after the next scan.</div>`; return; }
    const done = ts.filter((t) => t.result === "W" || t.result === "L");
    const staked = done.reduce((a, t) => a + t.stake, 0), back = done.reduce((a, t) => a + (t.paid || 0), 0);
    const legs = ts.flatMap((t) => t.legs).filter((l) => l.result === "W" || l.result === "L");
    const lw = legs.filter((l) => l.result === "W").length;
    const misses = done.filter((t) => t.result === "L").map((t) => t.legs.filter((l) => l.result === "L").length);
    const net = back - staked;
    const kpi = (k, v, title = "") => `<div class="kpi"${title ? ` title="${esc(title)}"` : ""}><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $("#r-sum").innerHTML = `<h3 style="margin:0">${esc(f.kind ? kindName(f.kind) : "All")} moonshots</h3>
      <div class="kpis">
        ${kpi("Tickets", `${done.filter((t) => t.result === "W").length}-${done.filter((t) => t.result === "L").length}`, "Hit-missed")}
        ${kpi("Net", `<span class="${net >= 0 ? "pos" : "neg"}">${net >= 0 ? "+" : "−"}$${Math.abs(net).toLocaleString("en-US", { maximumFractionDigits: 0 })}</span> <small>on $${staked}</small>`, "Paid back minus $10 a ticket")}
        ${kpi("Legs hit", `${legs.length ? pct(lw / legs.length) : "—"} <small>${lw}/${legs.length}</small>`)}
        ${misses.length ? kpi("Closest", `${Math.min(...misses)} leg${Math.min(...misses) === 1 ? "" : "s"} <small>short</small>`, "Fewest losing legs on a missed ticket") : ""}
      </div>${ts.some((t) => !t.result) ? `<p class="small faint" style="margin:8px 0 0">${ts.filter((t) => !t.result).length} not settled yet.</p>` : ""}`;
  }
  function moonList(ts) {
    const box = $("#r-list");
    if (!data.moon) { box.innerHTML = ""; return; }
    if (!ts.length) { box.innerHTML = `<div class="muted">No moonshots match these filters${(data.moon.tickets || []).length ? "" : " yet: the first one is logged on the next scan"}.</div>`; return; }
    box.innerHTML = ts.slice(0, shown).map((t, i) => {
      const w = t.legs.filter((l) => l.result === "W").length, lost = t.legs.filter((l) => l.result === "L").length, graded = t.legs.filter((l) => l.result).length;
      const status = t.result === "W" ? `<b class="pos">Hit · paid $${Math.round(t.paid).toLocaleString("en-US")}</b>`
        : t.result === "L" ? `<b class="neg">Missed</b> <span class="small faint">· ${w} of ${t.legs.length} legs hit${lost === 1 ? " · 1 leg short" : ""}</span>`
        : t.result === "VOID" ? `<b class="faint">Void</b>`
        : graded ? `<b>In progress</b> <span class="small faint">· ${w} of ${t.legs.length} legs hit so far</span>`
        : `<b class="faint">${new Date(t.legs[0]?.start) > Date.now() ? "Not started" : "Waiting on results"}</b>`;
      const legRows = t.legs.map((l) => {
        const href = l.kind === "prop" && l.playerId ? `#/l/${l.league}/p/${l.playerId}` : `#/l/${l.league}/g/${l.eventId}`;
        return `<div class="row" style="gap:8px;align-items:flex-start;margin-top:6px"><span style="flex:0 0 auto">${legIcon(l)}</span><div style="flex:1;min-width:0"><a href="${href}">${esc(l.label)}</a> <span class="small muted">${M.fmtOdds(l.odds)} · ${esc(leagueName(l.league))}${l.matchup ? ` · ${esc(l.matchup)}` : ""}</span></div>${l.actual != null && l.actual !== "" ? `<span class="small faint" style="flex:0 0 auto">${l.kind === "prop" ? "had " : ""}${esc(l.actual)}</span>` : ""}</div>`;
      }).join("");
      return `<div style="${i ? "border-top:1px solid var(--line);padding-top:12px;margin-top:12px" : ""}">
        <h3 style="margin:0">${esc(fmtDate(`${t.day}T12:00:00`, { weekday: "short", month: "short", day: "numeric" }))} · ${esc(kindName(t.kind))}</h3>
        <div class="small muted">$${t.stake} → $${Math.round(t.payout).toLocaleString("en-US")} · ${M.fmtOdds(t.american)} · ${t.legs.length} legs · est. 1 in ${Math.round(1 / Math.max(t.prob, 1e-6)).toLocaleString("en-US")}${t.later ? " · includes later games" : ""}</div>
        <div style="margin:4px 0 2px">${status}</div>
        ${legRows}
      </div>`;
    }).join("") + (ts.length > shown ? `<div style="text-align:center;margin-top:12px"><button class="btn ghost" id="r-more">Show more (${ts.length - shown} left)</button></div>` : "");
    $("#r-more")?.addEventListener("click", () => { shown += PAGE; render(); });
  }

  function render() {
    if (f.src === "moon") {
      moonFilters();
      const ts = (data.moon?.tickets || []).filter((t) => moonMatch(t)).sort((a, b) => b.day.localeCompare(a.day) || KINDS.findIndex(([v]) => v === a.kind) - KINDS.findIndex(([v]) => v === b.kind));
      moonSummary(ts);
      moonList(ts);
      return;
    }
    renderFilters();
    const rows = rowsOf().filter((p) => matches(p)).sort((a, b) => new Date(b.start) - new Date(a.start) || (a.label || "").localeCompare(b.label || ""));
    renderSummary(rows);
    renderList(rows);
  }

  $("#r-filters").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.src) {
      f.src = b.dataset.src;
      if (f.src === "all" && !data.all) { $("#r-list").innerHTML = loading("Loading every leg…"); data.all = await getData("data/picks/tracked.json"); if (!ctx.alive()) return; }
      if (f.src === "moon" && !data.moon) { $("#r-list").innerHTML = loading("Loading moonshots…"); data.moon = await getData("data/picks/moonshots.json"); if (!ctx.alive()) return; }
      // Each view keeps only the filters it has.
      if (f.src === "moon") { Object.assign(f, { grade: "", sport: "", type: "", best: false, pmin: null, pmax: null }); if (!["", "W", "L", "open"].includes(f.res)) f.res = ""; }
      else f.kind = "";
      if (f.src === "posted" && f.grade === "ALT") f.grade = "";
      if (f.src === "all") f.best = false;
    } else if (b.dataset.k) f[b.dataset.k] = b.dataset.v;
    else if (b.dataset.best) f.best = !f.best;
    else if (b.dataset.clear === "best") f.best = false;
    else if (b.dataset.clear === "prob") { f.pmin = null; f.pmax = null; }
    else return;
    shown = PAGE;
    syncUrl();
    render();
  });

  render();
}
