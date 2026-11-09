// Parlay + bankroll math shared by the Today page and the daily picks generator.
// A leg: { id, gameKey, playerId?, kind, marketKey, side, label, odds, prob, edge, grade }.
import { payout, toAmerican, impliedProb } from "./model.js";

export const decimalOdds = (american) => 1 + payout(american ?? -110);

export function combine(legs) {
  const dec = legs.reduce((d, l) => d * decimalOdds(l.odds), 1);
  const prob = legs.reduce((p, l) => p * l.prob, 1);
  return { decimal: dec, american: toAmerican(1 / dec), prob, ev: prob * dec - 1, implied: 1 / dec };
}

// Can these two legs share a ticket?
export function compatible(a, b, sgp = false) {
  if (a.id === b.id) return false;
  if (a.playerId && a.playerId === b.playerId) return false; // same player's stats move together
  if (!sgp) return a.gameKey !== b.gameKey;
  if (a.gameKey !== b.gameKey) return false;
  const lineKinds = new Set(["spread", "ml"]);
  if (lineKinds.has(a.kind) && lineKinds.has(b.kind)) return false; // spread + ML on one game is one bet twice
  if (a.kind === "total" && b.kind === "total") return false;
  return true;
}

// Greedy best n-leg parlay from candidate legs (highest edge first), honoring compatibility.
// by: "edge" (best value) or "prob" (most likely to hit, among legs with an edge).
export function bestParlay(legs, n, { sgp = false, minEdge = 0, exclude = [], by = "edge" } = {}) {
  const pool = legs
    .filter((l) => l.prob > 0 && l.edge >= minEdge && !exclude.includes(l.id))
    .sort(by === "prob" ? (a, b) => b.prob - a.prob || b.edge - a.edge : (a, b) => b.edge - a.edge || b.prob - a.prob);
  const pick = [];
  for (const l of pool) {
    if (pick.every((p) => compatible(p, l, sgp))) pick.push(l);
    if (pick.length === n) break;
  }
  return pick.length === n ? { legs: pick, ...combine(pick) } : null;
}

// Best n-leg same-game parlay for one game, from graded legs only (A-C): a leg the model
// passes on doesn't belong in a parlay it recommends.
export function bestSameGame(legs, gameKey, n) {
  return bestParlay(legs.filter((l) => l.gameKey === gameKey && !l.mismatch && usableLeg(l) && GRADE_WEIGHT[l.grade]), n, { sgp: true, minEdge: 0.025 });
}

const roundStake = (x) => Math.max(1, Math.round(x * 2) / 2);

// Quarter-Kelly share for a single bet (never zero so small edges still get a token stake).
function kellyWeight(l) {
  const b = decimalOdds(l.odds) - 1;
  const f = (l.prob * (b + 1) - 1) / b;
  return Math.max(0.01, f / 4);
}

// Straight bets: one per player, one line bet per game, at most two bets per game.
function singlesOk(chosen, l) {
  if (chosen.filter((c) => c.gameKey === l.gameKey).length >= 2) return false;
  return chosen.every((c) => !(l.playerId && c.playerId === l.playerId) && !(c.gameKey === l.gameKey && c.kind !== "prop" && l.kind !== "prop"));
}

function singles(legs, budget, k) {
  const chosen = [];
  for (const l of [...legs].sort((a, b) => b.edge - a.edge)) {
    if (singlesOk(chosen, l)) chosen.push(l);
    if (chosen.length === k) break;
  }
  if (!chosen.length) return [];
  const w = chosen.map(kellyWeight);
  const tw = w.reduce((a, b) => a + b, 0);
  const bets = chosen.map((l, i) => ({ type: "single", legs: [l], stake: roundStake((budget * w[i]) / tw), ...combine([l]) }));
  // Make stakes add up to the budget exactly (adjust the biggest bet).
  const diff = Math.round((budget - bets.reduce((s, b) => s + b.stake, 0)) * 2) / 2;
  if (diff) { const big = bets.reduce((a, b) => (b.stake > a.stake ? b : a)); big.stake = Math.max(1, big.stake + diff); }
  return bets;
}

const SINGLES_COUNT = (budget) => (budget <= 5 ? 2 : budget <= 10 ? 3 : budget <= 25 ? 4 : budget <= 50 ? 5 : 6);

