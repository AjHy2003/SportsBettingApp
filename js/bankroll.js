// Bankroll: your settings, spending against your limits, profit and loss from saved
// tickets, and backup / restore of everything stored in this browser.
import { loadPicks, savePicks, loadTickets, saveTickets } from "./store.js";
import { esc, toast } from "./ui.js";
import { payout } from "./model.js";
import { leagueById } from "./sports.js";

const KEY = "picklab.bankroll.v1";
const DEFAULTS = { bankroll: null, dailyPct: 5, dailyLimit: null, weeklyLimit: null, since: null };

export function bankroll() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...DEFAULTS }; }
}
function saveBankroll(b) { try { localStorage.setItem(KEY, JSON.stringify(b)); } catch { /* ignore */ } }

const etDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const money = (x) => `$${Math.abs(x) >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2).replace(/\.00$/, "")}`;

// Money put on saved tickets today and this week (Monday start, Eastern time).
export function spend(tickets = loadTickets()) {
  const now = new Date();
  const today = etDay(now);
  const noon = new Date(`${today}T12:00:00Z`);
  const monday = new Date(noon.getTime() - ((noon.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
  const day = tickets.filter((t) => etDay(new Date(t.created)) === today).reduce((s, t) => s + (Number(t.stake) || 0), 0);
  const week = tickets.filter((t) => etDay(new Date(t.created)) >= monday).reduce((s, t) => s + (Number(t.stake) || 0), 0);
  return { day, week };
}

export function limitCheck(stake) {
  const b = bankroll(), s = spend();
  if (b.dailyLimit && s.day + stake > b.dailyLimit) return { ok: false, msg: `This puts you at ${money(s.day + stake)} today, over your ${money(b.dailyLimit)} daily limit.` };
  if (b.weeklyLimit && s.week + stake > b.weeklyLimit) return { ok: false, msg: `This puts you at ${money(s.week + stake)} this week, over your ${money(b.weeklyLimit)} weekly limit.` };
  return { ok: true };
}

// Before saving a bet: fine, or the user confirms going past a limit.
export function bankrollOk(stake) {
  const c = limitCheck(Number(stake) || 0);
  return c.ok || (typeof confirm === "function" && confirm(`${c.msg}\n\nSave it anyway?`));
}

// Today's suggested spend: a share of the bankroll, never past what's left of a limit.
export function suggestedBudget() {
  const b = bankroll();
  if (!b.bankroll) return null;
  const s = spend();
  let x = (b.bankroll + profitSince(b.since)) * (b.dailyPct / 100);
  if (b.dailyLimit) x = Math.min(x, b.dailyLimit - s.day);
  if (b.weeklyLimit) x = Math.min(x, b.weeklyLimit - s.week);
  return Math.max(0, Math.round(x));
}

export const ticketProfit = (t) => (t.result === "W" ? (Number(t.stake) || 0) * payout(t.american) : t.result === "L" ? -(Number(t.stake) || 0) : 0);
function profitSince(since) {
  return loadTickets().filter((t) => t.result && (!since || new Date(t.created) >= new Date(since))).reduce((s, t) => s + ticketProfit(t), 0);
}

// Balance over time from settled tickets.
export function ledger() {
  const b = bankroll();
  const settled = loadTickets().filter((t) => t.result && (!b.since || new Date(t.created) >= new Date(b.since))).sort((x, y) => new Date(x.created) - new Date(y.created));
  let bal = b.bankroll || 0;
  const points = [{ t: b.since || settled[0]?.created || new Date().toISOString(), v: bal }];
  for (const t of settled) { bal += ticketProfit(t); points.push({ t: t.created, v: bal }); }
  return { start: b.bankroll || 0, balance: bal, points, settled };
}

const typeOf = (t) => (t.kind === "moonshot" ? "Moonshot" : t.type === "single" ? "Straight" : t.type === "sgp" ? "Same-game parlay" : "Parlay");
const sportOf = (t) => { const ls = [...new Set((t.legs || []).map((l) => l.league))]; return ls.length === 1 ? leagueById(ls[0])?.name || ls[0] : "Mixed"; };

// P/L split by sport, bet type and book.
export function breakdown(tickets = loadTickets().filter((t) => t.result)) {
  const by = (fn) => {
    const m = new Map();
    for (const t of tickets) {
      const k = fn(t);
      const r = m.get(k) || { k, n: 0, w: 0, l: 0, staked: 0, profit: 0 };
      r.n++; if (t.result === "W") r.w++; if (t.result === "L") r.l++;
      r.staked += Number(t.stake) || 0; r.profit += ticketProfit(t);
      m.set(k, r);
    }
    return [...m.values()].map((r) => ({ ...r, roi: r.staked ? r.profit / r.staked : null })).sort((a, b) => b.profit - a.profit);
  };
  return { sport: by(sportOf), type: by(typeOf), book: by((t) => t.book || "Not set") };
}

// Small SVG line of the balance.
export function balanceChart(points, { width = 600, height = 140 } = {}) {
  if (points.length < 2) return "";
  const vs = points.map((p) => p.v), lo = Math.min(...vs), hi = Math.max(...vs);
  const pad = (hi - lo) * 0.1 || 1;
  const x = (i) => (i / (points.length - 1)) * (width - 8) + 4;
  const y = (v) => height - 6 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (height - 12);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const up = vs.at(-1) >= vs[0];
  return `<svg viewBox="0 0 ${width} ${height}" class="bal-chart" role="img" aria-label="Bankroll over time"><line x1="0" x2="${width}" y1="${y(vs[0])}" y2="${y(vs[0])}" class="bal-base"/><path d="${d}" class="${up ? "up" : "down"}"/></svg>`;
}

// ---------- settings ----------
export function openBankrollSettings(onSave) {
  document.querySelector(".bank-modal")?.remove();
  const b = bankroll();
  const el = document.createElement("div");
  el.className = "player-modal bank-modal";
  el.innerHTML = `<div class="pm-box" style="max-width:520px">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">🏦 My bankroll</h3><button class="icon-btn" data-close>✕</button></div>
    <p class="small muted" style="margin:6px 0 10px">The money you've set aside for betting. The app suggests a daily budget from it and warns before you pass your limits. Stored in this browser only.</p>
    <div class="form-row">
      <div class="field"><label>Bankroll ($)</label><input id="bk-amt" type="number" min="0" step="10" inputmode="decimal" value="${b.bankroll ?? ""}" placeholder="e.g. 500"/></div>
      <div class="field"><label>Daily budget (% of bankroll)</label><input id="bk-pct" type="number" min="1" max="25" step="1" inputmode="numeric" value="${b.dailyPct}"/></div>
    </div>
    <div class="form-row" style="margin-top:10px">
      <div class="field"><label>Daily limit ($, optional)</label><input id="bk-day" type="number" min="0" step="5" inputmode="decimal" value="${b.dailyLimit ?? ""}"/></div>
      <div class="field"><label>Weekly limit ($, optional)</label><input id="bk-week" type="number" min="0" step="10" inputmode="decimal" value="${b.weeklyLimit ?? ""}"/></div>
    </div>
    <label class="small muted row" style="gap:6px;margin-top:10px"><input type="checkbox" id="bk-reset" ${b.since ? "" : "checked"}/> Start counting profit and loss from today</label>
    <p class="small faint" style="margin:10px 0 0">A common rule: 1–5% of your bankroll per bet, and never chase losses. If betting stops being fun, call or text 1-800-GAMBLER.</p>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn sm" data-save>Save</button></div>
  </div>`;
  document.body.appendChild(el);
  const num = (id) => { const v = el.querySelector(id).value; return v === "" ? null : Math.max(0, Number(v)); };
  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest("[data-close]")) el.remove();
    if (e.target.closest("[data-save]")) {
      const nb = { ...b, bankroll: num("#bk-amt"), dailyPct: Math.min(25, Math.max(1, num("#bk-pct") || 5)), dailyLimit: num("#bk-day"), weeklyLimit: num("#bk-week") };
      if (el.querySelector("#bk-reset").checked) nb.since = new Date().toISOString();
      saveBankroll(nb);
      el.remove();
      toast("Saved your bankroll");
      onSave?.();
    }
  });
}

