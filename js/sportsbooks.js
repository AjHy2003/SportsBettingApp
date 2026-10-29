// "Place this bet": buttons that open each sportsbook's app or site, DraftKings
// bet-slip links (from ESPN's odds) that add a selection to your slip in one tap,
// and a copy/share slip. Bets are always placed by you in the book's own app.
import { esc, toast } from "./ui.js";
import { fmtOdds } from "./model.js";
import { slipUrl } from "./slip.js";

const DK = { nba: "basketball/nba", wnba: "basketball/wnba", ncaab: "basketball/ncaab", nfl: "football/nfl", ncaaf: "football/ncaaf", nhl: "hockey/nhl", mlb: "baseball/mlb", epl: "soccer/england---premier-league" };
const FD = { nba: "nba", wnba: "wnba", ncaab: "ncaab", nfl: "nfl", ncaaf: "ncaaf", nhl: "nhl", mlb: "mlb" };
const MGM = { nba: "basketball-7", wnba: "basketball-7", ncaab: "basketball-7", nfl: "football-11", ncaaf: "football-11", nhl: "ice-hockey-12", mlb: "baseball-23" };
const CZR = { nba: "basketball", wnba: "basketball", ncaab: "basketball", nfl: "americanfootball", ncaaf: "americanfootball", nhl: "icehockey", mlb: "baseball" };
const st = (s) => String(s || "").toLowerCase();

export const BOOKS = [
  { key: "draftkings", name: "DraftKings", color: "#53d337", url: (lg) => `https://sportsbook.draftkings.com/${DK[lg] ? `leagues/${DK[lg]}` : ""}` },
  { key: "fanduel", name: "FanDuel", color: "#1493ff", url: (lg) => `https://sportsbook.fanduel.com/${FD[lg] ? `navigation/${FD[lg]}` : ""}` },
  { key: "betmgm", name: "BetMGM", color: "#b8975a", url: (lg, s) => `https://sports.${s ? `${st(s)}.` : ""}betmgm.com/en/sports${MGM[lg] ? `/${MGM[lg]}` : ""}` },
  { key: "caesars", name: "Caesars", color: "#1f7a5c", url: (lg, s) => (s ? `https://sportsbook.caesars.com/us/${st(s)}/bet/${CZR[lg] || ""}` : "https://sportsbook.caesars.com/") },
  { key: "fanatics", name: "Fanatics", color: "#e2252a", url: () => "https://sportsbook.fanatics.com/" },
  { key: "betrivers", name: "BetRivers", color: "#1b3a6b", url: (lg, s) => (s ? `https://${st(s)}.betrivers.com/` : "https://www.betrivers.com/") },
  { key: "bet365", name: "bet365", color: "#027b5b", url: () => "https://www.bet365.com/" },
];
// The Odds API names Caesars by its old brand.
const ODDS_API_KEY = { caesars: "williamhill_us" };

export const STATES = ["AZ", "AR", "CO", "CT", "DC", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "NV", "NH", "NJ", "NY", "NC", "OH", "OR", "PA", "RI", "TN", "VT", "VA", "WV", "WI", "WY"];

const PREFS = "picklab.books.v1";
export function bookPrefs() {
  try { return { books: ["draftkings", "fanduel", "betmgm", "caesars", "fanatics"], state: "", ...JSON.parse(localStorage.getItem(PREFS) || "{}") }; } catch { return { books: ["draftkings", "fanduel", "betmgm", "caesars", "fanatics"], state: "" }; }
}
function saveBookPrefs(p) { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* ignore */ } }

// Best link for one leg at one book: exact bet slip > event page > league page.
export function legLink(leg, book, state) {
  if (book.key === "draftkings" && leg.dk) return { href: leg.dk, exact: !!leg.dkExact };
  const l = leg.bookLinks?.[ODDS_API_KEY[book.key] || book.key];
  if (l) return { href: l.replace(/\{state\}/g, st(state) || "nj"), exact: true };
  return { href: book.url(leg.league, state), exact: false };
}

export function slipText(legs, { stake, american, title } = {}) {
  const head = title || (legs.length > 1 ? `${legs.length}-leg parlay` : "Straight bet");
  const pay = stake && american != null ? ` · $${stake} to win $${(stake * (american > 0 ? american / 100 : 100 / -american)).toFixed(2)} (${fmtOdds(american)})` : "";
  return `PickLab · ${head}${pay}\n${legs.map((l, i) => `${i + 1}. ${l.label}${l.matchup ? ` (${l.matchup})` : ""} ${l.odds != null ? fmtOdds(l.odds) : ""}`.trim()).join("\n")}`;
}

const registry = new Map();
let seq = 0;

// The "Place it" panel for a bet (one leg = straight bet, more = parlay).
export function placeBet(legs, opts = {}) {
  const id = `pb${++seq}`;
  registry.set(id, { legs, opts });
  if (registry.size > 300) registry.delete(registry.keys().next().value);
  return `<div class="place" data-place="${id}">${placeInner(legs, opts)}</div>`;
}

