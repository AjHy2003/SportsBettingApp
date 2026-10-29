// Accounts: sign in with email (or Google) and your saved picks, bets, bankroll and
// sportsbook settings sync through Firebase, so they're on every device you sign in on.
// Without a config in firebase-config.js everything stays in this browser, as before.
import { FIREBASE } from "./firebase-config.js";
import { loadPicks, loadTickets, loadRemoved, forgetRemoved, replaceLocal, clearLocal, onStoreChange } from "./store.js";
import { esc, toast } from "./ui.js";

const SDK = "https://www.gstatic.com/firebasejs/10.14.1";
const SETTINGS = ["picklab.books.v1", "picklab.bankroll.v1", "picklab.today.v1", "picklab.news.v1"];
const OWNER = "picklab.account.owner"; // whose account this browser's data belongs to
const SYNC = "picklab.account.sync"; // { uid, lastPull, cloud: { key: updatedAt }, settings, settingsAt }

const cfg = () => globalThis.PICKLAB_FIREBASE || FIREBASE;
export const accountsEnabled = () => !!cfg()?.apiKey;

let fb = null, loading = null, user = null;
let syncing = false, lastSync = null, syncError = null, queue = Promise.resolve(), pushTimer = null, pullTimer = null;

export const currentUser = () => user;
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// Firebase loads only once someone uses accounts on this browser.
function load() {
  if (fb) return Promise.resolve(fb);
  loading ||= Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`)]).then(([app, auth, fs]) => {
    const c = cfg();
    const a = app.initializeApp(c);
    const au = auth.getAuth(a);
    const db = fs.getFirestore(a);
    if (c.emulators) {
      auth.connectAuthEmulator(au, c.emulators.auth, { disableWarnings: true });
      fs.connectFirestoreEmulator(db, c.emulators.firestore[0], c.emulators.firestore[1]);
    }
    fb = { au, db, auth, fs };
    auth.onAuthStateChanged(au, (u) => { const was = user?.uid; user = u; if (u && u.uid !== was) startSync(); if (!u) stopSync(); paint(); });
    return fb;
  });
  return loading;
}

export function initAccount() {
  document.addEventListener("click", (e) => { if (e.target.closest("[data-account]")) { e.preventDefault(); openAccount(); } });
  onStoreChange(({ remote }) => { if (!remote && user) schedulePush(); });
  document.addEventListener("visibilitychange", () => {
    if (!user) return;
    if (document.visibilityState === "visible") sync(); else flush();
  });
  paint();
  // Someone has signed in here before: reconnect in the background.
  if (accountsEnabled() && ls.get(OWNER)) load().catch((e) => { syncError = e; paint(); });
}

// ---------- sync ----------
const state = () => { try { return JSON.parse(ls.get(SYNC) || "null"); } catch { return null; } };
const saveState = (s) => ls.set(SYNC, JSON.stringify(s));
const settingsNow = () => JSON.stringify(Object.fromEntries(SETTINGS.map((k) => [k, ls.get(k)])));
const stamp = (x) => x.updatedAt || Date.parse(x.created) || 1;
const docKey = (kind, id) => `${kind}_${String(id).replace(/\//g, "_")}`;

function startSync() {
  // Data from a different account on this browser isn't merged into this one.
  const owner = ls.get(OWNER);
  if (owner && owner !== user.uid) { clearLocal(); for (const k of SETTINGS) ls.del(k); }
  ls.set(OWNER, user.uid);
  let s = state();
  if (s?.uid !== user.uid) saveState({ uid: user.uid, lastPull: 0, cloud: {}, settings: null, settingsAt: 0 });
  clearInterval(pullTimer);
  pullTimer = setInterval(() => { if (document.visibilityState === "visible") sync(); }, 60e3);
  sync();
}

function stopSync() {
  clearInterval(pullTimer);
  clearTimeout(pushTimer);
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => run(push), 1200);
}

// One sync at a time.
function run(fn) {
  queue = queue.then(async () => {
    if (!user) return;
    syncing = true; paint();
    try { await fn(); syncError = null; lastSync = Date.now(); } catch (e) { syncError = e; console.warn("account sync:", e); }
    syncing = false; paint();
  });
  return queue;
}
export const sync = () => run(async () => { await pull(); await push(); });
const flush = () => { clearTimeout(pushTimer); return run(push); };

const items = () => fb.fs.collection(fb.db, "users", user.uid, "items");

// Bring in everything that changed in the account since the last pull. Newest edit wins.
async function pull() {
  const { fs } = fb;
  const s = state();
  const q = s.lastPull ? fs.query(items(), fs.where("syncedAt", ">", fs.Timestamp.fromMillis(s.lastPull - 5000))) : items();
  const snap = await fs.getDocs(q);
  if (!snap.size) return;
  const lists = { pick: new Map(loadPicks().map((x) => [x.id, x])), ticket: new Map(loadTickets().map((x) => [x.id, x])) };
  const gone = loadRemoved(), forget = [];
  const changed = new Set();
  let maxT = s.lastPull;
  for (const d of snap.docs) {
    const r = d.data({ serverTimestamps: "estimate" });
    maxT = Math.max(maxT, r.syncedAt?.toMillis?.() || 0);
    s.cloud[d.id] = Math.max(s.cloud[d.id] || 0, r.updatedAt || 0);
    if (r.kind === "settings") {
      if (r.updatedAt > (s.settingsAt || 0)) {
        const vals = JSON.parse(r.data || "{}");
        for (const k of SETTINGS) { if (vals[k] != null) ls.set(k, vals[k]); else ls.del(k); }
        s.settingsAt = r.updatedAt;
        s.settings = settingsNow();
        changed.add("settings");
      }
      continue;
    }
    const list = lists[r.kind];
    if (!list) continue;
    const mine = list.get(r.id);
    const mineAt = mine ? stamp(mine) : gone[d.id] || 0;
    if (r.updatedAt <= mineAt) continue;
    if (r.deleted) list.delete(r.id);
    else list.set(r.id, { ...JSON.parse(r.data), updatedAt: r.updatedAt });
    if (gone[d.id]) forget.push(d.id);
    changed.add(r.kind);
  }
  const newest = (a, b) => new Date(b.created) - new Date(a.created);
  if (changed.has("pick")) replaceLocal("pick", [...lists.pick.values()].sort(newest));
  if (changed.has("ticket")) replaceLocal("ticket", [...lists.ticket.values()].sort(newest));
  if (forget.length) forgetRemoved(forget);
  s.lastPull = maxT;
  saveState(s);
  if (changed.size) window.dispatchEvent(new CustomEvent("picklab:synced", { detail: { changed: [...changed] } }));
}

// Send everything this browser has that the account doesn't (new, edited or removed).
async function push() {
  const { fs } = fb;
  const s = state();
  const writes = [];
  for (const [kind, list] of [["pick", loadPicks()], ["ticket", loadTickets()]]) {
    for (const x of list) {
      const key = docKey(kind, x.id), at = stamp(x);
      if ((s.cloud[key] || 0) >= at) continue;
      const { updatedAt, ...data } = x;
      writes.push({ key, at, doc: { kind, id: x.id, data: JSON.stringify(data), deleted: false, updatedAt: at } });
    }
  }
  const gone = loadRemoved();
  for (const [key, at] of Object.entries(gone)) {
    if ((s.cloud[key] || 0) >= at) continue;
    const [kind, ...rest] = key.split("_");
    writes.push({ key, at, doc: { kind, id: rest.join("_"), data: null, deleted: true, updatedAt: at } });
  }
  const set = settingsNow();
  if (set !== s.settings) {
    const at = Date.now();
    writes.push({ key: "settings", at, doc: { kind: "settings", id: "settings", data: set, deleted: false, updatedAt: at }, settings: set });
  }
  for (let i = 0; i < writes.length; i += 400) {
    const batch = fs.writeBatch(fb.db);
    for (const w of writes.slice(i, i + 400)) batch.set(fs.doc(items(), w.key), { ...w.doc, syncedAt: fs.serverTimestamp() });
    await batch.commit();
    for (const w of writes.slice(i, i + 400)) {
      s.cloud[w.key] = w.at;
      if (w.settings) { s.settings = w.settings; s.settingsAt = w.at; }
    }
    saveState(s);
  }
  forgetRemoved(writes.filter((w) => w.doc.deleted).map((w) => w.key));
}

// ---------- sign in / out ----------
const MESSAGES = {
  "auth/invalid-email": "That email doesn't look right.",
  "auth/missing-password": "Enter a password.",
  "auth/weak-password": "Use at least 6 characters for the password.",
  "auth/email-already-in-use": "There's already an account with that email. Sign in instead.",
  "auth/invalid-credential": "Wrong email or password.",
  "auth/invalid-login-credentials": "Wrong email or password.",
  "auth/wrong-password": "Wrong email or password.",
  "auth/user-not-found": "No account with that email. Create one instead.",
  "auth/too-many-requests": "Too many tries. Wait a minute and try again.",
  "auth/network-request-failed": "Couldn't reach the account server. Check your connection.",
  "auth/popup-blocked": "Your browser blocked the Google window. Allow pop-ups, or use email and password.",
  "auth/popup-closed-by-user": "The Google window was closed before signing in.",
  "auth/operation-not-allowed": "This sign-in method isn't switched on yet (Firebase → Authentication → Sign-in method).",
  "auth/unauthorized-domain": "This site isn't on the account service's allowed list yet (Firebase → Authentication → Settings → Authorized domains).",
  "permission-denied": "Your account blocked the save. The Firestore rules need updating (see the README's Accounts section).",
};
const friendly = (e) => MESSAGES[e?.code] || e?.message || "Something went wrong.";

async function signIn(mode, email, password) {
  const { au, auth } = await load();
  if (mode === "google") return auth.signInWithPopup(au, new auth.GoogleAuthProvider());
  if (mode === "create") return auth.createUserWithEmailAndPassword(au, email, password);
  return auth.signInWithEmailAndPassword(au, email, password);
}

async function signOut() {
  if (!confirm("Sign out? Your picks and bets stay saved in your account; this device is cleared until you sign in again.")) return;
  await flush();
  await fb.auth.signOut(fb.au);
  clearLocal();
  for (const k of [...SETTINGS, OWNER, SYNC]) ls.del(k);
  lastSync = null;
  window.dispatchEvent(new CustomEvent("picklab:synced", { detail: { changed: ["pick", "ticket", "settings"] } }));
  toast("Signed out");
}

// ---------- UI ----------
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 10 ? "just now" : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)}h ago`; };
export function syncLine() {
  if (!user) return "";
  return syncError ? `⚠️ ${esc(friendly(syncError))}` : syncing ? "Syncing…" : lastSync ? `☁️ Synced ${ago(lastSync)}` : "☁️ Connected";
}

// Header button: who's signed in, or "Sign in".
function paint() {
  const b = document.querySelector("#acct-btn");
  if (b) {
    b.classList.toggle("in", !!user);
    b.innerHTML = user
      ? `<span class="avatar">${esc((user.email || user.displayName || "?")[0].toUpperCase())}</span>`
      : `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span class="acct-lbl">Sign in</span>`;
    b.title = user ? `Signed in as ${user.email || user.displayName}` : "Sign in to save your picks to an account";
  }
  document.querySelectorAll("[data-acct-status]").forEach((el) => { el.innerHTML = accountBanner(); });
  const m = document.querySelector(".acct-modal");
  if (m && !m.contains(document.activeElement)) m.querySelector(".pm-box").innerHTML = modalBody();
}

// Small banner for My bets.
export function accountBanner() {
  if (user) return `<span class="small muted">${syncLine()} · ${esc(user.email || user.displayName || "")}</span>`;
  return `<div class="acct-banner"><div><b>☁️ Save your picks to an account</b><div class="small muted">Sign in and your bets, picks, bankroll and books are saved and show up on every device.</div></div><button class="btn sm" data-account>Sign in</button></div>`;
}

let mode = "signin", busy = false, err = "", typed = { email: "", pw: "" };
function modalBody() {
  const close = `<button class="icon-btn" data-close aria-label="Close">✕</button>`;
  if (!accountsEnabled()) {
    return `<div class="row" style="justify-content:space-between"><h3 style="margin:0">☁️ Accounts</h3>${close}</div>
      <p class="muted small">Accounts need a one-time setup by the site owner: a free Firebase project (about 5 minutes, steps in the README under "Accounts"). Until then your picks and bets are saved in this browser, and ⬇ Back up on My bets moves them to another device.</p>`;
  }
  if (user) {
    const p = loadPicks().length, t = loadTickets().length;
    return `<div class="row" style="justify-content:space-between"><h3 style="margin:0">☁️ My account</h3>${close}</div>
      <div class="acct-who"><span class="avatar lg">${esc((user.email || "?")[0].toUpperCase())}</span><div><b>${esc(user.email || user.displayName || "")}</b><div class="small muted">${syncLine()}</div></div></div>
      <p class="small muted" style="margin:10px 0">${t} bet${t === 1 ? "" : "s"} and ${p} pick${p === 1 ? "" : "s"} saved, plus your bankroll, sportsbooks and Today settings. Sign in with this email on any phone or computer to see them.</p>
      <div class="row"><button class="btn ghost sm" data-acct-sync>↻ Sync now</button><span class="spacer"></span><button class="btn ghost sm" data-acct-out>Sign out</button></div>`;
  }
  const create = mode === "create";
  return `<div class="row" style="justify-content:space-between"><h3 style="margin:0">☁️ ${create ? "Create your account" : "Sign in"}</h3>${close}</div>
    <p class="small muted" style="margin:6px 0 12px">Your bets, picks, bankroll and sportsbooks are saved to your account and show up on every device you sign in on.${loadPicks().length + loadTickets().length ? " What's already saved in this browser is added to it." : ""}</p>
    <form id="acct-form" class="acct-form" novalidate>
      <div class="field"><label for="acct-email">Email</label><input id="acct-email" type="email" autocomplete="email" required inputmode="email" value="${esc(typed.email)}"/></div>
      <div class="field"><label for="acct-pw">Password${create ? " (6+ characters)" : ""}</label><input id="acct-pw" type="password" autocomplete="${create ? "new-password" : "current-password"}" required minlength="6" value="${esc(typed.pw)}"/></div>
      ${err ? `<div class="notice warn small">${esc(err)}</div>` : ""}
      <button class="btn" type="submit" ${busy ? "disabled" : ""}>${busy ? "One moment…" : create ? "Create account" : "Sign in"}</button>
      <button class="btn ghost" type="button" data-acct-google ${busy ? "disabled" : ""}><b style="color:#4285f4">G</b> Continue with Google</button>
      <div class="row small" style="justify-content:space-between">
        <button class="linkbtn" type="button" data-acct-mode style="margin:0">${create ? "Have an account? Sign in" : "New here? Create an account"}</button>
        ${create ? "" : `<button class="linkbtn" type="button" data-acct-reset style="margin:0">Forgot password?</button>`}
      </div>
    </form>`;
}

export function openAccount() {
  document.querySelector(".acct-modal")?.remove();
  mode = "signin"; err = ""; busy = false; typed = { email: "", pw: "" };
  const el = document.createElement("div");
  el.className = "player-modal acct-modal";
  el.innerHTML = `<div class="pm-box" style="max-width:420px">${modalBody()}</div>`;
  document.body.appendChild(el);
  if (accountsEnabled()) load().catch((e) => { err = friendly(e); rerender(); });
  const box = el.querySelector(".pm-box");
  const rerender = () => { box.innerHTML = modalBody(); };
  const attempt = async (fn) => {
    busy = true; err = ""; rerender();
    try { await fn(); el.remove(); typed = { email: "", pw: "" }; toast(`Signed in · syncing your picks`); } catch (e) { err = friendly(e); busy = false; rerender(); }
  };
  el.addEventListener("click", async (e) => {
    if (e.target === el || e.target.closest("[data-close]")) return el.remove();
    if (e.target.closest("[data-acct-mode]")) { mode = mode === "create" ? "signin" : "create"; err = ""; return rerender(); }
    if (e.target.closest("[data-acct-google]")) return attempt(() => signIn("google"));
    if (e.target.closest("[data-acct-sync]")) { await sync(); return rerender(); }
    if (e.target.closest("[data-acct-out]")) { await signOut(); return rerender(); }
    if (e.target.closest("[data-acct-reset]")) {
      const email = box.querySelector("#acct-email")?.value.trim();
      if (!email) { err = "Type your email above, then tap Forgot password."; return rerender(); }
      try { const { au, auth } = await load(); await auth.sendPasswordResetEmail(au, email); toast("Check your email for a reset link"); } catch (e2) { err = friendly(e2); rerender(); }
    }
  });
  // Keep what's typed so a redraw (an error, the account service loading) doesn't clear it.
  el.addEventListener("input", (e) => {
    if (e.target.id === "acct-email") typed.email = e.target.value;
    if (e.target.id === "acct-pw") typed.pw = e.target.value;
  });
  el.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = box.querySelector("#acct-email").value.trim(), pw = box.querySelector("#acct-pw").value;
    attempt(() => signIn(mode === "create" ? "create" : "signin", email, pw));
  });
}
