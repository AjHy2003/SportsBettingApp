// Send today's picks to your phone through ntfy.sh (free; install the ntfy app and
// subscribe to your topic). Topic comes from the NTFY_TOPIC repo secret.
import fs from "node:fs";

const topic = process.env.NTFY_TOPIC;
if (!topic) {
  console.log("NTFY_TOPIC not set; skipping notification");
  process.exit(0);
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
