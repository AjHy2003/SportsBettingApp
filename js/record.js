// Pick history helpers shared by the Track record card (Today) and the Pick history page.
import { leagueById } from "./sports.js";
import * as M from "./model.js";

export const LONGSHOT = 150;
const leagueName = (id) => leagueById(id)?.name || id;

// A logged pick's bet type; kinds the app no longer posts are marked `gone`.
export function betType(p) {
  if (p.kind === "ml" && (p.odds ?? 0) >= LONGSHOT) return { key: "longshot", name: "Long-shot moneylines (+150 and up)", gone: "not posted now" };
  if (p.kind === "prop" && (p.league === "nfl" || p.league === "ncaaf")) return { key: "nflprops", name: "NFL props", gone: "not posted now" };
  if (p.kind === "prop") return { key: "prop", name: `${leagueName(p.league)} props`, gone: "" };
  if (p.kind === "ml") return { key: "ml", name: "Moneylines (under +150)", gone: "" };
  return { key: "lines", name: "Spreads & totals", gone: "" };
}

// The Pick history page link for a bet type row: props are per league.
export const typeHref = (p) => {
  const t = betType(p);
  return t.key === "prop" ? `#/record?type=prop&sport=${encodeURIComponent(p.league)}` : `#/record?type=${t.key}`;
};

// Did the line move toward the pick after it was posted?
export const clvBeat = (p) => (p.clv && (p.clv.pts !== 0 || Math.abs(p.clv.prob) >= 0.005) ? p.clv.pts > 0 || (p.clv.pts === 0 && p.clv.prob > 0) : null);

// Was this pick a ⭐ best bet (grade A, 10%+ edge, not an unpriced football prop)?
export const wasBest = (p) => !!p.best || (p.grade === "A" && (p.edge ?? 0) >= 0.1 && !(p.kind === "prop" && (p.league === "nfl" || p.league === "ncaaf")));

// Record, units, hit rate vs what the prices needed, and line movement, for a set of picks.
export function summarize(rows) {
  const s = { w: 0, l: 0, p: 0, v: 0, pending: 0, units: 0, be: 0, model: 0, clvN: 0, clvBeat: 0 };
  for (const x of rows) {
    if (x.result === "W") { s.w++; s.units += M.payout(x.odds ?? -110); }
    else if (x.result === "L") { s.l++; s.units -= 1; }
    else if (x.result === "P") s.p++;
    else if (x.result === "VOID") s.v++;
    else s.pending++;
    if (x.result === "W" || x.result === "L") { s.be += M.impliedProb(x.odds ?? -110); s.model += x.prob ?? 0; }
    const c = clvBeat(x);
    if (c != null) { s.clvN++; if (c) s.clvBeat++; }
  }
  const n = s.w + s.l;
  return { ...s, n, hit: n ? s.w / n : null, need: n ? s.be / n : null, modelAvg: n ? s.model / n : null };
}
