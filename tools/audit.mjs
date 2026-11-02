// Data audit against live sources: are prop names read right, game lines signed right,
// past picks graded right? Usage: node tools/audit.mjs <today.json> <history.json> [out.json]
import fs from "node:fs";
const { api, parseProps, propMarketKey, boxStats, pool } = await import("../js/espn.js");
const { leagueById, MARKETS } = await import("../js/sports.js");
const { marketValue } = await import("../js/props.js");
const { fmtSpread } = await import("../js/gamemodel.js");

const [todayPath, histPath, outPath = "audit.json"] = process.argv.slice(2);
const today = JSON.parse(fs.readFileSync(todayPath, "utf8"));
const history = histPath && fs.existsSync(histPath) ? JSON.parse(fs.readFileSync(histPath, "utf8")) : { picks: [] };
const out = { issues: [], props: {}, lines: {}, grading: {}, propLines: {} };
const issue = (area, msg, ex) => out.issues.push({ area, msg, ex });

// 1. Every DraftKings prop type name, per league: what it maps to, collisions, unmapped.
for (const lg of ["nba", "ncaab", "nhl", "nfl", "ncaaf"]) {
  const L = leagueById(lg);
  const evs = (today.games || []).filter((g) => g.league === lg && new Date(g.start) > Date.now()).slice(0, 5).map((g) => g.eventId);
  const names = new Map(), collide = [];
  await pool(evs, 3, async (ev) => {
    let items;
    try { items = await api.propBets(L, ev); } catch { return; }
    const per = new Map(); // aid|key -> set of type names
    for (const it of items) {
      const n = it.type?.name || "";
      const k = propMarketKey(n, L.markets);
      names.set(n, k ?? null);
      const aid = it.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1];
      if (!aid || !k) continue;
      const key = `${aid}|${k}`;
      if (!per.has(key)) per.set(key, new Set());
      per.get(key).add(n);
    }
    for (const [key, set] of per) if (set.size > 1) collide.push(`${key}: ${[...set].join(" + ")}`);
  });
  const mapped = [...names].filter(([, k]) => k).map(([n, k]) => `${n} -> ${k}`).sort();
  const skipped = [...names].filter(([, k]) => !k).map(([n]) => n).sort();
  out.props[lg] = { events: evs.length, mapped, skipped, collisions: collide.slice(0, 20) };
  if (collide.length) issue("props", `${lg}: ${collide.length} player markets get two different DraftKings bets`, collide.slice(0, 5));
  // Markets keys the model knows vs what the names map to.
  const known = new Set((MARKETS[L.markets] || []).map((m) => m.key));
  const unknown = [...new Set(mapped.map((x) => x.split(" -> ")[1]))].filter((k) => !known.has(k));
  if (unknown.length) issue("props", `${lg}: names map to markets the model doesn't have`, unknown);
}

// 2. Game lines: the spread legs' team and sign must agree with ESPN's "details" (e.g. "BOS -3.5").
let checked = 0;
for (const g of today.games || []) {
  const d = g.lines?.details;
  const sp = g.lines?.spreadHome;
  // Hockey's summary line is the moneyline favorite ("FLA -185"), not the puck line.
  if (!d || sp == null || /^ev(en)?$/i.test(d) || g.league === "nhl") continue;
  const m = d.match(/^([A-Za-z0-9&.'-]+)\s+([+-]?\d+(\.\d+)?)$/);
  if (!m) continue;
  checked++;
  const fav = m[1], num = Number(m[2]);
  const homeFav = fav === g.home.abbr, awayFav = fav === g.away.abbr;
  const ok = (homeFav && Math.abs(sp - num) < 1e-9) || (awayFav && Math.abs(sp + num) < 1e-9);
  if (!ok) issue("lines", `${g.league} ${g.matchup}: details "${d}" vs spreadHome ${sp}`, null);
  const legs = (today.legs || []).filter((l) => l.gameKey === g.key && l.kind === "spread");
  for (const l of legs) {
    const want = l.side === "HOME" ? `${g.home.abbr} ${fmtSpread(sp)}` : `${g.away.abbr} ${fmtSpread(-sp)}`;
    if (l.label.split(" ").slice(0, 2).join(" ") !== want && !l.live) issue("lines", `${l.id}: label "${l.label}" expected "${want}"`, null);
  }
}
out.lines.spreadsChecked = checked;
const totals = (today.legs || []).filter((l) => l.kind === "total");
out.lines.totalsWithBothPrices = totals.filter((l) => l.priced).length + "/" + totals.length;

// 3. Prop lines vs projections, per market: a mislabeled market shows up as a skewed ratio.
const byMk = {};
for (const l of (today.legs || []).filter((x) => x.kind === "prop" && x.proj > 0 && x.line > 0)) {
  const k = `${l.league}:${l.marketKey}`;
  (byMk[k] ||= []).push(l.line / l.proj);
}
for (const [k, r] of Object.entries(byMk)) {
  r.sort((a, b) => a - b);
  const med = r[Math.floor(r.length / 2)];
  out.propLines[k] = { n: r.length, medianLineOverProjection: Number(med.toFixed(3)) };
  if (r.length >= 10 && (med > 1.25 || med < 0.8)) issue("propLines", `${k}: lines run ${med.toFixed(2)}x the projections (market may be mislabeled)`, null);
}

// 4. Grading: re-check graded props against the game's box score (a different source from the game logs used to grade).
const graded = history.picks.filter((p) => (p.result === "W" || p.result === "L") && p.kind === "prop" && p.marketKey && p.playerId).slice(-60);
let agree = 0, disagree = 0;
const diffs = [];
await pool(graded, 4, async (p) => {
  const L = leagueById(p.league);
  try {
    const sum = await api.summary(L, p.eventId);
    const box = boxStats(sum, L.markets);
    const s = box.get(String(p.playerId));
    const m = (MARKETS[L.markets] || []).find((x) => x.key === p.marketKey);
    if (!s || !m) return;
    const v = marketValue(m, { stats: s });
    if (v == null) return;
    const res = v === p.line ? "P" : (v > p.line) === (p.side === "OVER") ? "W" : "L";
    if (res === p.result) agree++; else { disagree++; diffs.push(`${p.label}: graded ${p.result} (actual ${p.actual}) but box score says ${v} -> ${res}`); }
  } catch { /* skip */ }
});
out.grading = { checked: agree + disagree, agree, disagree, diffs: diffs.slice(0, 10) };
if (disagree) issue("grading", `${disagree} graded picks disagree with the box score`, diffs.slice(0, 5));

fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ issues: out.issues, lines: out.lines, grading: { ...out.grading, diffs: undefined } }, null, 1));
