// Does one DraftKings link put several legs in the slip? Loads variants and records what shows.
const { chromium } = require("playwright");
const fs = require("fs");
const out = process.argv[2] || "dk-out";
fs.mkdirSync(out, { recursive: true });
(async () => {
  const today = await (await fetch("https://ajhy2003.github.io/SportsBettingApp/data/picks/today.json")).json();
  const legs = today.legs.filter((l) => l.dkExact && new Date(l.start) > Date.now());
  const a = legs[0], b = legs.find((l) => l.eventId !== a.eventId);
  const oc = (l) => new URL(l.dk).searchParams.get("outcomes");
  const ev = (l) => new URL(l.dk).pathname.split("/").pop();
  const variants = {
    single: a.dk,
    plus: `https://sportsbook.draftkings.com/event/${ev(a)}?outcomes=${oc(a)}+${oc(b)}`,
    encodedPlus: `https://sportsbook.draftkings.com/event/${ev(a)}?outcomes=${encodeURIComponent(`${oc(a)}+${oc(b)}`)}`,
    comma: `https://sportsbook.draftkings.com/event/${ev(a)}?outcomes=${oc(a)},${oc(b)}`,
  };
  const browser = await chromium.launch({ channel: "chrome" });
  const res = { legs: [a.label, b.label], variants: {} };
  for (const [k, url] of Object.entries(variants)) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "America/New_York", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36" });
    const pg = await ctx.newPage();
    let status = null;
    try { const r = await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }); status = r?.status(); } catch (e) { status = e.message.slice(0, 120); }
    await pg.waitForTimeout(12000);
    const text = (await pg.innerText("body").catch(() => "")).replace(/\s+/g, " ");
    const slip = await pg.$$eval('[class*="betslip" i], [data-testid*="betslip" i], [id*="betslip" i]', (x) => x.map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 300))).catch(() => []);
    res.variants[k] = { url, finalUrl: pg.url(), status, title: await pg.title().catch(() => ""), slip: slip.slice(0, 5), text: text.slice(0, 1500) };
    await pg.screenshot({ path: `${out}/${k}.png` }).catch(() => {});
    await ctx.close();
  }
  fs.writeFileSync(`${out}/dk.json`, JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1).slice(0, 3000));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(0); });
