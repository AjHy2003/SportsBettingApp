import { LEAGUES } from "../sports.js";
import { esc, setTitle } from "../ui.js";
import { todayTeaser } from "./today.js";
import { newsTeaser } from "./news.js";

// Tile accent color per sport group.
const GROUP_COLOR = {
  Basketball: "#ff7a2f", Football: "#c9874f", Baseball: "#f87171", Hockey: "#38bdf8", Soccer: "#22c55e",
  Racing: "#facc15", Golf: "#14b8a6", Tennis: "#c6f432", Combat: "#e879f9", Other: "#a796ff",
};

export function renderHome({ app, alive }) {
  setTitle("");
  const groups = [...new Set(LEAGUES.map((l) => l.group))];
  const leagues = LEAGUES.filter((l) => l.kind !== "custom").length;
  app.innerHTML = `
    <section class="hero">
      <span class="eyebrow"><i></i>Fresh picks every morning · ${leagues} leagues</span>
      <h1>Smarter bets.<br><span class="grad-text">Every game.</span></h1>
      <p class="sub">Game logs, hit rates and matchups for any prop, spread or total, graded against the real DraftKings line. Search any player, or pick a league below.</p>
      <div class="row">
        <a class="btn lg" href="#/today">🔥 Today's picks</a>
        <a class="btn ghost lg" href="#/today?focus=moon">🚀 $10 → $10K moonshot</a>
      </div>
    </section>
    <div id="home-today"></div>
    <div id="home-news"></div>
    <div class="section-head"><h2>Every league</h2></div>
    <div class="leagues">${groups.map((g) => {
      const ls = LEAGUES.filter((l) => l.group === g);
      return `<section class="lg-sec ${ls.length === 1 ? "solo" : ""}" style="--n:${Math.min(ls.length, 4)}">
      <div class="league-group">${esc(g)}</div>
      <div class="league-grid">
        ${ls.map((l) => `
          <a class="league-tile" href="#/l/${l.id}" title="${esc(l.blurb || `${l.name}: ${l.tag}`)}" style="--sc:${GROUP_COLOR[g] || "var(--accent)"}">
            <span class="ico">${l.icon}</span><span class="lt-text"><span class="nm">${esc(l.name)}</span><span class="lsub">${esc(l.tag || "")}</span></span>${l.deep ? `<span class="deep" title="Extra advanced stats for this league">STATS+</span>` : ""}
          </a>`).join("")}
      </div></section>`;
    }).join("")}</div>
    <div class="grid two" style="margin-top:26px">
      <div class="card">
        <h2>How the projection works</h2>
        <ol class="muted small" style="padding-left:18px;margin:0">
          <li>Starts from the player's recent average, weighted toward the latest games, blended with the longer-term average.</li>
          <li>Basketball and hockey scale by expected minutes, which you can override for injuries or blowouts.</li>
          <li>Adjusts for the opponent: points allowed, opponent misses and pace (NBA), pass/run defense (NFL).</li>
          <li>Turns the projection into an over/under probability using the player's own game-to-game variance, then blends it with the actual hit rate.</li>
          <li>Compares that to the sportsbook price to get edge and expected value. A–C grades need a real edge; anything smaller says PASS.</li>
        </ol>
      </div>
      <div class="card">
        <h2>Tips</h2>
        <ul class="muted small" style="padding-left:18px;margin:0">
          <li>Install it like an app: on iPhone tap Share → Add to Home Screen; on Android tap ⋮ → Install app.</li>
          <li>Tap ★ Save on any analysis to track it. The Picks page grades your saved picks automatically after the games.</li>
          <li>Small samples (early season, return from injury) are shrunk toward a coin flip, so trust A grades backed by 10+ games more.</li>
        </ul>
      </div>
    </div>`;
  newsTeaser(app.querySelector("#home-news"), alive).catch(() => {});
  todayTeaser().then((html) => { if (alive()) { const el = app.querySelector("#home-today"); if (el) el.innerHTML = html; } }).catch(() => {});
}
