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
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
    if (after) { try { await after(pg); } catch (e) { errors.push("after: " + e.message.slice(0, 200)); } }
    await pg.screenshot({ path: path.join(outDir, name + ".png"), fullPage: true });
    const text = (await pg.innerText("main").catch(() => "")).replace(/\s+/g, " ");
    report.push({ name, hash, url: pg.url(), errors, failed: failed.slice(0, 15), text: text.slice(0, 1500) });
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
  await visit("home-with-picks", "#/");
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 1));
  await browser.close();
  server.close();
})();
