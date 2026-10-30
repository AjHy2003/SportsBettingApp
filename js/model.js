// Probability, projection and betting math. Sport-agnostic: every analyzer
// feeds plain arrays of numbers through these functions.

// ---------- odds ----------
export function impliedProb(odds) {
  const o = Number(odds);
  if (!o || !isFinite(o)) return null;
  return o < 0 ? -o / (-o + 100) : 100 / (o + 100);
}

export function toAmerican(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}

export function fmtOdds(o) {
  if (o == null || !isFinite(o)) return "—";
  return o > 0 ? `+${o}` : `${o}`;
}

// Profit per 1 unit staked.
export function payout(odds) {
  const o = Number(odds);
  return o < 0 ? 100 / -o : o / 100;
}

// Remove the bookmaker margin from a two-way market.
export function noVig(oddsA, oddsB) {
  const a = impliedProb(oddsA), b = impliedProb(oddsB);
  if (a == null || b == null) return null;
  return { a: a / (a + b), b: b / (a + b), hold: a + b - 1 };
}

// Expected value per 1 unit staked, with pushes refunded.
export function expectedValue(pWin, pPush, odds) {
  if (odds == null || pWin == null) return null;
  const pLose = 1 - pWin - (pPush || 0);
  return pWin * payout(odds) - pLose;
}

// ---------- descriptive stats ----------
export const sum = (a) => a.reduce((s, x) => s + x, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : NaN);

export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function variance(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return sum(a.map((x) => (x - m) ** 2)) / (a.length - 1);
}

export const stdev = (a) => Math.sqrt(variance(a));

// Exponentially weighted mean; values[0] is the most recent game.
export function ewma(values, halfLife = 8) {
  if (!values.length) return NaN;
  let num = 0, den = 0;
  values.forEach((v, i) => {
    const w = Math.pow(0.5, i / halfLife);
    num += w * v;
    den += w;
  });
  return num / den;
}

export function weights(n, halfLife = 8) {
  return Array.from({ length: n }, (_, i) => Math.pow(0.5, i / halfLife));
}

