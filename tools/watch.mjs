// Injury watcher. Runs hourly in GitHub Actions (.github/workflows/watch.yml):
//   node tools/watch.mjs --dir picks-data
// For every pending player-prop pick starting in the next 14 hours, checks the
// game's ESPN injury report. If the player is ruled out (or doubtful), or newly
// questionable, sends one phone alert through ntfy. Sent alerts are tracked in
// <dir>/alerts.json so each pick alerts at most once per status.
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith("--") ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const DIR = args.dir || "picks-data";
const SITE_URL = args.url || "https://ajhy2003.github.io/SportsBettingApp/";
const topic = process.env.NTFY_TOPIC;

const { leagueById } = await import("../js/sports.js");
const { api } = await import("../js/espn.js");
const { injuryReport } = await import("../js/context.js");

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch { return d; } };
const history = read("history.json", { picks: [] });
const alerts = read("alerts.json", {});
const now = Date.now();

const pending = history.picks.filter((p) => p.kind === "prop" && !p.result && p.playerId && new Date(p.start) - now > -15 * 60e3 && new Date(p.start) - now < 14 * 3600e3);
console.log(`watch: ${pending.length} pending prop picks in the next 14 hours`);

const byGame = new Map();
for (const p of pending) {
  const k = `${p.league}:${p.eventId}`;
  if (!byGame.has(k)) byGame.set(k, []);
  byGame.get(k).push(p);
}

const news = [];
for (const [k, picks] of byGame) {
  const [league, ev] = k.split(":");
  let report;
  try { report = injuryReport(await api.summary(leagueById(league), ev)); } catch (e) { console.log(`  ${k}: ${e.message}`); continue; }
  const all = [...report.values()].flat();
  for (const p of picks) {
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

if (!news.length) { console.log("watch: no changes"); process.exit(0); }
const out = news.filter((n) => n.level === "out");
const lines = news.map(({ p, level, status }) => `${level === "out" ? "❌ Skip" : "⚠️ Check"}: ${p.label} (${p.player} ${status.toLowerCase()})`);
const title = out.length ? `PickLab: ${out.length} pick${out.length > 1 ? "s" : ""} hit by injury news` : `PickLab: injury news on ${news.length} pick${news.length > 1 ? "s" : ""}`;
console.log(title);
console.log(lines.join("\n"));
if (!topic) { console.log("NTFY_TOPIC not set; not sending"); process.exit(0); }
const res = await fetch(process.env.NTFY_SERVER || "https://ntfy.sh/", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topic, title, message: `${lines.join("\n")}\nIf you already bet a leg, most books void player props when the player doesn't play.`, click: `${SITE_URL}#/today`, tags: ["warning"], priority: out.length ? 4 : 3 }),
});
console.log(`ntfy: ${res.status}`);
