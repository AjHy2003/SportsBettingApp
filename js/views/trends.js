// Trends: hot and cold streaks against today's lines, team records against the
// spread and on totals, and the day's biggest line moves. Built from the daily file.
import { leagueById } from "../sports.js";
import * as M from "../model.js";
import { esc, loading, setTitle, pct, signed, fmtTime } from "../ui.js";
import { moveText } from "../movement.js";

const SPORTS = [
  { id: "all", label: "All", leagues: ["nba", "ncaab", "nfl", "ncaaf", "nhl"] },
  { id: "basketball", label: "🏀 All basketball", leagues: ["nba", "ncaab"] },
  { id: "nba", label: "NBA", leagues: ["nba"] },
  { id: "ncaab", label: "College BB", leagues: ["ncaab"] },
  { id: "football", label: "🏈 All football", leagues: ["nfl", "ncaaf"] },
  { id: "nfl", label: "NFL", leagues: ["nfl"] },
  { id: "ncaaf", label: "College FB", leagues: ["ncaaf"] },
  { id: "nhl", label: "🏒 NHL", leagues: ["nhl"] },
];
const leagueName = (id) => leagueById(id)?.name || id;
const rec = (r) => (r ? `${r.w}-${r.l}${r.p ? `-${r.p}` : ""}` : "—");
const share = (w, l) => (w + l ? w / (w + l) : null);
const dots = (s, good) => [...(s || "")].map((c) => `<span class="dot ${c === good ? "g" : c === "P" ? "p" : "b"}" title="${c}"></span>`).join("");

