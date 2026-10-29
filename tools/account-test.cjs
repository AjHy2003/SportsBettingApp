// Accounts end to end against the Firebase emulators (auth :9099, firestore :8080):
// two browsers act as two devices on one account. Usage:
//   firebase emulators:exec --project demo-picklab --only auth,firestore "node tools/account-test.cjs <site_url> <firebase_sdk_dir> <out_dir>"
// <firebase_sdk_dir> (optional) is node_modules/firebase; its CDN builds stand in for gstatic.com.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const [site = "http://localhost:8765/", sdkDir, outDir = "account-out"] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const CONFIG = { apiKey: "demo-key", authDomain: "demo-picklab.firebaseapp.com", projectId: "demo-picklab", appId: "1:1:web:1", emulators: { auth: "http://127.0.0.1:9099", firestore: ["127.0.0.1", 8080] } };
const results = [];
const check = (name, ok, info = "") => { results.push({ name, ok: !!ok, info }); console.log(ok ? "PASS" : "FAIL", name, info); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function device(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // Without a local SDK folder the real gstatic.com files load.
  if (sdkDir) await ctx.route(/^https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/(.+)$/, (r) => {
    const file = path.join(sdkDir, new URL(r.request().url()).pathname.split("/").pop());
    if (!fs.existsSync(file)) return r.fulfill({ status: 404, body: "" });
    r.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(file) });
  });
  // Sports data isn't needed here.
  await ctx.route(/^https:\/\/(site|sports\.core)\.(web\.)?api\.espn\.com\//, (r) => r.fulfill({ status: 404, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{}" }));
  await ctx.addInitScript((c) => { globalThis.PICKLAB_FIREBASE = c; }, CONFIG);
  const pg = await ctx.newPage();
  pg.errors = [];
  pg.on("pageerror", (e) => pg.errors.push(e.message));
  pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_/.test(m.text())) pg.errors.push(m.text().slice(0, 200)); });
  pg.name = name;
  return pg;
}
const store = (pg) => pg.evaluate(() => ({
  picks: JSON.parse(localStorage.getItem("picklab.picks.v1") || "[]").map((p) => p.id).sort(),
  tickets: JSON.parse(localStorage.getItem("picklab.tickets.v1") || "[]").map((t) => t.id).sort(),
  bankroll: JSON.parse(localStorage.getItem("picklab.bankroll.v1") || "null"),
}));
const synced = (pg) => pg.waitForFunction(() => /Synced/.test(document.querySelector("[data-acct-status]")?.innerText || ""), null, { timeout: 30000 });
async function signIn(pg, email, pw, create = false) {
  await pg.click("#acct-btn");
  await pg.waitForSelector("#acct-form");
  if (create) await pg.click("[data-acct-mode]");
  await pg.fill("#acct-email", email);
  await pg.fill("#acct-pw", pw);
  await pg.click('#acct-form button[type="submit"]');
}

