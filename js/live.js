// Live bet tracking (no DOM): where each saved pick or ticket leg stands right now,
// from ESPN's live game summary (score, clock, box score).
import { leagueById, MARKETS } from "./sports.js";
import { api, boxStats } from "./espn.js";
import { impliedProb, gameParams } from "./model.js";

// Regulation: [periods, minutes per period].
const CLOCK = { nba: [4, 12], wnba: [4, 10], ncaab: [2, 20], ncaaw: [4, 10], nfl: [4, 15], ncaaf: [4, 15], nhl: [3, 20] };

// Score, clock and the share of regulation played (0..1).
export function gameState(L, sum) {
  const comp = sum?.header?.competitions?.[0];
  if (!comp) return null;
  const st = comp.status || sum.header?.status || {};
  const type = st.type || {};
  const side = (ha) => {
    const c = comp.competitors.find((x) => x.homeAway === ha) || {};
    return { id: String(c.team?.id ?? c.id ?? ""), abbr: c.team?.abbreviation || "", score: c.score != null && c.score !== "" ? Number(c.score) : null };
  };
  const home = side("home"), away = side("away");
  const state = type.state || "pre";
  let fraction = state === "post" ? 1 : 0;
  if (state === "in") {
    const reg = CLOCK[L.id];
    const period = st.period || 1;
    if (reg) {
      const [n, len] = reg;
      const left = Number.isFinite(st.clock) ? st.clock : 0;
      fraction = Math.min(1, ((Math.min(period, n) - 1) * len * 60 + (period > n ? len * 60 : len * 60 - left)) / (n * len * 60));
    } else if (L.markets === "soccer") {
      fraction = Math.min(1, (parseInt(st.displayClock, 10) || 0) / 90);
    } else if (L.markets === "baseball") {
      fraction = Math.min(1, (period - 1 + (/bot|end/i.test(type.shortDetail || "") ? 0.5 : 0)) / 9);
    }
  }
  const wp = sum.winprobability?.at?.(-1)?.homeWinPercentage;
  return { state, completed: !!type.completed, detail: type.shortDetail || type.detail || "", period: st.period, home, away, fraction, winHome: wp != null ? Number(wp) : null };
}

const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

// A saved pick (store.js shape) or ticket leg -> what to track.
export function legOf(p) {
  if (p.game) {
    const kind = ["spread", "total", "ml", "1x2"].includes(p.market) ? p.market
      : /total/i.test(p.marketLabel || "") ? "total" : /spread/i.test(p.marketLabel || "") ? "spread" : "ml";
    return { kind, league: p.league, eventId: p.eventId, start: p.eventDate, side: p.side, line: p.line, homeAbbr: p.homeAbbr, awayAbbr: p.awayAbbr, label: p.side, sub: `${p.athlete || ""} · ${p.marketLabel || ""}` };
  }
  return {
    kind: "prop", league: p.league, eventId: p.eventId, start: p.eventDate, athleteId: p.athleteId ? String(p.athleteId) : null,
    market: p.market, side: p.side, line: Number(p.line), label: `${p.athlete} ${p.side === "OVER" ? "Over" : "Under"} ${p.line} ${p.marketLabel || ""}`.trim(), sub: p.opp || "",
  };
}