function placeInner(legs, opts) {
  const prefs = bookPrefs();
  const books = BOOKS.filter((b) => prefs.books.includes(b.key));
  const one = legs.length === 1 ? legs[0] : null;
  const btn = (b) => {
    const { href, exact } = one ? legLink(one, b, prefs.state) : { href: legs[0]?.league ? b.url(legs[0].league, prefs.state) : b.url("", prefs.state), exact: false };
    return `<a class="bookbtn" style="--bc:${b.color}" href="${esc(href)}" target="_blank" rel="noopener" title="${exact ? `Opens ${b.name} with this bet in your slip` : `Opens ${b.name}`}">${esc(b.name)}${exact ? " ＋" : " ↗"}</a>`;
  };
  const multi = !one && legs.length > 1;
  const chips = (l) => books.map((b) => ({ b, ...legLink(l, b, prefs.state) })).filter((x) => x.exact || (x.b.key === "draftkings" && l.dk))
    .map((x) => `<a class="bookchip" style="--bc:${x.b.color}" href="${esc(x.href)}" target="_blank" rel="noopener">${esc(x.b.name)}${x.exact ? " ＋" : " game"}</a>`).join("");
  return `
    <div class="row place-top"><span class="small muted">${opts.label || "Place it"}</span><span class="small faint">· you bet in the book's app; PickLab never sees your account</span><button class="linkbtn small" data-books-settings title="Choose your sportsbooks and state">⚙ My books</button></div>
    <div class="row place-books">${books.map(btn).join("")}<button class="btn ghost sm" data-copy-slip title="Copy the bets as text, with a link">📋 Copy</button><button class="btn ghost sm" data-share-slip title="A link anyone can open to add these bets to their slip or save them">🔗 Share link</button></div>
    ${multi ? `<details class="place-legs" ${opts.openLegs ? "open" : ""}><summary class="small">Add legs one tap at a time (＋ adds that leg to the book's slip; the legs stack up there, then switch the slip to Parlay)</summary>
      <ol>${legs.map((l) => `<li><span>${esc(l.label)}</span> <span class="faint small">${l.odds != null ? fmtOdds(l.odds) : ""}</span> ${chips(l) || `<span class="faint small">find it in the book</span>`}</li>`).join("")}</ol></details>` : ""}`;
}

function refreshAll() {
  document.querySelectorAll(".place[data-place]").forEach((el) => {
    const r = registry.get(el.dataset.place);
    if (r) el.innerHTML = placeInner(r.legs, r.opts);
  });
}

function openSettings() {
  document.querySelector(".books-modal")?.remove();
  const p = bookPrefs();
  const el = document.createElement("div");
  el.className = "player-modal books-modal";
  el.innerHTML = `<div class="pm-box" style="max-width:520px">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">My sportsbooks</h3><button class="icon-btn" data-close>✕</button></div>
    <p class="small muted" style="margin:6px 0 10px">Pick the books you use; their buttons show on every bet. Your state fills in state-specific links (BetMGM, Caesars, BetRivers).</p>
    <div class="chips" id="bm-books">${BOOKS.map((b) => `<button class="chip ${p.books.includes(b.key) ? "on" : ""}" data-k="${b.key}">${esc(b.name)}</button>`).join("")}</div>
    <div class="field" style="margin-top:12px;max-width:200px"><label>State</label><select id="bm-state"><option value="">—</option>${STATES.map((s) => `<option ${p.state === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
    <p class="small faint" style="margin:10px 0 0">Sports betting is 21+ and only where it's legal; the book checks your location when you bet.</p>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn sm" data-save>Save</button></div>
  </div>`;
  document.body.appendChild(el);
  el.addEventListener("click", (e) => {
    const chip = e.target.closest("#bm-books .chip");
    if (chip) chip.classList.toggle("on");
    if (e.target === el || e.target.closest("[data-close]")) el.remove();
    if (e.target.closest("[data-save]")) {
      const books = [...el.querySelectorAll("#bm-books .chip.on")].map((c) => c.dataset.k);
      saveBookPrefs({ books: books.length ? books : ["draftkings"], state: el.querySelector("#bm-state").value });
      el.remove();
      refreshAll();
      toast("Saved your sportsbooks");
    }
  });
}

// One document-level handler for every panel on every page.
if (typeof document !== "undefined") {
  document.addEventListener("click", async (e) => {
    if (e.target.closest("[data-books-settings]")) { e.preventDefault(); openSettings(); return; }
    const copy = e.target.closest("[data-copy-slip]"), share = e.target.closest("[data-share-slip]");
    if (!copy && !share) return;
    const r = registry.get(e.target.closest(".place")?.dataset.place);
    if (!r) return;
    const text = slipText(r.legs, r.opts);
    let url = "";
    try { url = await slipUrl(r.legs, r.opts); } catch { /* text only */ }
    if (share) {
      if (navigator.share) { try { await navigator.share({ title: "PickLab bet slip", text, url }); } catch { /* cancelled */ } return; }
      navigator.clipboard?.writeText(url).then(() => toast("Link copied: anyone who opens it can add these bets to their slip"), () => toast("Copy failed"));
      return;
    }
    navigator.clipboard?.writeText(url ? `${text}\n\nAdd it to your slip: ${url}` : text).then(() => toast("Bet slip copied"), () => toast("Copy failed"));
  });
}