(async () => {
  const browser = await chromium.launch();
  const email = `fan${Date.now()}@example.com`, pw = "parlay123";
  const now = new Date().toISOString();
  const leg = { league: "nba", eventId: "1", eventDate: now, athlete: "LeBron James", marketLabel: "Points", line: 24.5, side: "OVER", odds: -110, prob: 0.58, grade: "B" };

  // Device A: bets saved before having an account, then create one.
  const A = await device(browser, "A");
  await A.goto(site + "#/picks");
  await A.evaluate(({ leg, now }) => {
    localStorage.setItem("picklab.picks.v1", JSON.stringify([{ id: "p1", created: now, result: null, ...leg }, { id: "p2", created: now, result: "W", ...leg, line: 20.5 }]));
    localStorage.setItem("picklab.tickets.v1", JSON.stringify([{ id: "t1", created: now, type: "parlay", stake: 10, american: 264, legs: [leg, { ...leg, athlete: "Anthony Davis" }] }]));
    localStorage.setItem("picklab.bankroll.v1", JSON.stringify({ bankroll: 500, dailyPct: 4 }));
  }, { leg, now });
  await A.reload();
  await A.waitForTimeout(800);
  check("signed-out banner on My bets", /Save your picks to an account/.test(await A.innerText("main")));
  await signIn(A, email, "123", true);
  await A.waitForSelector(".acct-modal .notice");
  check("short password rejected", /6 characters/.test(await A.innerText(".acct-modal")), await A.innerText(".acct-modal .notice"));
  await A.fill("#acct-pw", pw);
  await A.click('#acct-form button[type="submit"]');
  await A.waitForSelector(".acct-modal", { state: "detached", timeout: 30000 });
  await synced(A);
  check("account created and synced on A", /Synced/.test(await A.innerText("[data-acct-status]")), await A.innerText("[data-acct-status]"));
  check("header shows the account", await A.$eval("#acct-btn", (b) => b.classList.contains("in")));
  await A.screenshot({ path: path.join(outDir, "a-signed-in.png") });

  // Device B: fresh browser, sign in, everything arrives.
  const B = await device(browser, "B");
  await B.goto(site + "#/picks");
  await signIn(B, email, "wrong-password");
  await B.waitForSelector(".acct-modal .notice", { timeout: 30000 });
  check("wrong password message", /Wrong email or password/.test(await B.innerText(".acct-modal .notice")), await B.innerText(".acct-modal .notice"));
  await B.fill("#acct-pw", pw);
  await B.click('#acct-form button[type="submit"]');
  await B.waitForSelector(".acct-modal", { state: "detached", timeout: 30000 });
  await synced(B);
  await B.waitForTimeout(500);
  let sb = await store(B);
  check("B got A's picks", JSON.stringify(sb.picks) === '["p1","p2"]', JSON.stringify(sb.picks));
  check("B got A's ticket", JSON.stringify(sb.tickets) === '["t1"]', JSON.stringify(sb.tickets));
  check("B got A's bankroll", sb.bankroll?.bankroll === 500, JSON.stringify(sb.bankroll));
  check("B's My bets shows the parlay", /parlay/i.test(await B.innerText("main")));
  await B.screenshot({ path: path.join(outDir, "b-synced.png") });

  // B edits: removes the ticket, grades a pick, adds a pick. A picks them up.
  await B.evaluate(async () => {
    const s = await import("./js/store.js");
    s.removeTicket("t1");
    s.updatePick("p1", { result: "L" });
    s.addPick({ league: "nfl", athlete: "Ja'Marr Chase", marketLabel: "Receiving Yards", line: 74.5, side: "OVER", odds: -115 });
  });
  await B.waitForTimeout(3500);
  await A.click("#acct-btn");
  await A.click("[data-acct-sync]");
  await A.waitForTimeout(1500);
  await A.click(".acct-modal [data-close]").catch(() => {});
  let sa = await store(A);
  const aPicks = await A.evaluate(() => JSON.parse(localStorage.getItem("picklab.picks.v1")));
  check("ticket removed on B is gone on A", sa.tickets.length === 0, JSON.stringify(sa.tickets));
  check("pick added on B is on A", aPicks.some((p) => p.athlete === "Ja'Marr Chase"), String(aPicks.length));
  check("result edited on B is on A", aPicks.find((p) => p.id === "p1")?.result === "L");

  // Settings change on A reaches B.
  await A.evaluate(() => localStorage.setItem("picklab.books.v1", JSON.stringify({ books: ["fanduel"], state: "OH" })));
  await A.evaluate(async () => (await import("./js/account.js")).sync());
  await B.evaluate(async () => (await import("./js/account.js")).sync());
  check("book settings synced A → B", (await B.evaluate(() => JSON.parse(localStorage.getItem("picklab.books.v1") || "{}").state)) === "OH");

  // A removed ticket stays removed after B reloads (no resurrection).
  await B.reload();
  await synced(B);
  check("removed ticket stays removed after reload", (await store(B)).tickets.length === 0);

  // Privacy: another account can't read this one.
  const uidA = await A.evaluate(async () => (await import("./js/account.js")).currentUser().uid);
  const C = await device(browser, "C");
  await C.goto(site + "#/picks");
  await signIn(C, `other${Date.now()}@example.com`, pw, true);
  await C.waitForSelector(".acct-modal", { state: "detached", timeout: 30000 });
  await synced(C);
  const peek = await C.evaluate(async (uid) => {
    const fs = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
    try { const s = await fs.getDocs(fs.collection(fs.getFirestore(), "users", uid, "items")); return `read ${s.size}`; } catch (e) { return e.code || e.message; }
  }, uidA);
  check("other accounts can't read your data", /permission-denied/.test(peek), peek);
  check("new account starts empty", (await store(C)).picks.length === 0);

  // Sign out clears the device; signing back in restores it.
  A.once("dialog", (d) => d.accept());
  await A.click("#acct-btn");
  await A.click("[data-acct-out]");
  await A.waitForTimeout(1500);
  sa = await store(A);
  check("sign out clears this device", sa.picks.length === 0 && sa.tickets.length === 0 && !sa.bankroll, JSON.stringify(sa));
  await A.click(".acct-modal [data-close]").catch(() => {});
  await A.goto(site + "#/picks");
  await A.waitForTimeout(500);
  check("signed-out banner back", /Save your picks to an account/.test(await A.innerText("main")));
  await signIn(A, email, pw);
  await A.waitForSelector(".acct-modal", { state: "detached", timeout: 30000 });
  await synced(A);
  await A.waitForTimeout(500);
  sa = await store(A);
  check("signing back in restores picks and bankroll", sa.picks.length === 3 && sa.bankroll?.bankroll === 500, JSON.stringify(sa));

  for (const pg of [A, B, C]) check(`no page errors on ${pg.name}`, !pg.errors.length, pg.errors.join(" | "));
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 1));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
