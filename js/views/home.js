import { LEAGUES } from "../sports.js";
import { esc, setTitle } from "../ui.js";
import { todayTeaser } from "./today.js";
import { newsTeaser } from "./news.js";

export function renderHome({ app, alive }) {
  setTitle("");
  const groups = [...new Set(LEAGUES.map((l) => l.group))];
  app.innerHTML = `
    <section class="hero">
      <h1>Research the bet before you make it.</h1>
      <p class="sub">Game logs, hit rates, matchups and a projection for any prop, spread or total. Lines load automatically from DraftKings via ESPN when they're posted. Search any player above, or pick a league.</p>
      <div class="row">
        <a class="btn" href="#/today">🔥 Today's picks</a>
        <a class="btn ghost" href="#/l/nba">Today's NBA</a>
        <a class="btn ghost" href="#/l/nfl">This week's NFL</a>
        <a class="btn ghost" href="#/trends">📈 Trends</a>
        <a class="btn ghost" href="#/live">📡 Live games</a>
        <a class="btn ghost" href="#/news">📰 News & highlights</a>
        <a class="btn ghost" href="#/custom">Custom calculator</a>
      </div>
    </section>
    <div id="home-today"></div>
    <div id="home-news"></div>
    ${groups.map((g) => `
      <div class="league-group">${esc(g)}</div>
      <div class="league-grid">
        ${LEAGUES.filter((l) => l.group === g).map((l) => `
          <a class="league-tile" href="#/l/${l.id}" title="${esc(l.blurb || l.name)}">
            <span class="ico">${l.icon}</span><span>${esc(l.name)}</span>${l.deep ? `<span class="deep" title="Extra advanced stats">PRO</span>` : ""}
          </a>`).join("")}
      </div>`).join("")}
    <div class="grid two" style="margin-top:22px">
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