// mode: "singles" | "parlay" | "mix". Returns { bets, totals }.
export function planTicket(legs, budget, mode = "mix", nLegs = 3, { sgpGameKey = null, style = "edge" } = {}) {
  budget = Math.max(1, Number(budget) || 10);
  const good = legs.filter((l) => l.edge > 0 && l.prob > 0 && !l.mismatch && usableLeg(l) && GRADE_WEIGHT[l.grade]);
  let bets = [];
  // Every leg from one game (say, the only NFL game today): the parlay has to be a same-game parlay.
  const oneGame = !sgpGameKey && good.length && new Set(good.map((l) => l.gameKey)).size === 1 ? good[0].gameKey : null;
  const sameGame = sgpGameKey || oneGame;
  const parlayType = sameGame ? "sgp" : "parlay";
  // Asked for more legs than there are good ones: build the longest parlay available.
  const parlayOf = (n) => {
    for (let k = n; k >= 2; k--) {
      const p = sameGame ? bestSameGame(legs, sameGame, k) : bestParlay(good, k, { by: style, minEdge: style === "prob" ? 0.025 : 0 });
      if (p) return p;
    }
    return null;
  };
  if (mode === "parlay" || sgpGameKey) {
    const p = parlayOf(nLegs);
    if (p) bets = [{ type: parlayType, stake: budget, ...p }];
  } else if (mode === "singles") {
    bets = singles(good, budget, SINGLES_COUNT(budget));
  } else {
    // Mix: ~70% on straight bets, ~30% on one parlay.
    const p = budget >= 4 ? parlayOf(nLegs) : null;
    const parlayStake = p ? roundStake(budget * 0.3) : 0;
    bets = singles(good, budget - parlayStake, Math.max(1, SINGLES_COUNT(budget) - 1));
    if (p) bets.push({ type: parlayType, stake: parlayStake, ...p });
  }
  for (const b of bets) {
    b.toWin = b.stake * (b.decimal - 1);
    b.expected = b.stake * b.ev;
  }
  const totals = {
    stake: bets.reduce((s, b) => s + b.stake, 0),
    maxReturn: bets.reduce((s, b) => s + b.stake * b.decimal, 0),
    expectedProfit: bets.reduce((s, b) => s + b.expected, 0),
  };
  return { bets, totals };
}

export const breakEven = (odds) => impliedProb(odds ?? -110);

const GRADE_WEIGHT = { A: 1, B: 0.85, C: 0.6 };
// The market moving toward a pick is a small vote of confidence; away, a small knock.
export const pickScore = (l) => l.edge * (GRADE_WEIGHT[l.grade] || 0) * (l.move?.toward ? 1.1 : l.move?.against ? 0.9 : 1);

// A prop without real DraftKings prices (all NFL and college football props come that
// way) was judged at an assumed -110 against a 50/50 market. Those went 15-31, so they're
// research only: never a pick, ticket leg or moonshot leg.
// Moneyline underdogs at +150 or longer are research only too: the team models rate big
// underdogs far too high (posted ones went 4-70, college basketball +1000 to +5000 dogs 2-55,
// rated about 10% to win when they won 3.5%), and the market prices mismatches better.
export const LONGSHOT_ML = 150;
export const isLongshotML = (l) => l.kind === "ml" && (l.odds ?? 0) >= LONGSHOT_ML;
export const usableLeg = (l) => !(l.kind === "prop" && l.priced === false) && !l.questionable && !isLongshotML(l);

// ⭐ Best bet: grade A, a 10%+ edge, and the market not moving against it (posted line or
// the live re-check). Since launch, NBA picks with a 10%+ edge went 9-3 and NBA picks whose
// line moved against them went 2-4.
export function movedAgainst(l) {
  const lv = l.live;
  if (l.move?.against) return true;
  if (!lv || lv.far) return !!lv?.far;
  if (l.kind === "prop" && lv.line0 != null && l.line !== lv.line0) return l.side === "OVER" ? l.line > lv.line0 : l.line < lv.line0;
  return lv.odds0 != null && l.odds < lv.odds0 - 5;
}
export const isBestBet = (l) => l.lean && l.grade === "A" && l.edge >= 0.1 && !l.mismatch && usableLeg(l) && !movedAgainst(l);
// The same test on a logged pick (no live data): for the running record.
export const wasBestBet = (p) => p.grade === "A" && (p.edge ?? 0) >= 0.1 && !(p.kind === "prop" && (p.league === "nfl" || p.league === "ncaaf"));

