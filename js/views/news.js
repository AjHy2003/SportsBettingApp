// News & highlights: last night's game highlight packages (playable here), top
// stories, video analysis, and AP recaps/previews, per sport. Live from ESPN.
import { leagueById } from "../sports.js";
import { clearCache } from "../espn.js";
import { esc, setTitle, fmtTime } from "../ui.js";
import { leagueNews, gameHighlights, isStory } from "../news.js";
import { clipCard, storyRow, openPlayer } from "../video.js";

const SPORTS = [
  { id: "all", label: "All", leagues: ["nba", "nfl", "ncaaf", "ncaab"] },
  { id: "basketball", label: "🏀 All basketball", leagues: ["nba", "ncaab"] },
  { id: "nba", label: "NBA", leagues: ["nba"] },
  { id: "ncaab", label: "College BB", leagues: ["ncaab"] },
  { id: "football", label: "🏈 All football", leagues: ["nfl", "ncaaf"] },
  { id: "nfl", label: "NFL", leagues: ["nfl"] },
  { id: "ncaaf", label: "College FB", leagues: ["ncaaf"] },
  { id: "nhl", label: "🏒 NHL", leagues: ["nhl"] },
  { id: "mlb", label: "⚾ MLB", leagues: ["mlb"] },
  { id: "soccer", label: "⚽ Soccer", leagues: ["epl", "ucl", "mls"] },
];
const PREFS = "picklab.news.v1";
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS) || "{}"); } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* ignore */ } };
const byNewest = (a, b) => new Date(b.published || 0) - new Date(a.published || 0);
const spin = (msg) => `<div class="loading small"><span class="spinner"></span>${esc(msg)}</div>`;
const LIMIT = { clips: 12, stories: 10, videos: 6 };

