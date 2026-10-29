// Injury watcher. Runs hourly in GitHub Actions (.github/workflows/watch.yml):
//   node tools/watch.mjs --dir picks-data
// For every pending pick starting in the next 14 hours: checks the game's ESPN injury
// report (player ruled out / doubtful / newly questionable) and the DraftKings line
// (moved hard against the pick since it was posted). Sends one phone alert through
// ntfy; sent alerts are tracked in <dir>/alerts.json so each pick alerts once per event.
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const DIR = args.dir || "picks-data";
const SITE_URL = args.url || "https://ajhy2003.github.io/SportsBettingApp/";
const topic = process.env.NTFY_TOPIC;

const { leagueById } = await import("../js/sports.js");
const { api, parseProps, pickcenterOdds } = await import("../js/espn.js");
const { impliedProb } = await import("../js/model.js");
const { injuryReport } = await import("../js/context.js");

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch { return d; } };
const history = read("history.json", { picks: [] });
const alerts = read("alerts.json", {});
const now = Date.now();

const pending = history.picks.filter((p) => !p.result && new Date(p.start) - now > -15 * 60e3 && new Date(p.start) - now < 14 * 3600e3);
console.log(`watch: ${pending.length} pending picks in the next 14 hours`);

// Has the line moved hard against this pick since it was posted?
function movedAgainst(p, cur) {
  if (!cur) return null;
  if (p.kind === "prop") {
    if (cur.line !== p.line) {
      const against = p.side === "OVER" ? cur.line < p.line : cur.line > p.line;
      return against && Math.abs(cur.line - p.line) >= Math.max(1, 0.08 * Math.abs(p.line)) ? `now ${cur.line}` : null;
    }
    const now = p.side === "OVER" ? cur.over : cur.under;
    return now != null && impliedProb(now) < impliedProb(p.odds ?? -110) - 0.05 ? `price now ${now > 0 ? "+" : ""}${now}` : null;
  }
  if (p.kind === "spread" && cur.spreadHome != null) {
    const side = p.side === "HOME" ? cur.spreadHome : -cur.spreadHome;
    return side - p.line >= 1.5 ? `now ${side > 0 ? "+" : ""}${side}` : null;
  }
  if (p.kind === "total" && cur.total != null) {
    const d = p.side === "OVER" ? p.line - cur.total : cur.total - p.line;
    return d >= Math.max(1.5, 0.02 * p.line) ? `total now ${cur.total}` : null;
  }
  if (p.kind === "ml") {
    const now = p.side === "HOME" ? cur.mlHome : cur.mlAway;
    return now != null && impliedProb(now) < impliedProb(p.odds ?? -110) - 0.05 ? `now ${now > 0 ? "+" : ""}${now}` : null;
  }
  return null;
}

const byGame = new Map();
for (const p of pending) {
  const k = `${p.league}:${p.eventId}`;
  if (!byGame.has(k)) byGame.set(k, []);
  byGame.get(k).push(p);
}

const news = [], moves = [];
for (const [k, picks] of byGame) {
  const [league, ev] = k.split(":");
  const L = leagueById(league);
  let sum;
  try { sum = await api.summary(L, ev); } catch (e) { console.log(`  ${k}: ${e.message}`); continue; }
  const report = injuryReport(sum);
  const all = [...report.values()].flat();
  // Line moves since posting.
  const odds = pickcenterOdds(sum.pickcenter?.[0]);
  const props = picks.some((p) => p.kind === "prop") ? await api.propBets(L, ev).then((items) => parseProps(items, L.markets)).catch(() => null) : null;
  for (const p of picks) {
    if (alerts[`${p.id}:move`]) continue;
    const cur = p.kind === "prop" ? props?.get(String(p.playerId))?.[p.marketKey] : odds;
    const why = movedAgainst(p, cur);
    if (!why) continue;
    moves.push({ p, why });
    alerts[`${p.id}:move`] = { level: "move", why, at: new Date().toISOString(), start: p.start };
  }
  for (const p of picks) {
    if (p.kind !== "prop" || !p.playerId) continue;
    const s = all.find((x) => x.id === String(p.playerId));
    const level = s?.out ? "out" : s?.maybe ? "maybe" : null;
    if (!level || alerts[p.id]?.level === level) continue;
    if (level === "maybe" && /probable/i.test(s.status)) continue;
    news.push({ p, level, status: s.status });
    alerts[p.id] = { level, status: s.status, at: new Date().toISOString(), start: p.start };
  }
}

// Forget alerts for games that finished long ago.
for (const [id, a] of Object.entries(alerts)) if (now - new Date(a.start) > 7 * 864e5) delete alerts[id];
fs.writeFileSync(path.join(DIR, "alerts.json"), JSON.stringify(alerts, null, 1));

if (!news.length && !moves.length) { console.log("watch: no changes"); process.exit(0); }
const out = news.filter((n) => n.level === "out");
const lines = [
  ...news.map(({ p, level, status }) => `${level === "out" ? "❌ Skip" : "⚠️ Check"}: ${p.label} (${p.player} ${status.toLowerCase()})`),
  ...moves.map(({ p, why }) => `📉 Line moved against: ${p.label} (${p.kind === "prop" ? "posted" : "posted at"} ${p.line ?? ""} ${p.odds > 0 ? "+" : ""}${p.odds ?? ""}, ${why})`),
];
const title = out.length ? `PickLab: ${out.length} pick${out.length > 1 ? "s" : ""} hit by injury news`
  : news.length ? `PickLab: injury news on ${news.length} pick${news.length > 1 ? "s" : ""}`
  : `PickLab: the market moved against ${moves.length} pick${moves.length > 1 ? "s" : ""}`;
console.log(title);
console.log(lines.join("\n"));
if (!topic) { console.log("NTFY_TOPIC not set; not sending"); process.exit(0); }
const res = await fetch(process.env.NTFY_SERVER || "https://ntfy.sh/", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topic, title, message: `${lines.join("\n")}${news.length ? "\nIf you already bet a leg, most books void player props when the player doesn't play." : ""}${moves.length ? "\nA big move against a pick usually means news or sharp money; if you haven't bet it yet, think twice." : ""}`, click: `${SITE_URL}#/today`, tags: ["warning"], priority: out.length ? 4 : 3 }),
});
console.log(`ntfy: ${res.status}`);
