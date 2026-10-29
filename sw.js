// Offline shell: cache the app files, always go to network for data.
const VERSION = "picklab-v5";
const SHELL = [
  "./", "index.html", "css/app.css", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png",
  "js/app.js", "js/model.js", "js/sports.js", "js/espn.js", "js/ui.js", "js/store.js", "js/props.js", "js/deep.js",
  "js/gamemodel.js", "js/scan.js", "js/parlay.js", "js/context.js", "js/news.js", "js/video.js", "js/live.js", "js/views/today.js", "js/views/news.js",
  "js/views/home.js", "js/views/slate.js", "js/views/game.js", "js/views/player.js", "js/views/racing.js",
  "js/views/golf.js", "js/views/events.js", "js/views/custom.js", "js/views/picks.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // App shell: network first so updates land immediately, cache as fallback offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && !url.pathname.includes("/data/")) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
