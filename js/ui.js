// Small DOM + formatting helpers and the SVG game-log chart.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const pct = (p, d = 0) => (p == null || !isFinite(p) ? "—" : `${(p * 100).toFixed(d)}%`);
export const fx = (x, d = 1) => (x == null || !isFinite(x) ? "—" : Number(x).toFixed(d));
export const signed = (x, d = 1) => (x == null || !isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${Number(x).toFixed(d)}`);

export const fmtDate = (iso, opts = { month: "short", day: "numeric" }) => (iso ? new Date(iso).toLocaleDateString(undefined, opts) : "");
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "");

export const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

export function loading(msg = "Loading…") {
  return `<div class="loading"><span class="spinner"></span>${esc(msg)}</div>`;
}

export function errorBox(err, hint = "") {
  return `<div class="notice warn">Couldn't load this data: ${esc(err?.message || err)}. ${esc(hint)}</div>`;
}

export function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

export function setTitle(t) {
  document.title = t ? `${t} · PickLab` : "PickLab";
}

// Hit-rate tile. good/bad colouring relative to the side being evaluated.
export function hitTile(label, hr, side = "over") {
  if (!hr || !hr.n) return `<div class="hit"><div class="lbl">${esc(label)}</div><div class="pct">—</div><div class="frac">no games</div></div>`;
  const p = side === "over" ? hr.pct : 1 - hr.pct;
  const won = side === "over" ? hr.over : hr.under;
  const decided = hr.over + hr.under;
  const cls = !isFinite(p) ? "" : p >= 0.6 ? "good" : p <= 0.4 ? "bad" : "";
  return `<div class="hit ${cls}"><div class="lbl">${esc(label)}</div><div class="pct">${pct(p)}</div><div class="frac">${won}/${decided}${hr.push ? ` · ${hr.push}P` : ""}</div></div>`;
}

// Bar chart of per-game values vs a line. games newest first; drawn oldest -> newest.
export function gameChart(games, line, projection, { height = 220, label = (g) => g.opp, invert = false } = {}) {
  const data = [...games].reverse();
  const n = data.length;
  if (!n) return `<div class="notice">No games in this window.</div>`;
  const barW = Math.max(14, Math.min(34, Math.floor(820 / n) - 6));
  const gap = 6;
  const padL = 34, padB = 40, padT = 12;
  const width = padL + n * (barW + gap) + 10;
  const vals = data.map((g) => g.value ?? 0);
  const top = Math.max(...vals, isFinite(line) ? line : 0, isFinite(projection) ? projection : 0) * 1.12 || 1;
  const y = (v) => padT + (height - padT - padB) * (1 - v / top);
  const ticks = niceTicks(top, 4);
  let svg = `<svg width="${width}" height="${height}" role="img" aria-label="Game log chart">`;
  svg += `<g class="axis">`;
  for (const t of ticks) svg += `<line class="gridline" x1="${padL}" x2="${width}" y1="${y(t)}" y2="${y(t)}" opacity="0.5"/><text x="${padL - 6}" y="${y(t) + 3}" text-anchor="end">${t}</text>`;
  svg += `</g>`;
  data.forEach((g, i) => {
    const v = g.value ?? 0;
    const x = padL + i * (barW + gap) + gap / 2;
    const above = invert ? v < line : v > line;
    const below = invert ? v > line : v < line;
    const cls = !isFinite(line) ? "bar-over" : above ? "bar-over" : below ? "bar-under" : "bar-push";
    const h = Math.max(2, y(0) - y(v));
    const tip = `${fmtDate(g.date)} ${g.home ? "vs" : "@"} ${g.opp || ""} · ${v}${g.minutes ? ` · ${Math.round(g.minutes)} min` : ""}${g.result ? ` · ${g.result} ${g.score || ""}` : ""}`;
    svg += `<rect class="${cls}" x="${x}" y="${y(0) - h}" width="${barW}" height="${h}" rx="3" data-tip="${esc(tip)}"/>`;
    if (barW >= 18) svg += `<text x="${x + barW / 2}" y="${y(0) - h - 3}" text-anchor="middle" font-size="10.5" fill="currentColor" opacity=".85">${fmtNum(v)}</text>`;
    svg += `<g class="axis"><text x="${x + barW / 2}" y="${height - padB + 14}" text-anchor="middle">${esc(label(g) || "")}</text><text x="${x + barW / 2}" y="${height - padB + 27}" text-anchor="middle" opacity=".7">${esc(fmtDate(g.date, { month: "numeric", day: "numeric" }))}</text></g>`;
  });
  if (isFinite(line)) svg += `<line class="line-mark" x1="${padL}" x2="${width}" y1="${y(line)}" y2="${y(line)}"/><text x="${width - 4}" y="${y(line) - 4}" text-anchor="end" font-size="11" font-weight="700" fill="currentColor">Line ${line}</text>`;
  if (isFinite(projection)) svg += `<line class="proj-mark" x1="${padL}" x2="${width}" y1="${y(projection)}" y2="${y(projection)}"/><text x="${padL + 4}" y="${y(projection) - 4}" font-size="11" font-weight="700" fill="var(--accent-2)">Proj ${fmtNum(projection)}</text>`;
  svg += `</svg>`;
  return `<div class="chart-wrap">${svg}<div class="chart-tip"></div></div>`;
}

const fmtNum = (v) => (Number.isInteger(v) ? v : Number(v).toFixed(1));

function niceTicks(max, count) {
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

// One delegated tooltip handler for every chart on the page.
export function wireChartTips(root) {
  root.addEventListener("mousemove", (e) => {
    const r = e.target.closest?.("rect[data-tip]");
    const wrap = e.target.closest?.(".chart-wrap");
    $$(".chart-tip", root).forEach((t) => { if (!wrap || !wrap.contains(t)) t.style.display = "none"; });
    if (!r || !wrap) return;
    const tip = $(".chart-tip", wrap);
    const box = wrap.getBoundingClientRect();
    tip.textContent = r.dataset.tip;
    tip.style.display = "block";
    tip.style.left = `${Math.min(e.clientX - box.left + wrap.scrollLeft + 10, wrap.scrollWidth - tip.offsetWidth - 4)}px`;
    tip.style.top = `${e.clientY - box.top - 34}px`;
  });
  root.addEventListener("mouseleave", () => $$(".chart-tip", root).forEach((t) => (t.style.display = "none")));
}

// Side-by-side comparison row for the game analyzer. higherIsBetter decides highlighting.
export function cmpRow(label, a, b, { d = 1, higherIsBetter = true, fmt } = {}) {
  const f = fmt || ((v) => fx(v, d));
  const valid = isFinite(a) && isFinite(b);
  const max = valid ? Math.max(Math.abs(a), Math.abs(b)) || 1 : 1;
  const aBetter = valid && (higherIsBetter ? a > b : a < b);
  const bBetter = valid && (higherIsBetter ? b > a : b < a);
  const w = (v) => (isFinite(v) ? Math.max(4, (Math.abs(v) / max) * 100) : 0);
  return `<div class="a ${aBetter ? "better" : ""}"><b>${f(a)}</b><div class="bar" style="width:${w(a)}px"></div></div>
    <div class="lbl">${esc(label)}</div>
    <div class="b ${bBetter ? "better" : ""}"><div class="bar" style="width:${w(b)}px"></div><b>${f(b)}</b></div>`;
}
