// Game-line model (spread / total / moneyline) shared by the game page and the
// daily picks generator. No DOM access.
import { scheduleResults, pickcenterOdds } from "./espn.js";
import * as M from "./model.js";
import { weatherEffect } from "./weather.js";

// Games of shrinkage toward league average for team scoring rates.
export const TEAM_REGRESS = { basketball: 8, football: 3, baseball: 20, hockey: 10, soccer: 6 };
export const DEFAULT_AVG = { nba: 114, wnba: 82, ncaab: 72, ncaaw: 66, nfl: 22.5, ncaaf: 28, mlb: 4.4, nhl: 3.05 };

export const fmtSpread = (s) => (s == null || !isFinite(s) ? "" : s > 0 ? `+${s}` : `${s}`);

function avgFromResults(a, b) {
  const all = [...a, ...b];
  return all.length ? M.mean(all.map((g) => g.pf)) : null;
}

// Blend season (shrunk to league average) with last-5 form.
export function teamRating(stand, res, lg, k) {
  const gp = stand?.gp || res.length;
  const pfS = stand?.pf ?? (res.length ? M.mean(res.map((g) => g.pf)) : lg);
  const paS = stand?.pa ?? (res.length ? M.mean(res.map((g) => g.pa)) : lg);
  const shrink = (v) => (gp * v + k * lg) / (gp + k);
  const last5 = res.slice(0, 5);
  const pf5 = last5.length ? M.mean(last5.map((g) => g.pf)) : NaN;
  const pa5 = last5.length ? M.mean(last5.map((g) => g.pa)) : NaN;
  const blend = (s, r) => (last5.length >= 3 ? 0.7 * shrink(s) + 0.3 * shrink(r) : shrink(s));
  return {
    pfSeason: pfS, paSeason: paS, pf5, pa5,
    margin: res.length ? M.mean(res.slice(0, 10).map((g) => g.pf - g.pa)) : NaN,
    pf: blend(pfS, pf5), pa: blend(paS, pa5),
  };
}

// Everything the line model needs from a game summary + standings + both schedules.
export function gameContext(L, sum, standings, schedH, schedA, weather = null) {
  const comp = sum.header?.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors.find((c) => c.homeAway === "home");
  const away = comp.competitors.find((c) => c.homeAway === "away");
  const fam = L.markets;
  const before = (g) => new Date(g.date) < new Date(comp.date);
  const resH = schedH ? scheduleResults(schedH, home.team.id).filter(before) : [];
  const resA = schedA ? scheduleResults(schedA, away.team.id).filter(before) : [];
  // Pre-game box score carries season per-game stats for some leagues (NFL).
  const boxStand = (team, res) => {
    const t = (sum.boxscore?.teams || []).find((x) => String(x.team?.id) === String(team.id));
    const val = (n) => parseFloat(t?.statistics?.find((x) => x.name === n)?.displayValue);
    const pf = val("totalPointsPerGame"), pa = val("totalPointsPerGameAllowed");
    const rec = comp.competitors.find((c) => String(c.team.id) === String(team.id))?.record?.[0]?.summary;
    const gp = rec ? rec.split("-").reduce((s, x) => s + (Number(x) || 0), 0) : res.length;
    return isFinite(pf) && isFinite(pa) && gp ? { pf, pa, gp } : null;
  };
  // Standings can disagree with the actual results (college standings count conference
  // games only): with 3+ results, trust the results when they're more than 30% apart.
  const checked = (stand, res) => {
    if (res.length < 3) return stand;
    const pf = M.mean(res.map((g) => g.pf)), pa = M.mean(res.map((g) => g.pa));
    return stand?.pf && Math.abs(stand.pf / pf - 1) <= 0.3 && Math.abs(stand.pa / pa - 1) <= 0.3 ? stand : { pf, pa, gp: res.length };
  };
  const standH = checked(standings?.teams?.[home.team.id] || boxStand(home.team, resH), resH);
  const standA = checked(standings?.teams?.[away.team.id] || boxStand(away.team, resA), resA);
  const defAvg = DEFAULT_AVG[L.id];
  const stLg = standings?.leagueAvg && (!defAvg || Math.abs(standings.leagueAvg / defAvg - 1) <= 0.3) ? standings.leagueAvg : null;
  const lg = stLg || defAvg || avgFromResults(resH, resA) || 1;
  const k = TEAM_REGRESS[fam] || 8;
  const minGames = Math.min(standH?.gp ?? resH.length, standA?.gp ?? resA.length);
  const league = L.espn.split("/")[1];
  return {
    comp, home, away, H: home.team, A: away.team, status: comp.status?.type || {}, fam,
    resH, resA, standH, standA, lg,
    rH: teamRating(standH, resH, lg, k), rA: teamRating(standA, resA, lg, k),
    minGames,
    // Weight on our model vs the no-vig market: game lines are sharp, so the model only nudges.
    wModel: minGames >= 4 ? 0.35 : 0.2,
    lineCap: league.includes("college") ? 0.15 : 0.25,
    weather, wx: weatherEffect(weather),
    params: M.gameParams(league, fam === "soccer" ? "soccer" : league),
    odds: pickcenterOdds(sum.pickcenter?.[0]) || {},
  };
}

export function defaultLines(odds) {
  return {
    spreadHome: odds.spreadHome, spreadHomeOdds: odds.spreadHomeOdds ?? -110, spreadAwayOdds: odds.spreadAwayOdds ?? -110,
    total: odds.total, overOdds: odds.overOdds ?? -110, underOdds: odds.underOdds ?? -110,
    mlHome: odds.mlHome, mlAway: odds.mlAway, draw: odds.draw,
  };
}