// ---------- backup / restore ----------
const EXTRA_KEYS = ["picklab.books.v1", "picklab.bankroll.v1", "picklab.today.v1", "picklab.news.v1"];

export function downloadBackup() {
  const settings = {};
  for (const k of EXTRA_KEYS) { try { const v = localStorage.getItem(k); if (v) settings[k] = JSON.parse(v); } catch { /* skip */ } }
  const data = { app: "PickLab", version: 1, exported: new Date().toISOString(), picks: loadPicks(), tickets: loadTickets(), settings };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `picklab-backup-${etDay(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast(`Backed up ${data.picks.length} picks and ${data.tickets.length} tickets`);
}

// Merge a backup into this browser (nothing already here is overwritten).
export function restoreBackup(file, onDone) {
  const r = new FileReader();
  r.onload = () => {
    let d;
    try { d = JSON.parse(r.result); } catch { toast("That file isn't a PickLab backup"); return; }
    if (d?.app !== "PickLab" || !Array.isArray(d.picks) || !Array.isArray(d.tickets)) { toast("That file isn't a PickLab backup"); return; }
    const picks = loadPicks(), tickets = loadTickets();
    const haveP = new Set(picks.map((p) => p.id)), haveT = new Set(tickets.map((t) => t.id));
    const newP = d.picks.filter((p) => p?.id && !haveP.has(p.id)), newT = d.tickets.filter((t) => t?.id && !haveT.has(t.id));
    savePicks([...picks, ...newP].sort((a, b) => new Date(b.created) - new Date(a.created)));
    saveTickets([...tickets, ...newT].sort((a, b) => new Date(b.created) - new Date(a.created)));
    for (const [k, v] of Object.entries(d.settings || {})) {
      if (EXTRA_KEYS.includes(k) && !localStorage.getItem(k)) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
    }
    toast(`Restored ${newP.length} picks and ${newT.length} tickets`);
    onDone?.();
  };
  r.readAsText(file);
}

export const bankrollMoney = money;
