// End-to-end check against live data: serves the built site, visits key pages,
// records console errors and screenshots. Usage: node tools/e2e.cjs <site_dir> <out_dir>
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const [siteDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(siteDir, p);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(8765);

const pages = [
  ["home", "#/"], ["nba-slate", "#/l/nba"], ["lebron", "#/l/nba/p/1966"], ["embiid", "#/l/nba/p/3059318"],
  ["nfl-slate", "#/l/nfl"], ["chase", "#/l/nfl/p/4362628"], ["lamar", "#/l/nfl/p/3916387"], ["mahomes", "#/l/nfl/p/3139477"],
  ["mlb-judge", "#/l/mlb/p/33192"], ["nhl-slate", "#/l/nhl"], ["mcdavid", "#/l/nhl/p/3895074"], ["epl-slate", "#/l/epl"], ["haaland", "#/l/epl/p/253989"],
  ["f1", "#/l/f1"], ["nascar", "#/l/nascar"], ["indycar", "#/l/indycar"], ["pga", "#/l/pga"], ["atp", "#/l/atp"], ["ufc", "#/l/ufc"],
  ["ncaaf", "#/l/ncaaf"], ["ncaab", "#/l/ncaab"], ["custom", "#/custom"], ["picks", "#/picks"],
];

(async () => {
  // Google Chrome (E2E_CHANNEL=chrome) plays H.264 video; bundled Chromium doesn't.
  const browser = await chromium.launch(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/New_York" });
  const report = [];
  const visit = async (name, hash, after) => {
    const pg = await ctx.newPage();
    const errors = [];
    pg.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text().slice(0, 300)); });
    const failed = [];
    pg.on("response", (r) => { if (r.status() >= 400 && !/espncdn|fonts/.test(r.url())) failed.push(`${r.status()} ${r.url().slice(0, 140)}`); });
    try {
      await pg.goto("http://localhost:8765/" + hash, { waitUntil: "networkidle", timeout: 45000 });
    } catch (e) { errors.push("goto: " + e.message.slice(0, 200)); }
    await pg.waitForTimeout(1500);
    let extra = null;
    if (after) { try { extra = await after(pg); } catch (e) { errors.push("after: " + e.message.slice(0, 200)); } }
    await pg.screenshot({ path: path.join(outDir, name + ".png"), fullPage: true });
    const text = (await pg.innerText("main").catch(() => "")).replace(/\s+/g, " ");
    report.push({ name, hash, url: pg.url(), errors, failed: failed.slice(0, 15), text: text.slice(0, 1500), ...(extra ? { extra } : {}) });
    console.log(name, errors.length ? errors : "ok");
    await pg.close();
  };
  for (const [name, hash] of pages) await visit(name, hash);
  // First game on each slate, and a full prop scan for the first NBA game with lines.
  for (const lg of ["nba", "nfl", "nhl", "epl", "mlb"]) {
    await visit(`${lg}-game`, `#/l/${lg}`, async (pg) => {
      const a = await pg.$("a.game-card");
      if (!a) return;
      await a.click();
      await pg.waitForLoadState("networkidle").catch(() => {});
      await pg.waitForTimeout(2500);
      const scan = await pg.$("#scan");
      if (scan) { await scan.click(); await pg.waitForFunction(() => !document.querySelector("#scan") || !/Scanning/.test(document.querySelector("#scan").textContent), null, { timeout: 120000 }).catch(() => {}); }
    });
  }
  // Today page: default ticket, a $5 basketball-only parlay, then a same-game parlay.
  await visit("today", "#/today");
  await visit("today-bball-5-parlay", "#/today?sport=basketball", async (pg) => {
    await pg.click('#t-budget .chip[data-b="5"]');
    await pg.click('#t-mode button[data-m="parlay"]');
    await pg.waitForTimeout(500);
  });
  for (const sport of ["football", "ncaaf", "basketball"]) {
    await visit(`today-sgp-${sport}`, `#/today?sport=${sport}`, async (pg) => {
      const opts = await pg.$$eval("#t-sgp-game option", (o) => o.map((x) => x.value).filter(Boolean));
      if (!opts.length) return;
      await pg.selectOption("#t-sgp-game", opts[0]);
      await pg.waitForFunction(() => !document.querySelector("#t-sgp-body .spinner"), null, { timeout: 120000 }).catch(() => {});
      const use = await pg.$("#t-sgp-use");
      if (use) { await use.click(); await pg.waitForTimeout(300); }
    });
  }
  // Player pages for today's best props (tonight's context: Vegas total, injuries, with/without).
  let today = null;
  try { today = JSON.parse(fs.readFileSync(path.join(siteDir, "data/picks/today.json"), "utf8")); } catch { /* no picks */ }
  for (const lg of ["nba", "nfl", "ncaab", "ncaaf"]) {
    const leg = today?.legs?.filter((l) => l.kind === "prop" && l.league === lg && l.lean).sort((a, b) => (b.context?.length || 0) - (a.context?.length || 0) || b.edge - a.edge)[0];
    if (leg) await visit(`context-${lg}`, `#/l/${lg}/p/${leg.playerId}?m=${leg.marketKey}`);
  }
  // News & highlights: play the reel and check the video really plays and advances.
  const playback = async (pg, startSel) => {
    const b = await pg.$(startSel);
    if (!b) return { skipped: `no ${startSel}` };
    await b.click();
    await pg.waitForTimeout(6000);
    const st = await pg.evaluate(() => { const v = document.querySelector("#pm-video"); return v && { count: document.querySelector("#pm-count")?.textContent, title: document.querySelector("#pm-title")?.textContent, src: v.currentSrc.slice(0, 120), readyState: v.readyState, time: v.currentTime, duration: v.duration, paused: v.paused, error: v.error?.code ?? null, msg: document.querySelector("#pm-msg").hidden ? "" : document.querySelector("#pm-msg").textContent }; });
    await pg.screenshot({ path: path.join(outDir, `player-${startSel.replace(/\W+/g, "")}.png`) });
    await pg.keyboard.press("ArrowRight");
    await pg.waitForTimeout(4000);
    const next = await pg.evaluate(() => { const v = document.querySelector("#pm-video"); return v && { count: document.querySelector("#pm-count")?.textContent, time: v.currentTime, error: v.error?.code ?? null }; });
    await pg.keyboard.press("Escape");
    return { first: st, next };
  };
  await visit("news", "#/news?sport=all", (pg) => playback(pg, "#n-playall"));
  await visit("news-videos", "#/news?sport=nba", async (pg) => playback(pg, "#n-videos [data-clip]"));
  for (const sport of ["football", "nhl", "mlb", "soccer"]) await visit(`news-${sport}`, `#/news?sport=${sport}`);
  await visit("nba-game-highlights", "#/l/nba", async (pg) => {
    const final = await pg.$$("a.game-card");
    for (const a of final) {
      if (!/final/i.test(await a.innerText())) continue;
      await a.click();
      await pg.waitForLoadState("networkidle").catch(() => {});
      await pg.waitForTimeout(2500);
      return playback(pg, "#g-clips [data-clip]");
    }
    return { skipped: "no finished NBA game on today's slate" };
  });
  // Weather on outdoor football game pages; alt-line ladders on player pages.
  for (const g of (today?.games || []).filter((x) => x.weather && !x.weather.indoor).slice(0, 2)) {
    await visit(`weather-${g.league}-${g.eventId}`, `#/l/${g.league}/g/${g.eventId}`, async (pg) => ({ weather: g.weather, header: (await pg.innerText(".card").catch(() => "")).replace(/\s+/g, " ").slice(0, 300) }));
  }
  for (const lg of ["nba", "nfl"]) {
    const leg = today?.legs?.find((l) => l.kind === "prop" && l.league === lg && ["pts", "reb", "ast", "pra", "rec_yds", "pass_yds"].includes(l.marketKey));
    if (leg) await visit(`ladder-${lg}`, `#/l/${lg}/p/${leg.playerId}?m=${leg.marketKey}`, async (pg) => {
      const text = (await pg.innerText("#ladder").catch(() => "")).replace(/\s+/g, " ");
      const row = await pg.$("#ladder tr[data-at]");
      if (row) { await row.click(); await pg.waitForTimeout(400); }
      return { ladder: text.slice(0, 700), afterClick: (await pg.innerText("#verdict").catch(() => "")).replace(/\s+/g, " ").slice(0, 200) };
    });
  }
  // Live tracker: a ticket built from last night's finished NBA games must settle correctly.
  try {
    const W = "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba";
    const y = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - 864e5)).replaceAll("-", "");
    const sb = await (await fetch(`${W}/scoreboard?dates=${y}`)).json();
    const evs = (sb.events || []).filter((e) => e.status?.type?.state === "post").slice(0, 2);
    const legs = [], expect = [];
    for (const e of evs) {
      const sum = await (await fetch(`${W}/summary?event=${e.id}`)).json();
      const c = sum.header.competitions[0];
      const home = c.competitors.find((x) => x.homeAway === "home"), away = c.competitors.find((x) => x.homeAway === "away");
      const h = Number(home.score), a = Number(away.score);
      const grp = sum.boxscore.players[0].statistics[0];
      const pi = grp.keys.indexOf("points");
      const ath = grp.athletes.find((x) => x.stats?.length);
      const pts = Number(ath.stats[pi]);
      const base = { league: "nba", eventId: e.id, eventDate: c.date };
      legs.push({ ...base, athleteId: ath.athlete.id, athlete: ath.athlete.displayName, market: "pts", marketLabel: "Points", side: "OVER", line: pts - 0.5 }); expect.push("won");
      legs.push({ ...base, athleteId: ath.athlete.id, athlete: ath.athlete.displayName, market: "pts", marketLabel: "Points", side: "OVER", line: pts + 0.5 }); expect.push("lost");
      legs.push({ ...base, game: true, market: "total", marketLabel: "Total", side: `Under ${h + a + 0.5}`, line: h + a + 0.5, homeAbbr: home.team.abbreviation, awayAbbr: away.team.abbreviation, athlete: `${away.team.abbreviation} @ ${home.team.abbreviation}` }); expect.push("won");
      const fav = h > a ? home : away;
      legs.push({ ...base, game: true, market: "ml", marketLabel: "Moneyline", side: `${fav.team.abbreviation} ML`, line: null, homeAbbr: home.team.abbreviation, awayAbbr: away.team.abbreviation, athlete: `${away.team.abbreviation} @ ${home.team.abbreviation}` }); expect.push("won");
    }
    if (legs.length) {
      const tickets = legs.map((l, i) => ({ id: `e2e${i}`, created: new Date().toISOString(), type: "single", stake: 1, american: -110, toWin: 0.91, legs: [l] }));
      await ctx.addInitScript((t) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("picklab.tickets.v1", t); sessionStorage.setItem("seeded", "1"); } }, JSON.stringify(tickets));
      await visit("tracker", "#/picks?tab=live", async (pg) => {
        await pg.waitForTimeout(3000);
        const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem("picklab.tickets.v1")).map((t) => t.result || null));
        const want = expect.map((x) => (x === "won" ? "W" : "L"));
        return { expect: want, got: stored, ok: JSON.stringify(stored) === JSON.stringify(want), text: (await pg.innerText("#b-body")).replace(/\s+/g, " ").slice(0, 800) };
      });
    }
  } catch (e) { report.push({ name: "tracker", errors: ["setup: " + e.message] }); }
  // Moonshots and place-it panels on the Today page.
  for (const sport of ["all", "basketball", "football", "nhl"]) {
    await visit(`moonshot-${sport}`, `#/today?sport=${sport}`, async (pg) => {
      const moon = (await pg.innerText("#t-moon").catch(() => "")).replace(/\s+/g, " ");
      const books = await pg.$$eval("#t-moon .bookbtn", (x) => x.map((a) => a.href));
      const dkExact = await pg.$$eval("#t-moon .place-legs a.bookchip", (x) => x.filter((a) => /outcomes=/.test(a.href)).length);
      const pickDk = await pg.$$eval("#t-picks .bookchip", (x) => x.map((a) => a.href).slice(0, 5));
      return { moon: moon.slice(0, 900), books, dkExactLegs: dkExact, pickDk };
    });
  }
  // Day picker: the default day per sport, then each other day, then a single game.
  for (const sport of ["nfl", "football", "all"]) {
    await visit(`today-days-${sport}`, `#/today?sport=${sport}`, async (pg) => {
      const snap = async () => ({
        days: (await pg.innerText("#t-day").catch(() => "")).replace(/\s+/g, " "),
        note: await pg.innerText("#t-day-note").catch(() => ""),
        games: await pg.innerText("#t-games-sum").catch(() => ""),
        ticket: (await pg.innerText("#t-ticket").catch(() => "")).replace(/\s+/g, " ").slice(0, 260),
        pickDays: [...new Set(await pg.$$eval("#t-picks .pick .small.muted", (x) => x.map((e) => e.innerText.split(" · ").slice(2, 3).join("").split(" ")[0])))],
      });
      const out = { first: await snap(), other: [] };
      for (const d of await pg.$$eval("#t-day .chip", (x) => x.map((c) => c.dataset.d))) {
        await pg.click(`#t-day .chip[data-d="${d}"]`);
        await pg.waitForTimeout(300);
        out.other.push({ d, ...(await snap()) });
      }
      return out;
    });
  }
  // Trends and the live games board.
  for (const sp of ["all", "nfl", "nba"]) {
    await visit(`trends-${sp}`, `#/trends?sport=${sp}`, async (pg) => ({
      streaks: await pg.$$eval("tbody tr", (x) => x.length).catch(() => 0),
      teamRows: await pg.$$eval("tr.hot, tr.cold", (x) => x.length).catch(() => 0),
      moves: await pg.$$eval(".mvrow", (x) => x.length).catch(() => 0),
    }));
  }
  await visit("live-games", "#/live", async (pg) => {
    await pg.waitForTimeout(3000);
    return { cards: await pg.$$eval(".lgame", (x) => x.length), text: (await pg.innerText("#lg-body").catch(() => "")).replace(/\s+/g, " ").slice(0, 600) };
  });
  await visit("home-with-picks", "#/");
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 1));
  await browser.close();
  server.close();
})();
