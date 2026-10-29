// Line shopping: game lines from every major US sportsbook via The Odds API
// (free key: https://the-odds-api.com). Optional; without ODDS_API_KEY the
// picks fall back to DraftKings prices from ESPN.
// Cost per refresh: 4 sports x 3 markets = 12 requests, so one refresh a day
// (~360/month) stays inside the free 500/month. Other runs reuse the cache.
import fs from "node:fs";
import path from "node:path";

const SPORT_KEYS = { nba: "basketball_nba", nfl: "americanfootball_nfl", ncaaf: "americanfootball_ncaaf", ncaab: "basketball_ncaab" };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const implied = (o) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
const decimal = (o) => (o < 0 ? 1 + 100 / -o : 1 + o / 100);

export async function loadBooks({ key, cacheFile, refresh, leagues }) {
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { /* none yet */ }
  const age = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
  if (key && (refresh || age > 20 * 3600e3)) {
    const out = { fetchedAt: new Date().toISOString(), events: {}, remaining: null };
    for (const lg of leagues) {
      const sport = SPORT_KEYS[lg];
      if (!sport) continue;
      try {
        const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sport}/odds?apiKey=${encodeURIComponent(key)}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&includeLinks=true`);
        out.remaining = r.headers.get("x-requests-remaining") ?? out.remaining;
        if (!r.ok) { console.log(`odds api ${lg}: HTTP ${r.status}`); continue; }
        out.events[lg] = await r.json();
      } catch (e) {
        console.log(`odds api ${lg}: ${e.message}`);
      }
    }
    if (Object.keys(out.events).length) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(out));
      console.log(`odds api: refreshed (${out.remaining ?? "?"} requests left this month)`);
      return out;
    }
  }
  // Prices move: older than 8 hours, fall back to DraftKings rather than blend in stale numbers.
  if (cached && age < 8 * 3600e3) return cached;
  return null;
}

// Find The Odds API event for an ESPN game (same teams, start within 6 hours).
export function matchEvent(books, league, game) {
  const evs = books?.events?.[league] || [];
  const t = new Date(game.start).getTime();
  const near = evs.filter((e) => Math.abs(new Date(e.commence_time).getTime() - t) < 6 * 3600e3);
  const exact = near.find((e) => norm(e.home_team) === norm(game.home.name) && norm(e.away_team) === norm(game.away.name));
  if (exact) return exact;
  // Names drift ("LA Clippers" vs "Los Angeles Clippers", "Miami (FL)" vs "Miami Hurricanes"):
  // fall back to a shared first or last word for both teams.
  const words = (s) => String(s).split(/\s+/).map(norm).filter(Boolean);
  const same = (a, b) => { const x = words(a), y = words(b); return x[0] === y[0] || x.at(-1) === y.at(-1); };
  return near.find((e) => same(e.home_team, game.home.name) && same(e.away_team, game.away.name)) || null;
}

// Every book's price for one side at one number, plus the consensus no-vig probability.
// kind: spread|total|ml; side: HOME|AWAY|OVER|UNDER; point: that side's number.
export function shop(ev, kind, side, point) {
  if (!ev) return null;
  const mk = { spread: "spreads", total: "totals", ml: "h2h" }[kind];
  const name = side === "HOME" ? ev.home_team : side === "AWAY" ? ev.away_team : side === "OVER" ? "Over" : "Under";
  const otherName = side === "HOME" ? ev.away_team : side === "AWAY" ? ev.home_team : side === "OVER" ? "Under" : "Over";
  const prices = [], fair = [];
  for (const b of ev.bookmakers || []) {
    const m = b.markets?.find((x) => x.key === mk);
    if (!m) continue;
    const mine = m.outcomes.find((o) => o.name === name && (kind === "ml" || o.point === point));
    if (!mine) continue;
    // Bet-slip deep link when the book provides one (may contain a {state} placeholder).
    prices.push({ book: b.key, title: b.title, odds: mine.price, link: mine.link || m.link || b.link || null });
    const otherPoint = kind === "spread" ? -point : point;
    const other = m.outcomes.find((o) => o.name === otherName && (kind === "ml" || o.point === otherPoint));
    if (other) fair.push(implied(mine.price) / (implied(mine.price) + implied(other.price)));
  }
  if (!prices.length) return null;
  const best = prices.reduce((a, b) => (decimal(b.odds) > decimal(a.odds) ? b : a));
  return { best, books: prices.length, consensus: fair.length ? fair.reduce((a, b) => a + b, 0) / fair.length : null, prices };
}