// ---------- distributions ----------
function erf(x) {
  // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

export const normCdf = (x, mu = 0, sd = 1) => 0.5 * (1 + erf((x - mu) / (sd * Math.SQRT2)));

function logGamma(z) {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

export function poissonPmf(k, lam) {
  if (k < 0) return 0;
  if (lam <= 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(lam) - lam - logGamma(k + 1));
}

// Negative binomial parameterised by mean and variance (variance > mean).
export function negBinPmf(k, m, v) {
  if (v <= m * 1.0001) return poissonPmf(k, m);
  const r = (m * m) / (v - m);
  const p = r / (r + m);
  return Math.exp(logGamma(k + r) - logGamma(r) - logGamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p));
}

// P(X > line), P(X = line), P(X < line) for an integer-valued stat.
export function discreteProbs(line, pmf, maxK) {
  let over = 0, push = 0, under = 0;
  const top = Math.max(maxK, Math.ceil(line) + 5);
  for (let k = 0; k <= top; k++) {
    const p = pmf(k);
    if (k > line) over += p;
    else if (k === line) push += p;
    else under += p;
  }
  const tot = over + push + under;
  return { over: over / tot, push: push / tot, under: under / tot };
}

// Normal approximation with a continuity correction for integer stats.
export function normalProbs(line, mu, sd, integer = true) {
  sd = Math.max(sd, 1e-6);
  if (!integer) {
    const under = normCdf(line, mu, sd);
    return { over: 1 - under, push: 0, under };
  }
  if (Number.isInteger(line)) {
    const lo = normCdf(line - 0.5, mu, sd), hi = normCdf(line + 0.5, mu, sd);
    return { over: 1 - hi, push: hi - lo, under: lo };
  }
  const cut = normCdf(Math.floor(line) + 0.5, mu, sd);
  return { over: 1 - cut, push: 0, under: cut };
}

export function distProbs(line, mu, variance, dist) {
  if (!(mu >= 0) || !isFinite(mu)) return null;
  if (dist === "poisson" || dist === "negbin") {
    const v = dist === "poisson" ? mu : Math.max(variance || mu, mu * 1.0001);
    const maxK = Math.ceil(mu + 10 * Math.sqrt(v) + 10);
    return discreteProbs(line, (k) => negBinPmf(k, mu, v), maxK);
  }
  const sd = Math.sqrt(variance > 0 ? variance : Math.max(mu, 1));
  return normalProbs(line, mu, sd, dist !== "continuous");
}

// ---------- hit rates ----------
export function hitRate(values, line) {
  let over = 0, under = 0, push = 0;
  for (const v of values) {
    if (v > line) over++;
    else if (v < line) under++;
    else push++;
  }
  const decided = over + under;
  return { n: values.length, over, under, push, pct: decided ? over / decided : NaN };
}

const clampP = (p) => Math.min(0.995, Math.max(0.005, p));
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// ---------- prop analysis ----------
// games: [{ value, minutes?, ... }] most recent first.
// opts: { line, oddsOver, oddsUnder, dist, oppFactor, paceFactor, roleAdj,
//         minutesOverride, perMinute, halfLife }
export function analyzeProp(games, opts) {
  const vals = games.map((g) => g.value).filter((v) => v != null && isFinite(v));
  const n = vals.length;
  const line = Number(opts.line);
  if (!n) return { n: 0 };

  const halfLife = opts.halfLife || 8;
  // Recency weights times any per-game multiplier (old team, last season).
  const gw = games.filter((g) => g.value != null && isFinite(g.value)).map((g, i) => Math.pow(0.5, i / halfLife) * (g.w ?? 1));
  const flat = games.filter((g) => g.value != null && isFinite(g.value)).map((g) => g.w ?? 1);
  const wavg = (ws) => sum(vals.map((v, i) => ws[i] * v)) / sum(ws);
  const avg = mean(vals);
  const longAvg = wavg(flat);
  const recent = wavg(gw);
  let base = n >= 5 ? 0.6 * recent + 0.4 * longAvg : longAvg;
  const notes = [];

  // Per-minute model when minutes are known (basketball, hockey).
  let expMinutes = null;
  if (opts.perMinute) {
    const withMin = games.filter((g) => g.minutes > 0 && g.value != null);
    if (withMin.length >= 3) {
      const w = withMin.map((g, i) => Math.pow(0.5, i / halfLife) * (g.w ?? 1));
      const rate = sum(withMin.map((g, i) => w[i] * g.value)) / sum(withMin.map((g, i) => w[i] * g.minutes));
      const minRecent = ewma(withMin.map((g) => g.minutes), 5);
      expMinutes = opts.minutesOverride > 0 ? Number(opts.minutesOverride) : minRecent * (opts.minutesFactor || 1);
      base = rate * expMinutes;
      if (opts.minutesOverride > 0) notes.push(`Using ${expMinutes} expected minutes (recent avg ${minRecent.toFixed(1)}).`);
    }
  }

  // Potential: what his chances (potential assists, rebound chances, shot attempts, NFL
  // expected stats) say he should have produced. Luck evens out, so lean the base toward it.
  let potential = null;
  const withX = games.filter((g) => g.value != null && isFinite(g.value) && g.expected != null && isFinite(g.expected));
  if (withX.length >= 3 && opts.potentialWeight) {
    const w = withX.map((g, i) => Math.pow(0.5, i / halfLife) * (g.w ?? 1));
    const act = sum(withX.map((g, i) => w[i] * g.value)) / sum(w);
    const exp = sum(withX.map((g, i) => w[i] * g.expected)) / sum(w);
    // Pseudo-count keeps small numbers (TDs, goals, threes) from swinging the ratio.
    const ratio = Math.min(1.33, Math.max(0.75, (exp + 0.5) / (act + 0.5)));
    const factor = 1 + opts.potentialWeight * (withX.length / (withX.length + 4)) * (ratio - 1);
    base *= factor;
    potential = { n: withX.length, actual: act, expected: exp, factor };
    if (Math.abs(factor - 1) >= 0.01) notes.push(`Potential: his chances say ${exp.toFixed(1)} per game vs ${act.toFixed(1)} actual (last ${withX.length}) → ×${factor.toFixed(3)}.`);
  }

  const opp = opts.oppFactor && isFinite(opts.oppFactor) ? opts.oppFactor : 1;
  const pace = opts.paceFactor && isFinite(opts.paceFactor) ? opts.paceFactor : 1;
  const role = 1 + (Number(opts.roleAdj) || 0) / 100;
  const ctx = opts.contextFactor && isFinite(opts.contextFactor) ? opts.contextFactor : 1;
  const projection = base * opp * pace * role * ctx;
  if (opp !== 1) notes.push(`Opponent adjustment ×${opp.toFixed(3)}.`);
  for (const n of opts.contextNotes || []) notes.push(`${n}.`);
  if (pace !== 1) notes.push(`Pace adjustment ×${pace.toFixed(3)}.`);
  if (role !== 1) notes.push(`Role / injury adjustment ${opts.roleAdj > 0 ? "+" : ""}${opts.roleAdj}%.`);

  // Keep the player's coefficient of variation, scaled to the projection.
  const v = n >= 3 ? variance(vals) : avg;
  const scaledVar = avg > 0 ? v * (projection / avg) ** 2 : v;
  const dist = opts.dist || "normal";
  let model = isFinite(line) ? distProbs(line, projection, scaledVar, dist) : null;

  // Recency-weighted empirical hit rate with a uniform prior.
  let emp = null;
  if (isFinite(line)) {
    const w = gw;
    let o = 0, u = 0;
    vals.forEach((x, i) => {
      if (x > line) o += w[i];
      else if (x < line) u += w[i];
    });
    emp = (o + 1) / (o + u + 2);
  }

  const hasOver = opts.oddsOver != null && opts.oddsOver !== "";
  const hasUnder = opts.oddsUnder != null && opts.oddsUnder !== "";
  const oddsOver = hasOver ? Number(opts.oddsOver) : -110;
  const oddsUnder = hasUnder ? Number(opts.oddsUnder) : -110;
  const fair = noVig(oddsOver, oddsUnder);

  let pOver = null, pUnder = null, pPush = 0, statsOver = null, marketWeight = 0;
  if (model) {
    const wModel = n >= 8 ? 0.65 : 0.8;
    const decided = model.over + model.under;
    const mOver = decided > 0 ? model.over / decided : 0.5;
    statsOver = wModel * mOver + (1 - wModel) * emp;
    // Anchor to the market: the book knows things the box score doesn't
    // (injuries, role changes). Use the no-vig price when both sides are priced,
    // or the caller's marketProb (a posted main line is roughly a 50/50 market).
    let final = statsOver;
    const mkt = hasOver && hasUnder && fair ? fair.a : opts.marketProb ?? null;
    if (mkt != null) {
      marketWeight = opts.marketWeight ?? (n >= 10 ? 0.5 : 0.6);
      final = (1 - marketWeight) * statsOver + marketWeight * mkt;
    }
    var marketProb = mkt;
    var finalOver = mkt != null ? final : null;
    pPush = model.push;
    pOver = final * (1 - pPush);
    pUnder = (1 - final) * (1 - pPush);
  }

  const evOver = expectedValue(pOver, pPush, oddsOver);
  const evUnder = expectedValue(pUnder, pPush, oddsUnder);
  const verdict = makeVerdict(pOver, pUnder, pPush, oddsOver, oddsUnder, evOver, evUnder, n);
  // Without any market price to anchor to, a stats-only model doesn't earn an A.
  if (marketWeight === 0 && verdict.grade === "A") { verdict.grade = "B"; verdict.capped = true; }
  // A line far from recent production usually means the book knows about a role
  // change (injury, new starter, minutes). Don't call that an edge.
  const sdProj = Math.sqrt(Math.max(scaledVar, 0.25));
  const mismatch = isFinite(line) ? Math.abs(projection - line) / sdProj : 0;
  if (mismatch >= 1.5 && verdict.grade !== "PASS") { verdict.grade = "PASS"; verdict.side = null; verdict.mismatch = true; }
  else if (mismatch >= 1.0 && (verdict.grade === "A" || verdict.grade === "B")) { verdict.grade = "C"; verdict.mismatch = true; }
  // Same idea in probability terms: stats saying 80%+ where the book says 50% is
  // almost always missing information, not a gift.
  const gap = marketProb != null && statsOver != null ? Math.abs(statsOver - marketProb) : 0;
  // And in plain numbers: a line twice (or half) the projection, or outside everything
  // the player did in the last 5 games, is the book pricing a new role.
  const lo = Math.min(projection, line), hi = Math.max(projection, line);
  const ratio = isFinite(line) && line >= 2.5 && lo > 0 ? hi / lo : 1;
  const last5 = vals.slice(0, 5);
  const outside = isFinite(line) && line >= 2.5 && last5.length === 5 &&
    ((verdict.lean === "UNDER" && line > Math.max(...last5)) || (verdict.lean === "OVER" && line < Math.min(...last5)));
  if ((gap >= 0.4 || ratio >= 2) && verdict.grade !== "PASS") { verdict.grade = "PASS"; verdict.side = null; verdict.mismatch = true; }
  else if ((gap >= 0.3 || ratio >= 1.6 || outside) && (verdict.grade === "A" || verdict.grade === "B")) { verdict.grade = "C"; verdict.mismatch = true; }

  // Alt-line ladder: the same distribution and hit-rate blend at any line, shifted
  // in log-odds so the posted line keeps its market-anchored probability.
  // The hit-rate part leans on the model's own probability (not 50/50) so the tails
  // aren't propped up when no past game got there.
  const wStats = n >= 8 ? 0.65 : 0.8;
  const statsAt = (x) => {
    const mdl = distProbs(x, projection, scaledVar, dist);
    if (!mdl) return null;
    let o = 0, u = 0;
    vals.forEach((v, i) => { if (v > x) o += gw[i]; else if (v < x) u += gw[i]; });
    const dec = mdl.over + mdl.under;
    const pm = dec > 0 ? mdl.over / dec : 0.5;
    return { st: wStats * pm + (1 - wStats) * ((o + 2 * pm) / (o + u + 2)), push: mdl.push };
  };
  let shift = null;
  const probOver = (x) => {
    const s = statsAt(x);
    if (!s) return null;
    if (shift == null) {
      const atLine = typeof finalOver === "number" && isFinite(line) ? statsAt(line) : null;
      shift = atLine ? logit(clampP(finalOver)) - logit(clampP(atLine.st)) : 0;
    }
    const p = sigmoid(logit(clampP(s.st)) + shift);
    return { over: p * (1 - s.push), under: (1 - p) * (1 - s.push), push: s.push };
  };

  return {
    probOver, potential,
    n, avg, median: median(vals), sd: n >= 2 ? stdev(vals) : NaN,
    min: Math.min(...vals), max: Math.max(...vals),
    recent, projection, expMinutes, dist,
    pOver, pUnder, pPush, empirical: emp, statsOver, marketWeight, marketProb: typeof marketProb === "undefined" ? null : marketProb,
    mismatch: isFinite(line) ? Math.abs(projection - line) / Math.sqrt(Math.max(scaledVar, 0.25)) : 0,
    fairOver: toAmerican(pOver != null ? pOver / (1 - pPush) : null),
    fairUnder: toAmerican(pUnder != null ? pUnder / (1 - pPush) : null),
    oddsOver, oddsUnder, bookFair: fair, evOver, evUnder, verdict, notes,
  };
}

export function makeVerdict(pA, pB, pPush, oddsA, oddsB, evA, evB, n, labels = ["OVER", "UNDER"]) {
  if (pA == null) return { side: null, grade: "—", text: "Enter a line" };
  const decidedA = pA / (1 - (pPush || 0));
  const beA = impliedProb(oddsA), beB = impliedProb(oddsB);
  const edgeA = decidedA - beA, edgeB = 1 - decidedA - beB;
  const pickA = (evA ?? -1) >= (evB ?? -1);
  const edge = pickA ? edgeA : edgeB;
  const ev = pickA ? evA : evB;
  let grade = "PASS";
  if (edge >= 0.08) grade = "A";
  else if (edge >= 0.05) grade = "B";
  else if (edge >= 0.025) grade = "C";
  if (n != null && n < 5 && grade !== "PASS") grade = "C";
  return {
    side: grade === "PASS" ? null : pickA ? labels[0] : labels[1],
    lean: pickA ? labels[0] : labels[1],
    edge, ev, grade,
    prob: pickA ? decidedA : 1 - decidedA,
  };
}

// ---------- game (team) model ----------
// Sport parameters: home advantage in points/goals, spread of margin & total.
export const GAME_PARAMS = {
  nba: { hfa: 2.4, sdMargin: 12.5, sdTotal: 18, kind: "normal" },
  wnba: { hfa: 2.0, sdMargin: 11, sdTotal: 15, kind: "normal" },
  "mens-college-basketball": { hfa: 3.2, sdMargin: 11, sdTotal: 15, kind: "normal" },
  "womens-college-basketball": { hfa: 3.2, sdMargin: 12, sdTotal: 15, kind: "normal" },
  nfl: { hfa: 1.7, sdMargin: 13.5, sdTotal: 13.5, kind: "normal" },
  "college-football": { hfa: 2.8, sdMargin: 16, sdTotal: 16, kind: "normal" },
  mlb: { hfa: 0.12, kind: "poisson", ot: true },
  nhl: { hfa: 0.15, kind: "poisson", ot: true },
  soccer: { hfa: 0.28, kind: "poisson", draws: true },
};

export function gameParams(league, sport) {
  return GAME_PARAMS[league] || (sport === "soccer" ? GAME_PARAMS.soccer : GAME_PARAMS[sport]) || { hfa: 0, sdMargin: 12, sdTotal: 15, kind: "normal" };
}

// Score distribution matrix for two independent Poisson scorers.
function poissonGrid(la, lb, maxGoals) {
  const pa = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(k, la));
  const pb = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(k, lb));
  return { pa, pb };
}

