// Tennis + UFC: event cards with records and a two-way price checker.
import { api } from "../espn.js";
import * as M from "../model.js";
import { esc, loading, errorBox, setTitle, pct, fmtDate, fmtTime } from "../ui.js";

export async function renderEvents(ctx, L, q) {
  const { app } = ctx;
  setTitle(L.name);
  app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › ${esc(L.name)}</div><h1>${L.icon} ${esc(L.name)}</h1>${loading("Loading events…")}`;
  let sb;
  try {
    sb = await api.scoreboard(L);
  } catch (e) {
    if (ctx.alive()) app.innerHTML += errorBox(e);
    return;
  }
  if (!ctx.alive()) return;
  const matches = [];
  for (const ev of sb.events || []) {
    const comps = ev.groupings ? ev.groupings.flatMap((g) => g.competitions.map((c) => ({ ...c, group: g.grouping?.displayName }))) : ev.competitions || [];
    for (const c of comps) matches.push({ ev, c });
  }
  const upcoming = matches.filter((m) => m.c.status?.type?.state !== "post");
  const done = matches.filter((m) => m.c.status?.type?.state === "post").slice(-30).reverse();
  const card = ({ ev, c }, i) => {
    const [x, y] = c.competitors || [];
    if (!x || !y) return "";
    const nm = (p) => p.athlete?.displayName || p.team?.displayName || "TBD";
    const rec = (p) => p.records?.[0]?.summary || "";
    const st = c.status?.type || {};
    const sets = (p) => (p.linescores || []).map((l) => l.value).join(" ");
    const focus = q.athlete && (String(x.id) === q.athlete || String(y.id) === q.athlete);
    return `<div class="card tight ${focus ? "hl" : ""}" style="${focus ? "border-color:var(--accent)" : ""}">
      <div class="gc-top"><span>${esc(c.group || ev.name || "")}${c.type?.abbreviation ? ` · ${esc(c.type.abbreviation)}` : ""}${c.round?.displayName ? ` · ${esc(c.round.displayName)}` : ""}</span><span>${st.state === "pre" ? `${fmtDate(c.date || ev.date, { weekday: "short", month: "short", day: "numeric" })} ${fmtTime(c.date || ev.date)}` : esc(st.shortDetail || "")}</span></div>
      ${[x, y].map((p) => `<div class="row" style="justify-content:space-between;padding:3px 0"><span class="${p.winner ? "pos" : ""}" style="font-weight:600">${p.athlete?.flag?.href ? `<img src="${esc(p.athlete.flag.href)}" alt="" style="width:16px;vertical-align:-2px"/> ` : ""}${esc(nm(p))} <span class="faint">${esc(rec(p))}</span></span><span class="faint">${esc(sets(p))}</span></div>`).join("")}
      ${st.state !== "post" ? `<details style="margin-top:6px"><summary class="small muted" style="cursor:pointer">Price check</summary>
        <div class="form-row" style="margin-top:8px" data-m="${i}">
          <div class="field"><label>${esc(nm(x).split(" ").pop())} odds</label><input type="number" data-a placeholder="-150"/></div>
          <div class="field"><label>${esc(nm(y).split(" ").pop())} odds</label><input type="number" data-b placeholder="+130"/></div>
          <div class="field"><label>Your ${esc(nm(x).split(" ").pop())} win %</label><input type="number" data-p placeholder="optional"/></div>
        </div><div class="small" data-out style="margin-top:6px"></div></details>` : ""}
    </div>`;
  };
  app.innerHTML = `
    <div class="crumbs"><a href="#/">Home</a> › ${esc(L.name)}</div>
    <h1>${L.icon} ${esc(L.name)}</h1>
    <div class="notice" style="margin-bottom:14px">ESPN doesn't publish per-match stats for ${esc(L.name)}, so these cards show the market's fair (no-vig) price and grade your own estimate. For stat props (aces, games, significant strikes, rounds), use the <a href="#/custom">custom calculator</a> with recent results.</div>
    <h2>${upcoming.length ? "Upcoming & live" : "No upcoming matches posted"}</h2>
    <div class="grid three">${upcoming.map((m, i) => card(m, i)).join("")}</div>
    ${done.length ? `<h2 style="margin-top:18px">Recent results</h2><div class="grid three">${done.map((m) => card(m, -1)).join("")}</div>` : ""}`;

  app.querySelectorAll("[data-m]").forEach((row) => {
    const out = row.parentElement.querySelector("[data-out]");
    const calc = () => {
      const a = Number(row.querySelector("[data-a]").value), b = Number(row.querySelector("[data-b]").value);
      const mine = Number(row.querySelector("[data-p]").value) / 100;
      if (!a || !b) { out.textContent = ""; return; }
      const nv = M.noVig(a, b);
      let html = `Market (no-vig): <b>${pct(nv.a, 1)}</b> / <b>${pct(nv.b, 1)}</b> · fair ${M.fmtOdds(M.toAmerican(nv.a))} / ${M.fmtOdds(M.toAmerican(nv.b))} · book hold ${pct(nv.hold, 1)}`;
      if (mine > 0 && mine < 1) {
        const evA = M.expectedValue(mine, 0, a), evB = M.expectedValue(1 - mine, 0, b);
        const best = evA >= evB ? ["first", evA, mine - M.impliedProb(a)] : ["second", evB, 1 - mine - M.impliedProb(b)];
        html += `<br/>Your number makes the <b>${best[0]}</b> side ${best[1] > 0 ? `<span class="pos">+EV (${(best[1] * 100).toFixed(1)}%, edge ${(best[2] * 100).toFixed(1)} pts)</span>` : `<span class="neg">−EV</span> — pass`}.`;
      }
      out.innerHTML = html;
    };
    row.addEventListener("input", calc);
  });
}