// ---------- learning from results ----------
const GRADE_ORDER = ["A", "B", "C", "PASS"];
export const gradeFromEdge = (e) => (e >= 0.08 ? "A" : e >= 0.05 ? "B" : e >= 0.025 ? "C" : "PASS");
const worse = (a, b) => GRADE_ORDER[Math.max(GRADE_ORDER.indexOf(a), GRADE_ORDER.indexOf(b))];
// Props learn overs and unders separately (books shade the side the public bets, and a
// model can lean one way); game lines per league, moneylines apart from spreads and totals.
export const learnGroup = (l) => l.kind === "prop" ? `${l.league}:prop:${l.side === "OVER" ? "over" : "under"}` : `${l.league}:${l.kind === "ml" ? "ml" : "line"}`;
const parentGroup = (g) => g.replace(/:(over|under)$/, "");
// The learned share of the edge for a leg on a given side (props carry both sides' k so a
// pick that switches sides on a re-check uses the right one).
export const kFor = (l, side = l.side) => l.ks?.[side] ?? l.k;

// How much of the model's claimed edge actually showed up in graded picks, per league and
// bet type: k = (hit rate - break-even) / (model's chance - break-even), never above 1.
// One night's legs are tied together (a player's points, rebounds and assists all come from
// the same game), so each player-game (each game, for game lines) counts once however many
// legs it had. A league's props are pulled toward "all of it" by a prior worth 100
// player-games; its overs and unders are each pulled toward the league's props by 50.
export function edgeShrink(picks, prior = 100, sidePrior = 50) {
  const done = picks.filter((x) => x.result === "W" || x.result === "L");
  const unit = (p) => (p.kind === "prop" ? `${p.league}:${p.eventId}:${p.playerId}` : `${p.league}:${p.eventId}:lines`);
  const legsIn = {};
  for (const p of done) legsIn[unit(p)] = (legsIn[unit(p)] || 0) + 1;
  const groups = {};
  const add = (key, p, wt) => {
    const g = (groups[key] ||= { n: 0, w: 0, ne: 0, we: 0, model: 0, be: 0 });
    g.n++; g.ne += wt;
    if (p.result === "W") { g.w++; g.we += wt; }
    g.model += wt * (p.praw ?? p.prob); g.be += wt * impliedProb(p.odds ?? -110);
  };
  for (const p of done) {
    const wt = 1 / legsIn[unit(p)], key = learnGroup(p);
    add(key, p, wt);
    if (key !== parentGroup(key)) add(parentGroup(key), p, wt);
  }
  const fit = (g, toward, strength) => {
    const hit = g.we / g.ne, model = g.model / g.ne, be = g.be / g.ne;
    const raw = model - be > 0.01 ? (hit - be) / (model - be) : 1;
    g.k = Math.min(1, (g.ne * Math.max(0, Math.min(1.2, raw)) + strength * toward) / (g.ne + strength));
    Object.assign(g, { hit, model, be });
  };
  for (const [key, g] of Object.entries(groups)) if (key === parentGroup(key)) fit(g, 1, prior);
  for (const [key, g] of Object.entries(groups)) if (key !== parentGroup(key)) fit(g, groups[parentGroup(key)].k, sidePrior);
  return groups;
}

// A leg's chance after keeping only k of its edge, and its grade (never raised).
export function shrinkLeg(prob, odds, grade, k) {
  if (!(k < 0.999)) return { prob, grade };
  const imp = impliedProb(odds ?? -110);
  const p = imp + k * (prob - imp);
  return { prob: p, grade: GRADE_ORDER.includes(grade) && grade !== "PASS" ? worse(grade, gradeFromEdge(p - imp)) : grade };
}

// Top picks: graded legs with real edge, one per player, at most two per game.
export function choosePicks(legs, max = 15, minEdge = 0.02) {
  const out = [];
  const cands = legs.filter((l) => l.lean && GRADE_WEIGHT[l.grade] && l.edge > minEdge && !l.mismatch && usableLeg(l)).sort((a, b) => pickScore(b) - pickScore(a));
  for (const l of cands) {
    if (out.filter((p) => p.gameKey === l.gameKey).length >= 2) continue;
    if (l.playerId && out.some((p) => p.playerId === l.playerId)) continue;
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}
