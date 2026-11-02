// 🔎 Check my slip: type or paste bets the way your sportsbook shows them (one per line,
// with the price). Each one is priced at that exact line and price with the same model
// as the picks, then the ticket as a whole, with a better version when there is one.
import * as M from "../model.js";
import { esc, setTitle, pct, signed, toast, loading } from "../ui.js";
import { slipIndex, checkLine, verdictOf } from "../slipcheck.js";
import { decimalOdds, bestParlay } from "../parlay.js";
import { addTicket, addPick } from "../store.js";
import { slipUrl } from "../slip.js";
import { bankrollOk } from "../bankroll.js";

const KEY = "picklab.check.v1";
const money = (x) => `$${x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2).replace(/\.00$/, "")}`;
const oneIn = (p) => (p >= 0.5 ? `about ${Math.round(p * 10)} in 10` : `about 1 in ${Math.max(2, Math.round(1 / Math.max(p, 1e-4)))}`);

export async function renderCheck(ctx, q) {
  const { app } = ctx;
  setTitle("Check my slip");
  app.innerHTML = loading("Loading today's lines…");
  const today = await fetch("data/picks/today.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!ctx.alive()) return;
  const idx = slipIndex(today);
  let saved = "";
  try { saved = sessionStorage.getItem(KEY) || ""; } catch { /* ignore */ }
  app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › Check my slip</div>
    <h1>🔎 Check my slip</h1>
    <p class="small muted" style="margin-top:0">Type or paste your bets the way FanDuel (or any book) shows them, one per line, with the price. Each one is graded at that exact line and price, with the same model as the picks${today ? ` (${new Date(today.generated).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} scan)` : ""}.</p>
    <div class="card">
      <textarea id="c-text" rows="6" style="width:100%;resize:vertical" placeholder="Tre Jones under 4.5 assists -130&#10;LeBron over 31.5 PRA -118&#10;Rockets ML +150&#10;Over 221.5 Celtics Rockets -110&#10;Jokic 12+ rebounds +200">${esc(q.t || saved)}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" id="c-go">Check</button>
        <div class="field" style="width:110px"><input id="c-stake" type="number" min="1" step="1" inputmode="decimal" value="5" aria-label="Bet amount"/></div><span class="small faint">bet ($) · no price on a line? it assumes −110</span></div>
    </div>
    <div id="c-out"></div>`;
  const $ = (s) => app.querySelector(s);

  function run() {
    const text = $("#c-text").value;
    try { sessionStorage.setItem(KEY, text); } catch { /* ignore */ }
    const stake = Math.max(1, Number($("#c-stake").value) || 5);
    const rows = text.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 15).map((s) => checkLine(s, idx)).filter(Boolean);
    if (!rows.length) { $("#c-out").innerHTML = ""; return; }
    if (!today) { $("#c-out").innerHTML = `<div class="notice warn" style="margin-top:14px">Today's picks file isn't available yet, so there's nothing to check against.</div>`; return; }
    const ok = rows.filter((r) => r.status !== "unknown");
    const legRow = (r) => {
      const v = verdictOf(r);
      const notes = [];
      if (r.status !== "unknown") {
        if (r.assumedOdds) notes.push("no price given: assumed −110");
        if (r.approx) notes.push("rough read: far from the posted line");
        if (r.kind === "prop" && r.dk?.line != null && (r.dk.line !== r.pick.line || (r.side === "OVER" ? r.dk.over : r.dk.under) !== r.odds)) notes.push(`DraftKings has ${r.dk.line} (${M.fmtOdds(r.dk.over)} / ${M.fmtOdds(r.dk.under)})`);
        const a = r.appPick;
        if (a && a.label !== r.label) notes.push(`the app's pick here: <b>${esc(a.label)}</b> ${M.fmtOdds(a.odds)} · grade ${esc(a.grade)}`);
        if (ok.filter((x) => x.pick?.eventId === r.pick?.eventId).length > 1) notes.push("same game as another leg: books pay less on same-game parlays");
      }
      return `<div class="tp-row" style="align-items:flex-start"><span class="gbadge ${r.status === "unknown" ? "" : esc(r.grade)}">${r.status === "unknown" ? "?" : r.grade === "PASS" ? "—" : esc(r.grade)}</span>
        <div style="min-width:0"><b>${esc(r.label || r.raw)}</b> ${r.odds != null && r.status !== "unknown" ? `<span class="muted">${M.fmtOdds(r.odds)}</span>` : ""}
          <div class="small">${v.icon} ${v.text}</div>${notes.length ? `<div class="small faint">${notes.join(" · ")}</div>` : ""}</div></div>`;
    };
    // The ticket as entered, and a better version from the legs worth keeping.
    const ticket = (legs) => {
      const dec = legs.reduce((d, r) => d * decimalOdds(r.odds), 1);
      const prob = legs.reduce((p, r) => p * r.prob, 1);
      return { legs, dec, prob, american: M.toAmerican(1 / dec), ev: prob * dec - 1 };
    };
    const all = ok.length ? ticket(ok) : null;
    const keep = ok.filter((r) => ["A", "B"].includes(r.grade) && verdictOf(r).tag === "keep");
    const thin = ok.filter((r) => r.grade === "C" && verdictOf(r).tag === "thin");
    const pool = [...keep, ...thin];
    const two = pool.length >= 2 ? bestParlay(pool.map((r) => ({ ...r, id: r.raw, gameKey: r.pick.eventId, playerId: r.leg?.playerId })), 2, { by: "prob" }) : null;
    const better = keep.length && keep.length < ok.length ? ticket(keep) : null;
    const card = (title, t, note) => `<div style="border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:10px">
      <div class="row" style="justify-content:space-between"><b>${title}</b><span>${M.fmtOdds(t.american)} · ${money(stake)} pays <b class="pos">${money(stake * t.dec)}</b></span></div>
      ${t.legs.length > 1 ? `<div class="small" style="margin-top:4px">${t.legs.map((r) => `• ${esc(r.label)} ${M.fmtOdds(r.odds)}`).join("<br/>")}</div>` : ""}
      <div class="small ${t.ev >= 0 && t.legs.length <= 2 ? "pos" : "neg"}" style="margin-top:6px">Chance it hits: ${pct(t.prob, t.prob < 0.1 ? 1 : 0)} (${oneIn(t.prob)}) · ${t.ev < 0 ? "the price doesn't cover the risk" : t.legs.length <= 2 ? "worth it at this price" : "an edge on paper, but a ticket this long loses most of the time: bet small"}</div>${note ? `<div class="small faint">${note}</div>` : ""}</div>`;
    $("#c-out").innerHTML = `<div class="card" style="margin-top:14px"><h3>Each leg at your price</h3>${rows.map(legRow).join("")}</div>
      ${all ? `<div class="card" style="margin-top:14px"><h3>Your ticket</h3>
        ${card(ok.length > 1 ? `${ok.length}-leg parlay as entered` : "Straight bet as entered", all, rows.length > ok.length ? `${rows.length - ok.length} line${rows.length - ok.length === 1 ? "" : "s"} couldn't be checked and ${rows.length - ok.length === 1 ? "isn't" : "aren't"} counted.` : "")}
        ${better ? card(`Better: only the legs worth keeping (${keep.length})`, better, "Drops the legs graded C or worse at your price.") : ""}
        ${two && (!better || better.legs.length !== 2) ? card("Most likely 2-leg version", ticket(two.legs), "The two legs from your slip most likely to hit.") : ""}
        <div class="row" style="margin-top:10px"><button class="btn sm" id="c-save">★ Save to My bets</button><button class="btn ghost sm" id="c-share">🔗 Share</button></div>
        <p class="small faint" style="margin:8px 0 0">Chances multiply across legs and treat them as independent. If a leg says "no edge", the book's price is better for the book than for you.</p></div>` : ""}`;
    $("#c-save")?.addEventListener("click", () => {
      if (!bankrollOk(stake)) return;
      const same = new Set(ok.map((r) => r.pick.eventId)).size < ok.length;
      const id = addTicket({ type: ok.length === 1 ? "single" : same ? "sgp" : "parlay", stake, american: all.american, toWin: stake * (all.dec - 1), prob: all.prob, kind: "checked", legs: ok.map((r) => r.pick) });
      for (const r of ok) addPick({ ...r.pick, prob: r.prob, grade: r.grade, ticketId: id });
      toast("Saved to ★ My bets · it tracks live during the games");
    });
    $("#c-share")?.addEventListener("click", async () => {
      const url = await slipUrl(ok.map((r) => r.pick), { stake, american: all.american });
      if (navigator.share) { try { await navigator.share({ title: "PickLab bet slip", url }); } catch { /* cancelled */ } return; }
      navigator.clipboard?.writeText(url).then(() => toast("Link copied"), () => toast("Copy failed"));
    });
  }
  $("#c-go").addEventListener("click", run);
  $("#c-stake").addEventListener("input", () => { if ($("#c-out").innerHTML) run(); });
  if ((q.t || saved).trim()) run();
}
