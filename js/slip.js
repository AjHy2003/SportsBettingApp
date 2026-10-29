// Shareable bet slips: a whole ticket packed into a link (#/slip?s=...) that anyone can
// open to see the legs, add them to their sportsbook's slip, or save it as their own.
import { legOf } from "./live.js";

// A leg in the saved-pick shape (store.js), which the live tracker reads, keeping its
// label and sportsbook links so it can be shared or placed again later.
export function toPick(l) {
  if (l.athlete || l.marketLabel || l.game) return l; // already saved-pick shaped
  const keep = { label: l.label, matchup: l.matchup, ref: l.id, dk: l.dk, dkExact: l.dkExact, bookLinks: l.bookLinks };
  if (l.kind === "prop") return { league: l.league, athleteId: l.playerId, athlete: l.player, market: l.marketKey, marketLabel: l.market, line: l.line, side: l.side, odds: l.odds, prob: l.prob, grade: l.grade, eventId: l.eventId, eventDate: l.start, opp: l.matchup, ...keep };
  const [awayAbbr, homeAbbr] = String(l.matchup || "").split(" @ ");
  return { league: l.league, eventId: l.eventId, eventDate: l.start, athlete: l.matchup, marketLabel: l.market, market: l.kind, game: true, homeAbbr, awayAbbr,
    side: l.kind === "total" ? (l.side === "OVER" ? `Over ${l.line}` : `Under ${l.line}`) : l.label, line: l.kind === "spread" ? (l.side === "HOME" ? l.line : -l.line) : l.line, odds: l.odds, prob: l.prob, grade: l.grade, ...keep };
}

// What a shared leg carries: the trackable pick plus how to show and place it.
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""));
function packLeg(l) {
  const p = toPick(l);
  const { id, created, result, ticketId, updatedAt, actual, close, ...rest } = p;
  return clean({ ...rest, label: l.label || p.label || legOf(p).label, odds: l.odds ?? p.odds, matchup: l.matchup || p.matchup || p.opp, ref: l.ref || p.ref || (l.athlete ? undefined : l.id) });
}

const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

export async function encodeSlip(legs, { title, stake, american, kind } = {}) {
  const json = new TextEncoder().encode(JSON.stringify(clean({ v: 1, title, stake, american, kind, legs: legs.map(packLeg) })));
  if (typeof CompressionStream === "function") {
    try { return "z" + b64(await pipe(json, new CompressionStream("deflate-raw"))); } catch { /* fall through */ }
  }
  return "j" + b64(json);
}

export async function decodeSlip(code) {
  const raw = unb64(String(code).slice(1));
  const bytes = code[0] === "z" ? await pipe(raw, new DecompressionStream("deflate-raw")) : raw;
  const slip = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(slip?.legs) || !slip.legs.length) throw new Error("This link doesn't have any bets in it.");
  return slip;
}

export async function slipUrl(legs, opts) {
  return `${location.origin}${location.pathname}#/slip?s=${await encodeSlip(legs, opts)}`;
}