// home/away: { pf, pa } points for/against per game (blended), league: league avg points per team per game.
// lines: { spreadHome, total, mlHome, mlAway, draw }
export function analyzeGame(home, away, leagueAvg, params, lines = {}) {
  const hfa = params.hfa || 0;
  const projHome = (home.pf * away.pa) / leagueAvg + hfa / 2;
  const projAway = (away.pf * home.pa) / leagueAvg - hfa / 2;
  const margin = projHome - projAway;
  const total = projHome + projAway;
  const out = { projHome, projAway, margin, total };

  if (params.kind === "poisson") {
    const maxG = Math.max(20, Math.ceil(total * 3));
    const { pa, pb } = poissonGrid(Math.max(projHome, 0.05), Math.max(projAway, 0.05), maxG);
    let win = 0, tie = 0, loss = 0;
    const marginP = new Map(), totalP = new Map();
    for (let i = 0; i <= maxG; i++) for (let j = 0; j <= maxG; j++) {
      const p = pa[i] * pb[j];
      if (i > j) win += p; else if (i === j) tie += p; else loss += p;
      marginP.set(i - j, (marginP.get(i - j) || 0) + p);
      totalP.set(i + j, (totalP.get(i + j) || 0) + p);
    }
    out.pHomeReg = win; out.pDraw = tie; out.pAwayReg = loss;
    if (params.ot) {
      // Ties go to extra time / innings, split by relative strength.
      const share = projHome / (projHome + projAway);
      out.pHome = win + tie * share;
      out.pAway = loss + tie * (1 - share);
    } else {
      out.pHome = win; out.pAway = loss;
    }
    if (lines.spreadHome != null && isFinite(lines.spreadHome)) {
      let c = 0, p = 0, l = 0;
      for (const [m, pr] of marginP) {
        const adj = m + lines.spreadHome;
        if (adj > 0) c += pr; else if (adj === 0) p += pr; else l += pr;
      }
      out.spread = { home: c, push: p, away: l };
    }
    if (lines.total != null && isFinite(lines.total)) {
      let o = 0, p = 0, u = 0;
      for (const [t, pr] of totalP) {
        if (t > lines.total) o += pr; else if (t === lines.total) p += pr; else u += pr;
      }
      out.totalP = { over: o, push: p, under: u };
    }
  } else {
    const sdM = params.sdMargin, sdT = params.sdTotal;
    out.pHome = 1 - normCdf(0, margin, sdM);
    out.pAway = 1 - out.pHome;
    if (lines.spreadHome != null && isFinite(lines.spreadHome)) {
      // Home covers when margin + spreadHome > 0.
      const pr = normalProbs(-lines.spreadHome, margin, sdM, true);
      out.spread = { home: pr.over, push: pr.push, away: pr.under };
    }
    if (lines.total != null && isFinite(lines.total)) {
      const pr = normalProbs(lines.total, total, sdT, true);
      out.totalP = { over: pr.over, push: pr.push, under: pr.under };
    }
  }
  return out;
}