// { status: 'upcoming'|'live'|'won'|'lost'|'push'|'void'|'unknown', value, progress (0..1), text, pace }
export function legStatus(leg, gs, box) {
  if (!gs) return { status: "unknown", text: "No game data yet" };
  if (gs.state === "pre") return { status: "upcoming", text: "" };
  const final = gs.state === "post";
  if (gs.state === "post" && !gs.completed) return { status: "void", text: gs.detail || "Postponed" };
  const L = leagueById(leg.league);

  if (leg.kind === "prop") {
    const fam = L?.markets;
    const m = (MARKETS[fam] || MARKETS[leg.family] || []).find((x) => x.key === leg.market);
    const s = box?.get(leg.athleteId);
    if (!m) return { status: "unknown", text: "Unknown market" };
    if (!s) return final ? { status: "void", text: "Didn't play (books usually void this)" } : { status: "live", value: 0, progress: 0, text: "Not in the box score yet" };
    const v = m.stats.reduce((t, k) => t + (Number(s[k]) || 0), 0);
    const over = leg.side === "OVER";
    const pace = !final && gs.fraction >= 0.15 ? v / gs.fraction : null;
    const progress = leg.line > 0 ? Math.min(1, v / leg.line) : 1;
    const paceTxt = pace != null ? ` · on pace for ${fmt(Math.round(pace * 10) / 10)}` : "";
    if (v > leg.line) return over ? { status: "won", value: v, progress: 1, text: `${fmt(v)} — cleared ${leg.line}` } : { status: "lost", value: v, progress: 1, text: `${fmt(v)} — went over ${leg.line}` };
    if (final) {
      if (v === leg.line) return { status: "push", value: v, progress, text: `${fmt(v)} — push` };
      return over ? { status: "lost", value: v, progress, text: `${fmt(v)} — fell short of ${leg.line}` } : { status: "won", value: v, progress, text: `${fmt(v)} — stayed under ${leg.line}` };
    }
    const need = Math.floor(leg.line) + 1 - v;
    return {
      status: "live", value: v, progress, pace,
      onTrack: pace == null ? null : over ? pace > leg.line : pace < leg.line,
      text: over ? `${fmt(v)} of ${leg.line} · needs ${fmt(need)} more${paceTxt}` : `${fmt(v)} of ${leg.line} · ${fmt(Math.max(0, leg.line - v))} to spare${paceTxt}`,
    };
  }

  const h = gs.home.score ?? 0, a = gs.away.score ?? 0;
  const homeSide = String(leg.side || "").split(" ")[0] === (leg.homeAbbr || gs.home.abbr);
  const team = homeSide ? gs.home.abbr : gs.away.abbr;
  if (leg.kind === "total") {
    const t = h + a, over = /^over/i.test(leg.side || "");
    const pace = !final && gs.fraction >= 0.15 ? t / gs.fraction : null;
    const paceTxt = pace != null ? ` · on pace for ${Math.round(pace)}` : "";
    if (t > leg.line) return over ? { status: "won", value: t, progress: 1, text: `${t} points — over hit` } : { status: "lost", value: t, progress: 1, text: `${t} points — went over ${leg.line}` };
    if (final) return t === leg.line ? { status: "push", value: t, text: `${t} — push` } : over ? { status: "lost", value: t, text: `${t} points — under ${leg.line}` } : { status: "won", value: t, text: `${t} points — stayed under` };
    return { status: "live", value: t, progress: Math.min(1, t / leg.line), pace, onTrack: pace == null ? null : over ? pace > leg.line : pace < leg.line, text: `${t} of ${leg.line}${paceTxt}` };
  }
  if (leg.kind === "spread") {
    // line is the home spread
    const adj = h - a + Number(leg.line);
    const cover = homeSide ? adj : -adj;
    if (final) return cover === 0 ? { status: "push", text: "Push" } : cover > 0 ? { status: "won", text: `${team} covered by ${fmt(Math.abs(cover))}` } : { status: "lost", text: `${team} missed by ${fmt(Math.abs(cover))}` };
    return { status: "live", onTrack: cover > 0, text: cover > 0 ? `${team} covering by ${fmt(cover)}` : cover === 0 ? "Right on the number" : `${team} needs ${fmt(-cover)} more` };
  }
  // moneyline / 1x2
  const draw = /draw/i.test(leg.side || "");
  const lead = homeSide ? h - a : a - h;
  if (final) return draw ? (h === a ? { status: "won", text: "Draw" } : { status: "lost", text: "No draw" }) : lead > 0 ? { status: "won", text: `${team} won` } : lead === 0 ? { status: "push", text: "Tie" } : { status: "lost", text: `${team} lost` };
  return { status: "live", onTrack: draw ? h === a : lead > 0, text: draw ? (h === a ? "Level" : "Not level") : lead > 0 ? `${team} up ${lead}` : lead === 0 ? "Tied" : `${team} down ${-lead}` };
}

// ---------- chance to hit, now ----------
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
// Spread of what's left of a stat, relative to its mean (yards swing far more than counts).
const dispersion = (fam, key) => (fam === "football" ? (/yds|yards/.test(key || "") ? 18 : 1.6) : fam === "hockey" ? 1.3 : 2);

