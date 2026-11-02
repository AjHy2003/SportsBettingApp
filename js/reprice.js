// Live re-pricing: when DraftKings moves a line or a price, re-run the model's last step
// for every leg in today's picks (the stats chance at the new line, blended with the new
// market price, then the same grading and sanity checks) so picks and tickets follow the
// market between full re-scans. The data file carries each leg's probability ladder.
import { api, getJSON, gameOdds, parseProps, pool } from "./espn.js";
import { leagueById } from "./sports.js";
import * as M from "./model.js";
import { priceLine, fmtSpread } from "./gamemodel.js";
import { decimalOdds, shrinkLeg } from "./parlay.js";

// Ladder spacing for a line, and how many rungs each side of it.
export const ladderStep = (line) => { const a = Math.abs(line); return a < 10 ? 0.5 : a < 40 ? 1 : a < 100 ? 2.5 : 5; };
export const RUNGS = 5;
export const rungsFor = (line, step = ladderStep(line), n = RUNGS) => Array.from({ length: 2 * n + 1 }, (_, k) => Number((line + (k - n) * step).toFixed(2)));
const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);

// ---------- building ladders (daily picks generator) ----------
export function propLadder(res, line) {
  if (!res?.statsLadder || res.statsOver == null) return undefined;
  const st = ladderStep(line), xs = rungsFor(line, st);
  const lad = res.statsLadder(xs);
  if (lad.some((x) => !x)) return undefined;
  const pu = lad.map((x) => r4(x.push));
  return { lo: xs[0], st, so: lad.map((x) => r4(x.so)), ...(pu.some((x) => x > 0) ? { pu } : {}), mw: res.marketWeight, n: res.n,
    pj: r4(res.projection), sd: r4(res.sdProj), ...(res.last5?.length === 5 ? { l5: res.last5 } : {}) };
}

// evalAt(spreadHome, total) -> rows of evaluateLines(); returns the team model's chance for
// the home side / over at each rung, plus the moneyline.
export function gameLadder(gc, st, evalAt) {
  const rows = evalAt(st.spreadHome, st.total);
  const out = { w: gc.wModel, mg: gc.minGames, cap: gc.lineCap };
  const ml = rows.find((r) => r.key === "ml");
  if (ml?.model != null) out.ml = r4(ml.model);
  const build = (key, line, step, at) => {
    const xs = rungsFor(line, step, 8);
    const pa = [], pu = [];
    for (const x of xs) { const r = at(x).find((y) => y.key === key); if (!r || r.model == null) return null; pa.push(r4(r.model)); pu.push(r4(r.push || 0)); }
    return { lo: xs[0], st: step, pa, ...(pu.some((x) => x > 0) ? { pu } : {}) };
  };
  if (st.spreadHome != null) out.sp = build("spread", st.spreadHome, 0.5, (x) => evalAt(x, st.total)) || undefined;
  if (st.total != null) out.tot = build("total", st.total, gc.fam === "basketball" ? 1 : 0.5, (x) => evalAt(st.spreadHome, x)) || undefined;
  return out;
}

// Value at x on a ladder (linear between rungs), or null outside it.
export function ladderAt(lo, st, arr, x) {
  if (!arr || x == null) return null;
  const k = (x - lo) / st;
  if (k < -1e-6 || k > arr.length - 1 + 1e-6) return null;
  const i = Math.min(arr.length - 1, Math.max(0, Math.floor(k + 1e-6))), f = k - i;
  return f < 1e-6 || i >= arr.length - 1 ? arr[i] : arr[i] + f * (arr[i + 1] - arr[i]);
}

const capFlags = (leg, grade) => {
  if (leg.roleChange) return "PASS";
  if ((leg.questionable || leg.moveCap) && (grade === "A" || grade === "B")) return "C";
  return grade;
};

// ---------- re-pricing ----------
// One prop leg against the current DraftKings line/prices: the new numbers, or { far: true }
// when the line moved past the ladder (likely news; wait for the next full scan). When the
// line moves through the model's number, the pick switches sides (Under 5.5 -> Over 4.5)
// if the other side now has a graded edge; otherwise it stays on its side as a pass.
export function repriceProp(leg, f) {
  const rp = leg.rp;
  if (!rp || !f || f.line == null) return null;
  const so = ladderAt(rp.lo, rp.st, rp.so, f.line);
  if (so == null) return { far: true, line: f.line };
  const push = rp.pu ? ladderAt(rp.lo, rp.st, rp.pu, f.line) ?? 0 : 0;
  const priced = f.over != null && f.under != null;
  const oO = f.over ?? -110, oU = f.under ?? -110;
  const mkt = priced ? M.noVig(oO, oU)?.a ?? 0.5 : 0.5;
  const final = (1 - rp.mw) * so + rp.mw * mkt;
  const pO = final * (1 - push), pU = (1 - final) * (1 - push);
  const v = M.makeVerdict(pO, pU, push, oO, oU, M.expectedValue(pO, push, oO), M.expectedValue(pU, push, oU), rp.n);
  M.propGuards(v, { marketWeight: rp.mw, projection: rp.pj, sdProj: rp.sd, line: f.line, statsOver: so, marketProb: mkt, last5: rp.l5 });
  // Same learned shrink as the full scan, then the same caps, on the side the model now leans.
  const sideFor = (side) => {
    const over = side === "OVER", odds = over ? oO : oU;
    const s = shrinkLeg(over ? final : 1 - final, odds, v.lean === side ? v.grade : "PASS", leg.k);
    const grade = capFlags(leg, s.grade);
    return { side, line: f.line, odds, priced, prob: s.prob, edge: s.prob - M.impliedProb(odds), ev: s.prob * decimalOdds(odds) - 1, grade,
      label: leg.player && leg.market ? `${leg.player} ${over ? "Over" : "Under"} ${f.line} ${leg.market}` : leg.label.replace(/(Over|Under) [\d.]+/, `${over ? "Over" : "Under"} ${f.line}`) };
  };
  const mine = sideFor(leg.side);
  if (v.lean && v.lean !== leg.side) {
    const other = sideFor(v.lean);
    if (other.grade !== "PASS") return { ...other, switched: true };
  }
  return mine;
}

