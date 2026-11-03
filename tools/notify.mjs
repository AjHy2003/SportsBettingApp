// Send today's picks to your phone through ntfy.sh (free; install the ntfy app and
// subscribe to your topic). Topic comes from the NTFY_TOPIC repo secret.
import fs from "node:fs";

const topic = process.env.NTFY_TOPIC;
if (!topic) {
  console.log("NTFY_TOPIC not set; skipping notification");
  process.exit(0);
}
// --once-daily <file>: send on the first run between 10:45am and 8pm ET that hasn't sent today
// (GitHub skips scheduled runs when it's busy, so any later run catches up), and record
// the day in <file>. A manual run sends regardless.
const args = process.argv.slice(2);
const onceFile = args.includes("--once-daily") ? args[args.indexOf("--once-daily") + 1] : null;
const force = args.includes("--force");
const et = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  .formatToParts(new Date()).map((x) => [x.type, x.value]));
const etDay = `${et.year}-${et.month}-${et.day}`, etMin = Number(et.hour) * 60 + Number(et.minute);
if (onceFile && !force) {
  let last = null;
  try { last = JSON.parse(fs.readFileSync(onceFile, "utf8")).day; } catch {}
  if (last === etDay) { console.log(`Already sent today's picks (${etDay})`); process.exit(0); }
  if (etMin < 10 * 60 + 45 || etMin > 20 * 60) { console.log(`Not the time for today's picks (${et.hour}:${et.minute} ET)`); process.exit(0); }
}
const n = JSON.parse(fs.readFileSync("notify.json", "utf8"));
if (n.skip) {
  console.log("Data sources failed this run; not sending a misleading notification");
  process.exit(0);
}
const res = await fetch(process.env.NTFY_SERVER || "https://ntfy.sh/", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topic, title: n.title, message: n.body, click: n.click, tags: ["basketball", "football"], priority: 3 }),
});
console.log(`ntfy: ${res.status}`);
if (!res.ok) process.exit(1);
if (onceFile && !force) fs.writeFileSync(onceFile, JSON.stringify({ day: etDay, sent: new Date().toISOString() }));