// Evaluate spread / total / moneyline at the given lines.
// Returns { g, rows: [{ key, label, v, info, sides: [{label, prob, odds, side}] }] }.
export function evaluateLines(gc, st) {
  const { rH, rA, lg, params, wModel, minGames, H, A, fam } = gc;
  // Wind/rain/snow scale both teams' scoring.
  const wx = gc.wx?.significant ? gc.wx.total : 1;
  const g = M.analyzeGame({ pf: rH.pf * wx, pa: rH.pa }, { pf: rA.pf * wx, pa: rA.pa }, lg, params, { spreadHome: st.spreadHome, total: st.total });
  const pct = (p) => `${Math.round(p * 100)}%`;
  const rows = [];
  // Two-way market: model prob for side A (pushes excluded), anchored to the book.
  const twoWay = (pA, pB, push, oA, oB, labels) => {
    oA = oA ?? -110; oB = oB ?? -110;
    const dec = pA / (pA + pB);
    const fin = M.anchor(dec, oA, oB, wModel);
    const a = fin * (1 - push), b = (1 - fin) * (1 - push);
    const v = guardLine(M.makeVerdict(a, b, push, oA, oB, M.expectedValue(a, push, oA), M.expectedValue(b, push, oB), minGames, labels), dec, M.noVig(oA, oB)?.a, gc.lineCap);
    return { v, model: dec, fin, push, sides: [{ label: labels[0], prob: fin, odds: oA, side: "A" }, { label: labels[1], prob: 1 - fin, odds: oB, side: "B" }] };
  };
  if (g.spread && st.spreadHome != null) {
    const r = twoWay(g.spread.home, g.spread.away, g.spread.push, st.spreadHomeOdds, st.spreadAwayOdds, [`${H.abbreviation} ${fmtSpread(st.spreadHome)}`, `${A.abbreviation} ${fmtSpread(-st.spreadHome)}`]);
    rows.push({ key: "spread", label: "Spread", ...r, info: `${H.abbreviation} covers: model ${pct(r.model)} → blended ${pct(r.fin)}`, line: st.spreadHome });
  }
  if (g.totalP && st.total != null) {
    const r = twoWay(g.totalP.over, g.totalP.under, g.totalP.push, st.overOdds, st.underOdds, [`Over ${st.total}`, `Under ${st.total}`]);
    rows.push({ key: "total", label: "Total", ...r, info: `Over: model ${pct(r.model)}${wx < 1 ? ` (weather: ${gc.wx.why}, scoring ×${wx.toFixed(2)})` : ""} → blended ${pct(r.fin)}`, line: st.total });
  }
  if (fam === "soccer" && st.mlHome != null && st.mlAway != null) {
    let opts = [[`${H.abbreviation} win`, g.pHome, st.mlHome], ["Draw", g.pDraw, st.draw], [`${A.abbreviation} win`, g.pAway, st.mlAway]].filter((o) => o[2] != null);
    if (opts.length === 3) {
      const imp = opts.map((o) => M.impliedProb(o[2]));
      const tot = imp.reduce((x, y) => x + y, 0);
      opts = opts.map((o, i) => [o[0], wModel * o[1] + (1 - wModel) * (imp[i] / tot), o[2]]);
    }
    const scored = opts.map(([lbl, p, o]) => ({ lbl, p, o, ev: M.expectedValue(p, 0, o), edge: p - M.impliedProb(o) }));
    const best = [...scored].sort((a, b) => b.ev - a.ev)[0];
    const grade = best.edge >= 0.08 ? "A" : best.edge >= 0.05 ? "B" : best.edge >= 0.025 ? "C" : "PASS";
    rows.push({ key: "1x2", label: "Result (1X2)", v: { side: grade === "PASS" ? null : best.lbl, lean: best.lbl, edge: best.edge, ev: best.ev, grade, prob: best.p },
      info: `${H.abbreviation} ${pct(g.pHome)} · Draw ${pct(g.pDraw)} · ${A.abbreviation} ${pct(g.pAway)}`, sides: scored.map((x) => ({ label: x.lbl, prob: x.p, odds: x.o })) });
  } else if (st.mlHome != null && st.mlAway != null) {
    const r = twoWay(g.pHome, g.pAway, 0, st.mlHome, st.mlAway, [`${H.abbreviation} ML`, `${A.abbreviation} ML`]);
    rows.push({ key: "ml", label: "Moneyline", ...r, info: `${H.abbreviation} wins: model ${pct(r.model)} → blended ${pct(r.fin)}` });
  }
  return { g, rows };
}

// Game lines are sharp: a team model 25+ points away from the market is far more
// likely missing something (injuries, bad inputs) than finding value.
// College ratings ignore strength of schedule, so they get a tighter leash.
export function guardLine(v, pModelA, marketA, capAt = 0.25) {
  if (!v || marketA == null || pModelA == null) return v;
  const gap = Math.abs(pModelA - marketA);
  if (gap >= 0.4 && v.grade !== "PASS") { v.grade = "PASS"; v.side = null; v.mismatch = true; }
  else if (gap >= capAt && (v.grade === "A" || v.grade === "B")) { v.grade = "C"; v.mismatch = true; }
  return v;
}

// Odds for the side a verdict picked.
export function sideOdds(row, sideLabel) {
  return row.sides?.find((s) => s.label === sideLabel)?.odds ?? -110;
}