export async function renderTrends(ctx, q) {
  const { app } = ctx;
  setTitle("Trends");
  app.innerHTML = loading("Loading trends…");
  const today = await fetch("data/picks/today.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!ctx.alive()) return;
  let sport = SPORTS.some((s) => s.id === q.sport) ? q.sport : "all";
  const now = Date.now();

  const render = () => {
    const leagues = SPORTS.find((s) => s.id === sport).leagues;
    const games = (today?.games || []).filter((g) => leagues.includes(g.league) && new Date(g.start) > now - 3 * 3600e3);
    const legs = (today?.legs || []).filter((l) => leagues.includes(l.league) && new Date(l.start) > now);

    // Streaks: the leg's side hit in 8+ of the last 10.
    const streaks = legs.filter((l) => l.kind === "prop" && l.l10?.n >= 8)
      .map((l) => ({ l, hits: l.side === "OVER" ? l.l10.overs : l.l10.unders, n: l.l10.n }))
      .filter((x) => x.hits / x.n >= 0.8)
      .sort((a, b) => b.hits / b.n - a.hits / a.n || b.l.edge - a.l.edge).slice(0, 40);

    // Team records for today's games.
    const teamRows = games.filter((g) => g.records).flatMap((g) => [["away", g.away], ["home", g.home]].map(([side, t]) => ({ g, t, side, r: g.records[side] })))
      .filter((x) => x.r?.n >= 3);
    const hotTeams = [...teamRows].map((x) => ({ ...x, s: share(x.r.ats.w, x.r.ats.l) })).filter((x) => x.s != null && x.r.n >= 5 && (x.s >= 0.7 || x.s <= 0.3)).sort((a, b) => Math.abs(b.s - 0.5) - Math.abs(a.s - 0.5));

    // Line moves: strongest first.
    const moves = legs.filter((l) => l.move && l.lean).sort((a, b) => (b.move.strong - a.move.strong) || (b.move.size / Math.max(1, Math.abs(b.line || 1))) - (a.move.size / Math.max(1, Math.abs(a.line || 1)))).slice(0, 30);

    app.innerHTML = `<div id="tr-root">
      <div class="crumbs"><a href="#/">Home</a> › Trends</div>
      <div class="row" style="justify-content:space-between"><h1>📈 Trends</h1><span class="small muted">${today ? `From the ${fmtTime(today.generated)} update · <a href="#/today">🔥 Today's picks</a> · <a href="#/live">📡 Live games</a>` : ""}</span></div>
      <div class="chips scroll" id="tr-sport" style="margin-bottom:14px">${SPORTS.map((s) => `<button class="chip ${s.id === sport ? "on" : ""}" data-s="${s.id}">${s.label}</button>`).join("")}</div>
      ${!today ? `<div class="notice warn">Trends come from the daily picks file, which hasn't been generated yet.</div>` : ""}

      <div class="card"><h3>🔥 Hot streaks vs today's lines</h3>
        <p class="small muted" style="margin:0 0 8px">Players who cleared today's line (on the model's side) in 8+ of their last 10. Books know about streaks too, so the model column says whether there's still value at today's price.</p>
        ${streaks.length ? `<div class="table-wrap"><table><thead><tr><th>Pick</th><th class="r">Last 10</th><th class="r">Model</th><th class="r">Edge</th><th class="r">Grade</th></tr></thead><tbody>
          ${streaks.map(({ l, hits, n }) => `<tr><td><a href="#/l/${l.league}/p/${l.playerId}?m=${l.marketKey}&line=${l.line}">${esc(l.label)}</a> <span class="faint small">${M.fmtOdds(l.odds)} · ${esc(l.matchup)}</span>${l.move ? `<div class="small ${l.move.toward ? "pos" : "muted"}">${esc(moveText(l.move))}</div>` : ""}</td>
            <td class="r"><b>${hits}/${n}</b></td><td class="r">${pct(l.prob)}</td><td class="r ${l.edge > 0 ? "pos" : "neg"}">${signed(l.edge * 100, 1)}</td><td class="r"><b>${esc(l.grade)}</b></td></tr>`).join("")}
        </tbody></table></div>` : `<p class="muted small">No 8-for-10 streaks on today's ${esc(SPORTS.find((s) => s.id === sport).label)} lines.</p>`}
      </div>

      <div class="card" style="margin-top:14px"><h3>📊 Teams against the spread</h3>
        <p class="small muted" style="margin:0 0 8px">This season vs DraftKings' closing lines. ${hotTeams.length ? "Teams covering 70%+ (or 30% or less) with 5+ games are highlighted." : ""}</p>
        ${teamRows.length ? `<div class="table-wrap"><table><thead><tr><th>Game</th><th>Team</th><th class="r">ATS</th><th>Last 5</th><th class="r">${"Home/Away ATS"}</th><th class="r">O/U</th><th>Last 5</th></tr></thead><tbody>
          ${teamRows.map(({ g, t, side, r }) => {
            const s = share(r.ats.w, r.ats.l);
            const hot = r.n >= 5 && s != null && (s >= 0.7 || s <= 0.3);
            const ha = side === "home" ? r.atsHome : r.atsAway;
            return `<tr class="${hot ? (s >= 0.7 ? "hot" : "cold") : ""}"><td class="small"><a href="#/l/${g.league}/g/${g.eventId}">${esc(g.matchup)}</a><div class="faint">${esc(leagueName(g.league))}${g.lines?.details ? ` · ${esc(g.lines.details)}` : ""}</div></td>
              <td><b>${esc(t.abbr)}</b> <span class="faint small">${side}</span></td><td class="r"><b>${rec(r.ats)}</b>${s != null ? ` <span class="faint small">${pct(s)}</span>` : ""}</td><td>${dots(r.atsLast5, "W")}</td>
              <td class="r small">${side === "home" ? "home" : "away"} ${rec(ha)}</td><td class="r">${r.ou.o}-${r.ou.u}${r.ou.p ? `-${r.ou.p}` : ""} <span class="faint small">O-U</span></td><td>${dots(r.ouLast5, "O")}</td></tr>`;
          }).join("")}
        </tbody></table></div>` : `<p class="muted small">No team records yet for these games (records build up after each team's first few games).</p>`}
        <p class="small faint" style="margin:8px 0 0">Records vs the spread are noisy over small samples and books adjust to them quickly. Treat them as a nudge, not a system.</p>
      </div>

      <div class="card" style="margin-top:14px"><h3>📉📈 Biggest line moves</h3>
        <p class="small muted" style="margin:0 0 8px">Opening line vs now for the model's picks. A move toward a pick means the market came around to it; a big move against usually means news or sharp money (those picks are graded down).</p>
        ${moves.length ? moves.map((l) => `<div class="mvrow"><div><a href="${l.kind === "prop" ? `#/l/${l.league}/p/${l.playerId}?m=${l.marketKey}` : `#/l/${l.league}/g/${l.eventId}`}"><b>${esc(l.label)}</b></a> <span class="faint small">${M.fmtOdds(l.odds)} · ${esc(l.matchup)} · grade ${esc(l.grade)}</span></div>
          <div class="small ${l.move.toward ? "pos" : l.move.strong ? "neg" : "muted"}">${esc(moveText(l.move))}</div></div>`).join("") : `<p class="muted small">No notable moves on today's picks yet.</p>`}
      </div>
    </div>`;
    app.querySelector("#tr-sport").addEventListener("click", (e) => {
      const c = e.target.closest(".chip");
      if (!c) return;
      sport = c.dataset.s;
      history.replaceState(null, "", `#/trends?sport=${sport}`);
      render();
    });
  };
  render();
}