// Blend a model probability with the no-vig market probability.
export function anchor(pModel, oddsA, oddsB, wModel) {
  const nv = noVig(oddsA, oddsB);
  if (!nv || pModel == null) return pModel;
  return wModel * pModel + (1 - wModel) * nv.a;
}

// ---------- finishing-position markets (racing, golf) ----------
// finishes: [{ pos, field }] most recent first. Returns P(finish <= n).
export function topNProb(finishes, n, halfLife = 6, priorRate = null) {
  if (!finishes.length) return null;
  const w = weights(finishes.length, halfLife);
  let hit = 0, tot = 0;
  finishes.forEach((f, i) => {
    if (f.pos == null) return;
    tot += w[i];
    if (f.pos <= n) hit += w[i];
  });
  const field = mean(finishes.map((f) => f.field).filter(Boolean)) || 30;
  const prior = priorRate ?? Math.min(n / field, 0.95);
  const k = 3; // prior strength in "events"
  return (hit + k * prior) / (tot + k);
}

// Head-to-head: share of shared events where A finished ahead of B, shrunk to 50%.
export function headToHead(aFinishes, bFinishes, halfLife = 8) {
  const bByEvent = new Map(bFinishes.map((f) => [f.event, f]));
  const shared = aFinishes.filter((f) => bByEvent.has(f.event) && f.pos != null && bByEvent.get(f.event).pos != null);
  const w = weights(shared.length, halfLife);
  let a = 0, tot = 0;
  shared.forEach((f, i) => {
    tot += w[i];
    if (f.pos < bByEvent.get(f.event).pos) a += w[i];
  });
  return { shared: shared.length, pA: (a + 2) / (tot + 4), aAhead: shared.filter((f) => f.pos < bByEvent.get(f.event).pos).length };
}