// Chance a leg ends up a winner given where it stands. Pre-game: the model's number
// (or the price). Live: what's left of the game, at a pace blended from the line
// and the game so far. A rough, honest estimate, not a model of every possession.
export function liveChance(leg, st, pre) {
  if (!st || st.status === "upcoming" || st.status === "unknown") return pre ?? (leg.odds != null ? impliedProb(leg.odds) : 0.5);
  if (st.status === "won" || st.status === "push" || st.status === "void") return 1;
  if (st.status === "lost") return 0;
  const gs = st.game;
  const f = Math.min(0.99, Math.max(0, gs?.fraction ?? 0));
  const r = 1 - f;
  const p0 = pre ?? (leg.odds != null ? impliedProb(leg.odds) : 0.5);
  if (f < 0.03 || !gs) return p0;
  const L = leagueById(leg.league);
  if (leg.kind === "prop") {
    const v = st.value ?? 0, line = Number(leg.line);
    const m = Math.max(0, (f * (v / f) + (1 - f) * line) * r);
    const sd = Math.sqrt(Math.max(m, 0.25) * dispersion(L?.markets, leg.market));
    return leg.side === "OVER" ? 1 - Phi((Math.floor(line) + 1 - v - 0.5 - m) / sd) : Phi((Math.ceil(line) - 1 - v + 0.5 - m) / sd);
  }
  const P = gameParams(L?.espn?.split("/")[1], L?.markets);
  const h = gs.home.score ?? 0, a = gs.away.score ?? 0;
  const homeSide = String(leg.side || "").split(" ")[0] === (leg.homeAbbr || gs.home.abbr);
  if (leg.kind === "total") {
    const t = h + a, line = Number(leg.line);
    const m = (f * (t / f) + (1 - f) * line) * r;
    const sd = (P.sdTotal || Math.sqrt(Math.max(line, 1))) * Math.sqrt(r);
    const over = 1 - Phi((line - t - m) / sd);
    return /^over/i.test(leg.side || "") ? over : 1 - over;
  }
  if (leg.kind === "spread") {
    const lineHome = Number(leg.line), d = h - a;
    const sd = (P.sdMargin || 3) * Math.sqrt(r);
    const home = 1 - Phi((-lineHome - d - -lineHome * r) / sd);
    return homeSide ? home : 1 - home;
  }
  // Moneyline: ESPN's live win probability when it has one.
  if (gs.winHome != null) return homeSide ? gs.winHome : 1 - gs.winHome;
  const sd = (P.sdMargin || 3) * Math.sqrt(r);
  const home = 1 - Phi((-(h - a) - 0) / sd);
  return homeSide ? home : 1 - home;
}

// One parlay/ticket: lost if any leg lost; won when every leg is settled in its favor.
export function ticketStatus(statuses) {
  const s = statuses.map((x) => x.status);
  if (s.includes("lost")) return "lost";
  if (s.length && s.every((x) => ["won", "push", "void"].includes(x))) return s.every((x) => x !== "won") ? "push" : "won";
  if (s.includes("live") || s.includes("won")) return "live";
  return "upcoming";
}

// Fetch every game the legs need (fresh: ttl seconds) -> Map legIndex -> status, plus game states.
export async function trackLegs(legs, { ttl = 20e3 } = {}) {
  const games = new Map();
  const now = Date.now();
  const need = [...new Set(legs.filter((l) => l.eventId && l.league && (!l.start || new Date(l.start) - now < 20 * 60e3)).map((l) => `${l.league}|${l.eventId}`))];
  await Promise.all(need.map(async (k) => {
    const [lg, ev] = k.split("|");
    const L = leagueById(lg);
    if (!L?.espn) return;
    try {
      const sum = await api.summary(L, ev, ttl);
      games.set(k, { gs: gameState(L, sum), box: boxStats(sum, L.markets) });
    } catch { /* keep going */ }
  }));
  return legs.map((l) => {
    if (l.start && new Date(l.start) - now >= 20 * 60e3) return { status: "upcoming", text: "" };
    const g = games.get(`${l.league}|${l.eventId}`);
    return { ...legStatus(l, g?.gs, g?.box), game: g?.gs || null };
  });
}