// Both sides of each game market against the current lines: Map legId -> new numbers.
export function repriceGame(game, legs, o) {
  const rep = game.rep, out = new Map();
  if (!rep || !o) return out;
  const cfg = { wModel: rep.w, minGames: rep.mg, lineCap: rep.cap };
  const H = game.home.abbr, A = game.away.abbr;
  const markets = [];
  if (rep.sp && o.spreadHome != null) {
    const m = ladderAt(rep.sp.lo, rep.sp.st, rep.sp.pa, o.spreadHome);
    markets.push({ kind: "spread", m, far: m == null, push: rep.sp.pu ? ladderAt(rep.sp.lo, rep.sp.st, rep.sp.pu, o.spreadHome) ?? 0 : 0, oA: o.spreadHomeOdds ?? -110, oB: o.spreadAwayOdds ?? -110,
      labels: [`${H} ${fmtSpread(o.spreadHome)}`, `${A} ${fmtSpread(-o.spreadHome)}`], lines: [o.spreadHome, -o.spreadHome] });
  }
  if (rep.tot && o.total != null) {
    const m = ladderAt(rep.tot.lo, rep.tot.st, rep.tot.pa, o.total);
    markets.push({ kind: "total", m, far: m == null, push: rep.tot.pu ? ladderAt(rep.tot.lo, rep.tot.st, rep.tot.pu, o.total) ?? 0 : 0, oA: o.overOdds ?? -110, oB: o.underOdds ?? -110,
      labels: [`Over ${o.total}`, `Under ${o.total}`], lines: [o.total, o.total] });
  }
  if (rep.ml != null && o.mlHome != null && o.mlAway != null) markets.push({ kind: "ml", m: rep.ml, push: 0, oA: o.mlHome, oB: o.mlAway, labels: [`${H} ML`, `${A} ML`], lines: [null, null] });
  for (const mk of markets) {
    const pair = ["A", "B"].map((s) => legs.find((l) => l.kind === mk.kind && l.id.endsWith(`:${mk.kind}:${s}`)));
    if (mk.far) { pair.forEach((l, i) => l && out.set(l.id, { far: true, line: mk.lines[i] })); continue; }
    const { v, fin } = priceLine(mk.m, mk.push, mk.oA, mk.oB, cfg, mk.labels);
    pair.forEach((l, i) => {
      if (!l) return;
      const odds = i ? mk.oB : mk.oA, lean = v.lean === mk.labels[i];
      const s = shrinkLeg(i ? 1 - fin : fin, odds, lean ? v.grade : "PASS", l.k);
      const prob = s.prob;
      out.set(l.id, { line: mk.lines[i], odds, priced: true, prob, edge: prob - M.impliedProb(odds), ev: prob * decimalOdds(odds) - 1,
        grade: capFlags(l, s.grade), lean, label: mk.labels[i] });
    });
  }
  return out;
}

// ---------- current lines from ESPN (DraftKings) ----------
const etYmd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replaceAll("-", "");
const PARAMS = { ncaaf: "groups=80&limit=300", ncaab: "groups=50&limit=400" };
const WEEKLY = new Set(["nfl", "ncaaf"]);

// games: [{ league, eventId, start }] -> Map eventId -> gameOdds()
export async function currentGameLines(games) {
  const out = new Map();
  const boards = new Map();
  for (const g of games) {
    const params = WEEKLY.has(g.league) ? PARAMS[g.league] || "" : `dates=${etYmd(new Date(g.start))}${PARAMS[g.league] ? `&${PARAMS[g.league]}` : ""}`;
    boards.set(`${g.league}|${params}`, { L: leagueById(g.league), params });
  }
  await Promise.all([...boards.values()].map(async ({ L, params }) => {
    try {
      const sb = await getJSON(`https://site.web.api.espn.com/apis/site/v2/sports/${L.espn}/scoreboard${params ? `?${params}` : ""}`, 60e3);
      for (const e of sb.events || []) { const o = gameOdds(e.competitions?.[0]); if (o) out.set(String(e.id), o); }
    } catch { /* keep going */ }
  }));
  return out;
}

// events: [{ league, eventId }] -> Map eventId -> Map(athleteId -> { marketKey: {line, over, under} })
export async function currentProps(events) {
  const out = new Map();
  await pool(events, 3, async (e) => {
    const L = leagueById(e.league);
    try { const items = await api.propBets(L, e.eventId); out.set(String(e.eventId), parseProps(items, L.markets)); } catch { /* keep going */ }
  });
  return out;
}
