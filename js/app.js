import { LEAGUES, leagueById } from "./sports.js";
import { $, esc, errorBox, setTitle } from "./ui.js";
import { searchPlayers } from "./espn.js";
import { renderHome } from "./views/home.js";
import { renderSlate } from "./views/slate.js";
import { renderGame } from "./views/game.js";
import { renderPlayer } from "./views/player.js";
import { renderRacing, renderDriver } from "./views/racing.js";
import { renderGolf } from "./views/golf.js";
import { renderEvents } from "./views/events.js";
import { renderCustom } from "./views/custom.js";
import { renderPicks, liveBetsNow } from "./views/picks.js";
import { renderToday } from "./views/today.js";
import { renderNews } from "./views/news.js";
import { renderTrends } from "./views/trends.js";
import { renderLiveGames } from "./views/livegames.js";

const app = $("#app");
let navToken = 0;

// Views call ctx.alive() before writing so a slow load can't overwrite a newer page.
function context() {
  const t = ++navToken;
  return { app, alive: () => t === navToken };
}

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  return { parts: path.split("/").filter(Boolean), q: Object.fromEntries(new URLSearchParams(qs || "")) };
}

// Highlight the header / tab bar link for the current section.
function markNav(parts) {
  const cur = parts.length ? parts[0] : "home";
  for (const a of document.querySelectorAll("[data-nav]")) {
    const on = a.dataset.nav === cur;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
}

async function route() {
  const { parts, q } = parseHash();
  const ctx = context();
  window.scrollTo(0, 0);
  markNav(parts);
  try {
    if (!parts.length) return renderHome(ctx);
    if (parts[0] === "custom") return renderCustom(ctx, q);
    if (parts[0] === "picks") return renderPicks(ctx, q);
    if (parts[0] === "today") return renderToday(ctx, q);
    if (parts[0] === "news") return renderNews(ctx, q);
    if (parts[0] === "trends") return renderTrends(ctx, q);
    if (parts[0] === "live") return renderLiveGames(ctx, q);
    if (parts[0] === "l") {
      const L = leagueById(parts[1]);
      if (!L) throw new Error("Unknown league");
      if (L.kind === "custom") return renderCustom(ctx, q);
      if (parts[2] === "g") return renderGame(ctx, L, parts[3], q);
      if (parts[2] === "p") return renderPlayer(ctx, L, parts[3], q);
      if (parts[2] === "d") return renderDriver(ctx, L, parts[3], q);
      if (L.kind === "race") return renderRacing(ctx, L, q);
      if (L.kind === "golf") return renderGolf(ctx, L, q);
      if (L.kind === "tennis" || L.kind === "fight") return renderEvents(ctx, L, q);
      return renderSlate(ctx, L, q);
    }
    throw new Error("Page not found");
  } catch (e) {
    console.error(e);
    setTitle("Error");
    app.innerHTML = `${errorBox(e)}<p><a href="#/">Back home</a></p>`;
  }
}

window.addEventListener("hashchange", route);
route();

// Red dot on ★ My bets while a saved bet's game is probably in progress.
function liveDot() {
  const live = liveBetsNow();
  for (const d of document.querySelectorAll(".bets-link .live-dot")) d.hidden = !live;
}
window.addEventListener("hashchange", liveDot);
setInterval(liveDot, 60e3);
liveDot();

// ---------- global player search ----------
const input = $("#search-input");
const results = $("#search-results");
let searchTimer, activeIdx = -1, lastItems = [];

function closeSearch() {
  results.classList.remove("open");
  activeIdx = -1;
}

function playerHref(p, L) {
  if (L.kind === "race") return `#/l/${p.league}?driver=${encodeURIComponent(p.name)}`;
  if (L.kind === "golf") return `#/l/${p.league}?player=${p.id}`;
  if (L.kind === "tennis" || L.kind === "fight") return `#/l/${p.league}?athlete=${p.id}`;
  return `#/l/${p.league}/p/${p.id}`;
}

function paintResults(items, note) {
  lastItems = items;
  if (!items.length) {
    results.innerHTML = `<div class="sr-item muted">${esc(note || "No players found")}</div>`;
  } else {
    results.innerHTML = items.map((p, i) => {
      const L = leagueById(p.league);
      return `<a class="sr-item ${i === activeIdx ? "active" : ""}" href="${playerHref(p, L)}" data-i="${i}">
        <img src="${esc(p.img || "")}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/>
        <div><div>${esc(p.name)}</div><small>${esc(L?.name || "")}${p.sub ? " · " + esc(p.sub) : ""}</small></div></a>`;
    }).join("");
  }
  results.classList.add("open");
}

input.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = input.value.trim();
  if (q.length < 2) return closeSearch();
  searchTimer = setTimeout(async () => {
    try {
      paintResults(await searchPlayers(q));
    } catch (e) {
      paintResults([], "Search unavailable right now");
    }
  }, 220);
});

input.addEventListener("keydown", (e) => {
  if (!results.classList.contains("open")) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    activeIdx = Math.max(0, Math.min(lastItems.length - 1, activeIdx + (e.key === "ArrowDown" ? 1 : -1)));
    paintResults(lastItems);
  } else if (e.key === "Enter") {
    const a = results.querySelectorAll("a.sr-item")[Math.max(0, activeIdx)];
    if (a) { location.hash = a.getAttribute("href"); input.blur(); closeSearch(); }
  } else if (e.key === "Escape") closeSearch();
});

results.addEventListener("click", (e) => {
  if (e.target.closest("a")) { closeSearch(); input.value = ""; }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#search")) closeSearch();
});

// ---------- theme ----------
const THEME_KEY = "picklab.theme";
try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* storage blocked */ }
$("#theme-btn").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const next = cur === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
});

// ---------- offline / install ----------
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

export { LEAGUES };
