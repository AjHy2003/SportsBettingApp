// Highlight player (full-screen overlay with prev/next and play-all) and the
// clip / story cards used on the News, game, player and home pages.
import { esc } from "./ui.js";
import { leagueById } from "./sports.js";
import { resolveClip, timeAgo, fmtDuration } from "./news.js";

const leagueTag = (id) => { const L = leagueById(id); return L ? `${L.icon} ${L.name}` : ""; };

// items: clips ({ mp4, ... }) or news videos ({ clipApi, ... }, resolved on demand).
export function openPlayer(items, start = 0, { autoNext = items.length > 1 } = {}) {
  document.querySelector(".player-modal")?.remove();
  let i = start, auto = autoNext;
  const el = document.createElement("div");
  el.className = "player-modal";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.innerHTML = `
    <div class="pm-box">
      <div class="pm-top">
        <span class="small muted" id="pm-count"></span>
        <label class="small muted pm-auto"><input type="checkbox" id="pm-auto" ${auto ? "checked" : ""}/> Auto-play next</label>
        <button class="icon-btn" id="pm-close" aria-label="Close">✕</button>
      </div>
      <div class="pm-stage"><video id="pm-video" controls playsinline preload="auto"></video><div class="pm-msg" id="pm-msg" hidden></div></div>
      <div class="pm-meta">
        <div class="pm-title" id="pm-title"></div>
        <div class="small muted" id="pm-sub"></div>
      </div>
      <div class="row pm-nav">
        <button class="btn ghost sm" id="pm-prev">‹ Prev</button>
        <a class="btn ghost sm" id="pm-espn" target="_blank" rel="noopener">Watch on ESPN ↗</a>
        <a class="btn ghost sm" id="pm-game" hidden>Game page ›</a>
        <button class="btn sm" id="pm-next">Next ›</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add("no-scroll");
  const $ = (s) => el.querySelector(s);
  const video = $("#pm-video");
  let token = 0;

  async function show(n) {
    i = (n + items.length) % items.length;
    const t = ++token;
    let c = items[i];
    $("#pm-count").textContent = items.length > 1 ? `${i + 1} of ${items.length}` : "";
    $("#pm-title").textContent = c.headline;
    $("#pm-sub").innerHTML = [c.score && `<b>${esc(c.score)}</b>`, c.status && esc(c.status), leagueTag(c.league), fmtDuration(c.duration), timeAgo(c.published)].filter(Boolean).join(" · ");
    $("#pm-espn").href = c.web || c.url || "https://www.espn.com/video/";
    $("#pm-game").hidden = !c.gameHref;
    if (c.gameHref) $("#pm-game").href = c.gameHref;
    $("#pm-prev").disabled = $("#pm-next").disabled = items.length < 2;
    $("#pm-msg").hidden = true;
    video.poster = c.thumb || c.image || "";
    if (!c.mp4 && c.clipApi) {
      try { const r = await resolveClip(c); if (r) c = items[i] = { ...c, ...r }; } catch { /* fall through to the ESPN link */ }
      if (t !== token) return;
    }
    if (!c.mp4) return fail("This video only plays on ESPN.");
    video.src = c.mp4;
    video.play().catch(() => { /* autoplay blocked: the controls are there */ });
  }
  function fail(msg) {
    video.removeAttribute("src");
    video.load();
    const m = $("#pm-msg");
    m.hidden = false;
    m.innerHTML = `${esc(msg)} <a href="${esc($("#pm-espn").href)}" target="_blank" rel="noopener">Open on ESPN ↗</a>`;
    if (auto && items.length > 1) { const t = token; setTimeout(() => { if (t === token && el.isConnected) show(i + 1); }, 2500); }
  }
  function close() {
    video.pause();
    video.removeAttribute("src");
    video.load();
    el.remove();
    document.body.classList.remove("no-scroll");
    document.removeEventListener("keydown", onKey);
  }
  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight" && items.length > 1) show(i + 1);
    else if (e.key === "ArrowLeft" && items.length > 1) show(i - 1);
  };
  video.addEventListener("ended", () => { if (auto && items.length > 1 && i < items.length - 1) show(i + 1); });
  video.addEventListener("error", () => { if (video.getAttribute("src")) fail("This clip couldn't load here (it may be blocked in your region)."); });
  $("#pm-close").addEventListener("click", close);
  $("#pm-prev").addEventListener("click", () => show(i - 1));
  $("#pm-next").addEventListener("click", () => show(i + 1));
  $("#pm-auto").addEventListener("change", (e) => { auto = e.target.checked; });
  $("#pm-game").addEventListener("click", close);
  el.addEventListener("click", (e) => { if (e.target === el) close(); });
  document.addEventListener("keydown", onKey);
  show(start);
}

export function clipCard(c, i, { showLeague = false } = {}) {
  return `<button class="clip-card" data-clip="${i}" title="${esc(c.headline)}">
    <span class="clip-thumb">${c.thumb || c.image ? `<img loading="lazy" alt="" src="${esc(c.thumb || c.image)}" onerror="this.style.visibility='hidden'"/>` : ""}<span class="clip-play">▶</span>${c.duration ? `<span class="clip-dur">${fmtDuration(c.duration)}</span>` : ""}</span>
    <span class="clip-text">
      ${c.score ? `<span class="clip-score">${esc(c.score)}${c.final ? "" : ` <span class="pill live">${esc(c.status || "Live")}</span>`}</span>` : ""}
      <span class="clip-title">${esc(c.headline)}</span>
      <span class="small faint">${[showLeague && leagueTag(c.league), timeAgo(c.published)].filter(Boolean).join(" · ")}</span>
    </span>
  </button>`;
}

export function storyRow(a, { showLeague = false } = {}) {
  const meta = [showLeague && leagueTag(a.league), a.kind === "recap" ? "Recap" : a.kind === "preview" ? "Preview" : "", a.byline && esc(a.byline), timeAgo(a.published)].filter(Boolean).join(" · ");
  return `<a class="story" href="${esc(a.url || "#")}" target="_blank" rel="noopener">
    ${a.image ? `<img loading="lazy" alt="" src="${esc(a.image)}" onerror="this.replaceWith(Object.assign(document.createElement('span'), { className: 'story-noimg', textContent: '📰' }))"/>` : `<span class="story-noimg">📰</span>`}
    <span class="story-text"><span class="story-title">${esc(a.headline)}</span>${a.description ? `<span class="story-desc">${esc(a.description)}</span>` : ""}<span class="small faint">${meta}</span></span>
  </a>`;
}

// Clicking a [data-clip] card inside root plays that clip, then the rest of the list.
export function wireClips(root, clips, { autoNext = true } = {}) {
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-clip]");
    if (!b || !root.contains(b)) return;
    openPlayer(clips, Number(b.dataset.clip), { autoNext });
  });
}
