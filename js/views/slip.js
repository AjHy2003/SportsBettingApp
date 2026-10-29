// 🎟️ A shared bet slip: every leg with PickLab's read on it today, buttons that add the
// legs to your sportsbook's slip, and saving it as your own ticket (or editing it).
import { leagueById } from "../sports.js";
import * as M from "../model.js";
import { esc, setTitle, pct, fmtDate, fmtTime, toast, loading } from "../ui.js";
import { decodeSlip } from "../slip.js";
import { decimalOdds } from "../parlay.js";
import { placeBet, slipText } from "../sportsbooks.js";
import { addTicket, addPick } from "../store.js";
import { bankrollOk } from "../bankroll.js";

const money = (x) => `$${x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2).replace(/\.00$/, "")}`;

export async function renderSlip(ctx, q) {
  const { app } = ctx;
  setTitle("Shared bet slip");
  app.innerHTML = loading("Opening the slip…");
  let slip;
  try { slip = await decodeSlip(q.s || ""); } catch (e) {
    if (!ctx.alive()) return;
    app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › Shared slip</div><div class="notice warn">This slip link is broken or incomplete${e?.message && /bets/.test(e.message) ? ` (${esc(e.message)})` : ""}. Ask for the link again; links get cut off when they're copied partway.</div>`;
    return;
  }
  const today = await fetch("data/picks/today.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!ctx.alive()) return;
  const byId = new Map([...(today?.legs || []), ...(today?.alts || [])].map((l) => [l.id, l]));
  const legs = slip.legs;
  const now = Date.now();
  const dec = legs.reduce((d, l) => d * decimalOdds(l.odds ?? -110), 1);
  const american = slip.american ?? M.toAmerican(1 / dec);
  const reads = legs.map((l) => byId.get(l.ref));
  const modelProb = reads.every(Boolean) ? reads.reduce((p, r) => p * r.prob, 1) : null;
  const started = legs.filter((l) => l.eventDate && new Date(l.eventDate) < now).length;
  const sameGame = legs.length > 1 && new Set(legs.map((l) => l.eventId)).size === 1;
  const type = legs.length === 1 ? "single" : sameGame ? "sgp" : "parlay";
  const title = slip.title || (legs.length === 1 ? "Straight bet" : `${legs.length}-leg ${sameGame ? "same-game parlay" : "parlay"}`);
  let stake = Number(slip.stake) || 10;

  const take = (l, r) => {
    if (!r) return `<span class="faint">No PickLab read on this one${today ? " (it isn't in today's picks file)" : ""}.</span>`;
    const moved = r.odds != null && l.odds != null && r.odds !== l.odds ? ` · price now <b>${M.fmtOdds(r.odds)}</b> (was ${M.fmtOdds(l.odds)})` : "";
    if (!r.lean) return `<span class="neg">PickLab leans the other way</span> · ${pct(r.prob)} to hit${moved}`;
    return `<span class="${r.edge > 0 ? "pos" : "muted"}">PickLab: ${pct(r.prob)} to hit</span> vs ${pct(M.impliedProb(r.odds ?? l.odds), 1)} break-even${r.grade && r.grade !== "PASS" ? ` · grade <b>${esc(r.grade)}</b>` : ""}${moved}`;
  };

  app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › Shared slip</div>
    <h1>🎟️ ${esc(title)}</h1>
    <p class="small muted" style="margin-top:0">Someone shared this slip with you. Tap <b>＋</b> next to a leg to add it to that sportsbook's bet slip, or save the whole thing as your own ticket.</p>
    ${started ? `<div class="notice warn" style="margin-bottom:12px">${started === legs.length ? "These games have" : `${started} of these games have`} already started. Books only take live bets on games in progress, at different odds.</div>` : ""}
    <div class="card">
      <div class="kpis" style="margin-top:0">
        <div class="kpi"><div class="k">Odds</div><div class="v">${M.fmtOdds(american)}</div></div>
        <div class="kpi"><div class="k">Bet</div><div class="v"><input id="s-stake" type="number" min="1" step="1" inputmode="decimal" value="${stake}" class="kpi-input" aria-label="Bet amount"/></div></div>
        <div class="kpi"><div class="k">Pays</div><div class="v pos" id="s-pays">${money(stake * dec)}</div></div>
        ${modelProb != null ? `<div class="kpi"><div class="k">PickLab's chance</div><div class="v">${pct(modelProb, 1)}</div></div>` : ""}
      </div>
      <div style="margin-top:10px">${legs.map((l, i) => {
        const r = reads[i], L = leagueById(l.league);
        return `<div class="tp-row" style="align-items:flex-start"><span class="gbadge ${esc(r?.lean ? r.grade : "")}">${r?.lean && r.grade !== "PASS" ? esc(r.grade) : i + 1}</span>
          <div style="min-width:0"><b>${esc(l.label)}</b> <span class="muted">${l.odds != null ? M.fmtOdds(l.odds) : ""}</span>
            <div class="small muted">${esc(L?.name || l.league || "")}${l.matchup ? ` · ${esc(l.matchup)}` : ""}${l.eventDate ? ` · ${fmtDate(l.eventDate, { weekday: "short" })} ${fmtTime(l.eventDate)}` : ""}</div>
            <div class="small">${take(l, r)}</div></div></div>`;
      }).join("")}</div>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="s-save">★ Save as my bet</button>
        ${reads.some(Boolean) ? `<button class="btn ghost" id="s-edit">✏️ Edit in parlay builder</button>` : ""}
        <button class="btn ghost" id="s-copy">📋 Copy for Reddit</button>
      </div>
      <div id="s-place">${placeBet(legs, { stake, american, title, openLegs: true, label: "Add to your sportsbook" })}</div>
    </div>
    <p class="small faint" style="margin-top:12px">PickLab never places bets: the ＋ buttons open the sportsbook with that bet in the slip, and you confirm it there. DraftKings game lines go straight into the slip; other books open to the game unless the site has The Odds API turned on. Bet only what you can afford to lose.</p>`;

  const $ = (s) => app.querySelector(s);
  $("#s-stake").addEventListener("input", (e) => {
    stake = Math.max(1, Number(e.target.value) || 0);
    $("#s-pays").textContent = money(stake * dec);
  });
  $("#s-save").addEventListener("click", () => {
    if (!bankrollOk(stake)) return;
    const prob = modelProb ?? legs.reduce((p, l) => p * (l.prob || 1 / decimalOdds(l.odds ?? -110)), 1);
    const id = addTicket({ type, stake, american, toWin: stake * (dec - 1), prob, kind: slip.kind, shared: true, legs });
    for (const l of legs) addPick({ ...l, ticketId: id });
    toast("Saved to ★ My bets · it tracks live during the games");
  });
  $("#s-edit")?.addEventListener("click", () => {
    try { sessionStorage.setItem("picklab.mine", JSON.stringify(reads.filter(Boolean).map((r) => r.id))); } catch { /* ignore */ }
    location.hash = "#/today?day=all";
  });
  $("#s-copy").addEventListener("click", () => {
    const text = `${slipText(legs, { stake, american, title })}\n\nOpen it in PickLab (tap ＋ to add each leg to your book's slip): ${location.href}`;
    navigator.clipboard?.writeText(text).then(() => toast("Copied: paste it into a Reddit post or a text"), () => toast("Copy failed"));
  });
}