export async function renderNews(ctx, q) {
  const { app } = ctx;
  setTitle("News & highlights");
  const state = { sport: "all", ...loadPrefs(), more: {} };
  if (q.sport && SPORTS.some((s) => s.id === q.sport)) state.sport = q.sport;
  if (!SPORTS.some((s) => s.id === state.sport)) state.sport = "all";
  const data = { clips: null, news: null, clipsFailed: false, newsFailed: false };
  let token = 0;

  app.innerHTML = `<div id="n-root">
    <div class="crumbs"><a href="#/">Home</a> › News</div>
    <div class="row" style="justify-content:space-between">
      <h1>📰 News & highlights</h1>
      <div class="row small muted"><span id="n-updated"></span><button class="btn ghost sm" id="n-refresh">↻ Refresh</button></div>
    </div>
    <div class="chips scroll" id="n-sport" style="margin-bottom:14px">${SPORTS.map((s) => `<button class="chip" data-s="${s.id}">${s.label}</button>`).join("")}</div>
    <section class="card">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">🎬 Game highlights</h2><button class="btn sm" id="n-playall" hidden>▶ Play all</button></div>
      <p class="small muted" style="margin:4px 0 12px">Every finished game from yesterday and today (this week and last week for football). Tap to watch here.</p>
      <div id="n-clips"></div>
    </section>
    <div class="grid two" style="margin-top:14px;align-items:start">
      <section class="card"><h2>🗞️ Top stories</h2><div id="n-stories"></div></section>
      <section class="card"><h2>📺 Videos & analysis</h2><div id="n-videos"></div></section>
    </div>
    <section class="card" style="margin-top:14px"><details><summary><h2 style="display:inline">📝 Recaps & previews</h2> <span class="small muted" id="n-recaps-count"></span></summary><div id="n-recaps" style="margin-top:10px"></div></details></section>
  </div>`;
  const root = app.querySelector("#n-root");
  const $ = (s) => root.querySelector(s);
  const sport = () => SPORTS.find((s) => s.id === state.sport);
  const multi = () => sport().leagues.length > 1;
  const moreBtn = (key, left) => (left > 0 ? `<button class="btn ghost sm" data-more="${key}" style="margin-top:10px">Show ${left} more</button>` : "");
  const lists = () => {
    const all = data.news || [];
    // Game highlight packages show up in the news feed too: keep them in one place.
    const shown = new Set((data.clips || []).flatMap((c) => [c.id, c.headline]));
    const videos = all.filter((a) => a.kind === "video" && !shown.has(a.id) && !shown.has(a.headline));
    return { stories: all.filter(isStory), videos, recaps: all.filter((a) => a.kind === "recap" || a.kind === "preview") };
  };

  function paintClips() {
    const clips = data.clips;
    if (!clips) { $("#n-clips").innerHTML = spin("Loading highlights…"); $("#n-playall").hidden = true; return; }
    const n = state.more.clips ? clips.length : LIMIT.clips;
    $("#n-playall").hidden = clips.length < 2;
    $("#n-playall").textContent = `▶ Play all (${clips.length})`;
    $("#n-clips").innerHTML = clips.length
      ? `<div class="clip-grid">${clips.slice(0, n).map((c, i) => clipCard(c, i, { showLeague: multi() })).join("")}</div>${moreBtn("clips", clips.length - n)}`
      : `<p class="muted">${data.clipsFailed ? "Couldn't reach ESPN. Try ↻ Refresh." : `No finished ${esc(sport().label.replace(/^[^A-Za-z]+/, ""))} games with highlights yet. Check back after tonight's games.`}</p>`;
  }

  function paintNews() {
    if (!data.news) {
      $("#n-stories").innerHTML = $("#n-videos").innerHTML = spin("Loading news…");
      $("#n-recaps").innerHTML = $("#n-recaps-count").textContent = "";
      return;
    }
    const { stories, videos, recaps } = lists();
    const nS = state.more.stories ? stories.length : LIMIT.stories, nV = state.more.videos ? videos.length : LIMIT.videos;
    const none = (what) => `<p class="muted">${data.newsFailed ? "Couldn't reach ESPN. Try ↻ Refresh." : `No ${what} right now.`}</p>`;
    $("#n-stories").innerHTML = stories.length ? `<div class="story-list">${stories.slice(0, nS).map((a) => storyRow(a, { showLeague: multi() })).join("")}</div>${moreBtn("stories", stories.length - nS)}` : none("stories");
    $("#n-videos").innerHTML = videos.length ? `<div class="clip-grid compact">${videos.slice(0, nV).map((v, i) => clipCard(v, i, { showLeague: multi() })).join("")}</div>${moreBtn("videos", videos.length - nV)}` : none("videos");
    $("#n-recaps-count").textContent = `(${recaps.length})`;
    $("#n-recaps").innerHTML = recaps.length ? `<div class="story-list">${recaps.slice(0, 40).map((a) => storyRow(a, { showLeague: multi() })).join("")}</div>` : "";
  }

  async function load(force = false) {
    const t = ++token;
    const leagues = sport().leagues.map(leagueById).filter(Boolean);
    root.querySelectorAll("#n-sport .chip").forEach((b) => b.classList.toggle("on", b.dataset.s === state.sport));
    Object.assign(data, { clips: null, news: null });
    paintClips();
    paintNews();
    if (force) leagues.forEach((L) => clearCache(`/${L.espn}/`));
    const live = () => t === token && ctx.alive();

    const newsP = Promise.allSettled(leagues.map((L) => leagueNews(L, { limit: 40 }))).then((rs) => {
      if (!live()) return;
      const seen = new Set();
      data.news = rs.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).filter((a) => !seen.has(a.id) && seen.add(a.id)).sort(byNewest);
      data.newsFailed = rs.every((r) => r.status === "rejected");
      paintNews();
    });
    const clipsP = Promise.allSettled(leagues.map((L) => gameHighlights(L))).then((rs) => {
      if (!live()) return;
      data.clips = rs.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).sort(byNewest);
      data.clipsFailed = rs.every((r) => r.status === "rejected");
      paintClips();
      if (data.news) paintNews();
    });
    await Promise.all([newsP, clipsP]);
    if (live()) $("#n-updated").textContent = `Updated ${fmtTime(new Date().toISOString())}`;
  }

  // Lists change with the filter, so clips are looked up at click time.
  $("#n-clips").addEventListener("click", (e) => { const b = e.target.closest("[data-clip]"); if (b) openPlayer(data.clips, Number(b.dataset.clip)); });
  $("#n-videos").addEventListener("click", (e) => { const b = e.target.closest("[data-clip]"); if (b) openPlayer(lists().videos, Number(b.dataset.clip)); });
  $("#n-playall").addEventListener("click", () => data.clips?.length && openPlayer(data.clips, 0, { autoNext: true }));
  $("#n-refresh").addEventListener("click", () => load(true));
  root.addEventListener("click", (e) => {
    const chip = e.target.closest("#n-sport .chip");
    if (chip) {
      state.sport = chip.dataset.s;
      state.more = {};
      savePrefs({ sport: state.sport });
      history.replaceState(null, "", `#/news?sport=${state.sport}`);
      return load();
    }
    const more = e.target.closest("[data-more]");
    if (more) {
      state.more[more.dataset.more] = true;
      if (more.dataset.more === "clips") paintClips(); else paintNews();
    }
  });
  await load();
}

// Home page: a few of the latest highlights and top stories (NBA + NFL).
export async function newsTeaser(el, alive) {
  const leagues = ["nba", "nfl"].map(leagueById);
  const [clipsR, newsR] = await Promise.all([
    Promise.allSettled(leagues.map((L) => gameHighlights(L))),
    Promise.allSettled(leagues.map((L) => leagueNews(L, { limit: 15 }))),
  ]);
  if (!alive() || !el.isConnected) return;
  const clips = clipsR.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).sort(byNewest).slice(0, 4);
  const stories = newsR.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).filter(isStory).sort(byNewest).slice(0, 4);
  if (!clips.length && !stories.length) return;
  el.innerHTML = `<div class="card" style="margin-top:14px">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">${clips.length ? "🎬 Latest highlights" : "🗞️ Top stories"}</h2><a href="#/news">All news & highlights ›</a></div>
    ${clips.length ? `<div class="clip-grid compact" id="h-clips" style="margin-top:12px">${clips.map((c, i) => clipCard(c, i, { showLeague: true })).join("")}</div>` : ""}
    ${stories.length ? `${clips.length ? `<h3 style="margin:16px 0 4px">🗞️ Top stories</h3>` : ""}<div class="story-list">${stories.map((a) => storyRow(a, { showLeague: true })).join("")}</div>` : ""}
  </div>`;
  el.querySelector("#h-clips")?.addEventListener("click", (e) => { const b = e.target.closest("[data-clip]"); if (b) openPlayer(clips, Number(b.dataset.clip)); });
}
