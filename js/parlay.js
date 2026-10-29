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
export function bestParlay(legs, n, { sgp = false, minEdge = 0, exclude = [] } = {}) {
  const pool = legs
    .filter((l) => l.prob > 0 && l.edge >= minEdge && !exclude.includes(l.id))
    .sort((a, b) => b.edge - a.edge || b.prob - a.prob);
  const pick = [];
  for (const l of pool) {
    if (pick.every((p) => compatible(p, l, sgp))) pick.push(l);
    if (pick.length === n) break;
  }
  return pick.length === n ? { legs: pick, ...combine(pick) } : null;
}

// Best n-leg same-game parlay for one game.
export function bestSameGame(legs, gameKey, n) {
  return bestParlay(legs.filter((l) => l.gameKey === gameKey && !l.mismatch && usableLeg(l)), n, { sgp: true, minEdge: -0.02 });
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
export function planTicket(legs, budget, mode = "mix", nLegs = 3, { sgpGameKey = null } = {}) {
  budget = Math.max(1, Number(budget) || 10);
  const good = legs.filter((l) => l.edge > 0 && l.prob > 0 && !l.mismatch && usableLeg(l) && GRADE_WEIGHT[l.grade]);
  let bets = [];
  const parlayOf = (n) => (sgpGameKey ? bestSameGame(legs, sgpGameKey, n) : bestParlay(good, n));
  if (mode === "parlay" || sgpGameKey) {
    const p = parlayOf(nLegs);
    if (p) bets = [{ type: sgpGameKey ? "sgp" : "parlay", stake: budget, ...p }];
  } else if (mode === "singles") {
    bets = singles(good, budget, SINGLES_COUNT(budget));
  } else {
    // Mix: ~70% on straight bets, ~30% on one parlay.
    const p = budget >= 4 ? bestParlay(good, nLegs) : null;
    const parlayStake = p ? roundStake(budget * 0.3) : 0;
    bets = singles(good, budget - parlayStake, Math.max(1, SINGLES_COUNT(budget) - 1));
    if (p) bets.push({ type: "parlay", stake: parlayStake, ...p });
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

// Books post TD/INT-style lines (under 2.5) at lopsided prices, so a missing price
// can't be assumed to be -110 there.
export const usableLeg = (l) => (l.priced !== false || l.kind !== "prop" || l.line >= 2.5) && !l.questionable;

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
