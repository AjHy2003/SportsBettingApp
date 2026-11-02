// Temporary: what DraftKings (via ESPN) and the deployed scan say about one prop right now.
import fs from "node:fs";
const { api, parseProps } = await import("../js/espn.js");
const { leagueById } = await import("../js/sports.js");
const out = {};
const site = await (await fetch("https://ajhy2003.github.io/SportsBettingApp/data/picks/today.json", { cache: "no-store" })).json();
out.scan = site.generated;
const legs = site.legs.filter((l) => /Tre Jones/.test(l.player || l.label || ""));
out.scanLegs = legs.map((l) => `${l.label} ${l.odds} grade ${l.grade} lean ${l.lean} k ${l.k ?? 1} line ${l.line} book ${JSON.stringify(l.book)}`);
const L = leagueById("nba");
for (const ev of [...new Set(legs.map((l) => l.eventId))]) {
  const items = await api.propBets(L, ev);
  const props = parseProps(items, L.markets);
  const pid = legs.find((l) => l.eventId === ev)?.playerId;
  out[`espn_dk_now_${ev}`] = props.get(String(pid));
  out[`raw_${ev}`] = items.filter((it) => it.athlete?.$ref?.includes(`/athletes/${pid}`) && /assist/i.test(it.type?.name || "")).map((it) => ({ type: it.type?.name, target: it.current?.target?.value, total: it.odds?.total?.value, american: it.odds?.american?.value, open: it.odds?.american?.open }));
}
console.log(JSON.stringify(out, null, 1));
fs.mkdirSync("probe-out", { recursive: true });
fs.writeFileSync("probe-out/tre.json", JSON.stringify(out, null, 1));
