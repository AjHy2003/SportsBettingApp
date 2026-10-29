// Moonshots: the long-shot parlay with the best model chance of paying at least
// `target` on `stake`. A knapsack over games: each leg adds log-odds (payout) and
// costs log-probability; find the cheapest set that reaches the payout. One leg per
// game by default (keeps legs close to independent); optionally two compatible legs.
// No DOM; the daily picks job uses it too.
import { decimalOdds, combine, compatible } from "./parlay.js";
import { impliedProb } from "./model.js";

export const MOONSHOT_LIMITS = { maxLegs: 15 };

// Big model edges are usually overstated, and a parlay multiplies the error, so each
// leg keeps only `keepEdge` of its edge over the (de-vigged) market price.
export function moonProb(l, keepEdge = 0.5) {
  const q = impliedProb(l.odds) / 1.045;
  return Math.min(0.97, Math.max(0.003, q + keepEdge * (l.prob - q)));
}

export function buildMoonshot(pool, { stake = 10, target = 10000, maxLegs = 12, perGame = 1, exclude = [], keepEdge = 0.5 } = {}) {
  const need = Math.log(target / stake + 1);
  // Work on copies carrying the shrunk probability; hand back the original legs.
  const legs = pool.filter((l) => l.prob > 0 && l.prob < 1 && l.odds != null && !exclude.includes(l.id))
    .map((l) => ({ ...l, prob: moonProb(l, keepEdge), orig: l }))
    .map((l) => ({ l, g: Math.log(decimalOdds(l.odds)), c: -Math.log(l.prob) }))
    .filter((x) => x.g > 0.05);
  if (!legs.length) return null;

  // Options per game: single legs, plus compatible pairs when perGame = 2.
  const byGame = new Map();
  for (const x of legs) {
    if (!byGame.has(x.l.gameKey)) byGame.set(x.l.gameKey, []);
    byGame.get(x.l.gameKey).push(x);
  }
  const groups = [...byGame.values()].map((xs) => {
    // Keep each game's 12 most efficient legs (payout per unit of probability spent).
    const top = xs.sort((a, b) => b.g / b.c - a.g / a.c).slice(0, 12);
    const opts = top.map((x) => ({ legs: [x.l], g: x.g, c: x.c }));
    if (perGame >= 2) {
      for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
        if (compatible(top[i].l, top[j].l, true)) opts.push({ legs: [top[i].l, top[j].l], g: top[i].g + top[j].g, c: top[i].c + top[j].c });
      }
    }
    return opts;
  });

  const B = 400, step = need / B;
  const K = Math.min(maxLegs, MOONSHOT_LIMITS.maxLegs);
  const NEG = -Infinity;
  let dp = Array.from({ length: K + 1 }, () => new Float64Array(B + 1).fill(NEG));
  dp[0][0] = 0;
  const back = []; // per group: Int32Array[(k)*(B+1)+bin] -> option index + 1 (0 = skipped)
  const from = [];
  for (const opts of groups) {
    const nd = dp.map((row) => Float64Array.from(row));
    const choice = new Int32Array((K + 1) * (B + 1));
    const prevBin = new Int32Array((K + 1) * (B + 1));
    opts.forEach((o, oi) => {
      const n = o.legs.length, gb = Math.floor(o.g / step);
      for (let k = K - n; k >= 0; k--) {
        const row = dp[k];
        for (let b = 0; b <= B; b++) {
          if (row[b] === NEG) continue;
          const nb = Math.min(B, b + gb), v = row[b] - o.c;
          if (v > nd[k + n][nb]) { nd[k + n][nb] = v; choice[(k + n) * (B + 1) + nb] = oi + 1; prevBin[(k + n) * (B + 1) + nb] = b; }
        }
      }
    });
    back.push(choice);
    from.push(prevBin);
    dp = nd;
  }

  // Walk back through the groups from one final state.
  const walk = (k, b) => {
    const picked = [];
    for (let gi = groups.length - 1; gi >= 0 && k > 0; gi--) {
      const idx = k * (B + 1) + b;
      const oi = back[gi][idx];
      if (oi > 0) {
        const o = groups[gi][oi - 1];
        picked.push(...o.legs);
        b = from[gi][idx];
        k -= o.legs.length;
      }
    }
    return picked;
  };
  const needDec = target / stake + 1;
  // Payouts are rounded down per leg, so also check states just short of the target
  // with exact odds; keep the most likely set that truly pays the target.
  let best = null;
  for (let k = 1; k <= K; k++) {
    for (let b = B; b >= Math.max(0, B - K - 1); b--) {
      if (dp[k][b] === NEG || (best && dp[k][b] <= Math.log(best.prob))) continue;
      const legsK = walk(k, b);
      if (!legsK.length) continue;
      const c = combine(legsK);
      if (c.decimal >= needDec - 1e-9 && (!best || c.prob > best.prob)) best = { legs: legsK, ...c };
    }
  }
  let reached = !!best;
  if (!best) {
    // Can't reach the target with these legs: the biggest payout available.
    for (let b = B; b >= 0 && !best; b--) {
      let bk = null;
      for (let k = 1; k <= K; k++) if (dp[k][b] > NEG && (!bk || dp[k][b] > dp[bk][b])) bk = k;
      if (bk) { const legsK = walk(bk, b); if (legsK.length) best = { legs: legsK, ...combine(legsK) }; }
    }
  }
  if (!best) return null;
  if (reached) best = polish(best.legs, legs.map((x) => x.l), needDec, perGame, K);
  const raw = best.legs.reduce((p, l) => p * l.orig.prob, 1);
  return { ...best, legs: best.legs.map((l) => l.orig), rawProb: raw, stake, target, reached, payout: stake * (best.decimal - 1) };
}

// Local search after the knapsack: swap one leg for another (or drop one) whenever
// the ticket still pays the target and the model chance goes up.
function polish(sol, pool, needDec, perGame, K) {
  const fits = (set, x) => {
    const same = set.filter((y) => y.gameKey === x.gameKey);
    return same.length < perGame && set.every((y) => compatible(y, x, y.gameKey === x.gameKey));
  };
  let cur = { legs: sol, ...combine(sol) };
  for (let iter = 0; iter < 20; iter++) {
    let better = null;
    for (let i = 0; i < cur.legs.length; i++) {
      const rest = cur.legs.filter((_, j) => j !== i);
      const drop = combine(rest);
      if (rest.length && drop.decimal >= needDec && drop.prob > (better || cur).prob) better = { legs: rest, ...drop };
      for (const x of pool) {
        if (cur.legs.includes(x) || !fits(rest, x)) continue;
        const c = combine([...rest, x]);
        if (c.decimal >= needDec && c.prob > (better || cur).prob) better = { legs: [...rest, x], ...c };
      }
    }
    if (!better) break;
    cur = better;
  }
  return cur.legs.length <= K ? cur : { legs: sol, ...combine(sol) };
}

export const oneIn = (p) => (p > 0 ? Math.round(1 / p).toLocaleString("en-US") : "∞");
