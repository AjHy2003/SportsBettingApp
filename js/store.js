// Saved picks and tickets in localStorage (per browser). Every item carries updatedAt
// and removals leave a short-lived marker, so a signed-in account can sync them.
const KEY = "picklab.picks.v1";
const TKEY = "picklab.tickets.v1";
const GONE = "picklab.removed.v1"; // { "pick_<id>": removedAt } until synced

const listeners = new Set();
// fn({ kind: "pick" | "ticket", remote }) after every save.
export const onStoreChange = (fn) => listeners.add(fn);
const emit = (kind, remote = false) => listeners.forEach((fn) => { try { fn({ kind, remote }); } catch { /* ignore */ } });

const read = (key) => { try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; } };
const content = ({ updatedAt, ...x }) => JSON.stringify(x);

// Stamp changed items, mark removed ones, then write.
function write(key, kind, list) {
  const before = new Map(read(key).map((x) => [x.id, x]));
  const now = Date.now();
  const next = list.map((x) => {
    const old = before.get(x.id);
    return old && content(old) === content(x) ? { ...x, updatedAt: old.updatedAt } : { ...x, updatedAt: now };
  });
  const keep = new Set(next.map((x) => x.id));
  const gone = loadRemoved();
  for (const id of before.keys()) if (!keep.has(id)) gone[`${kind}_${id}`] = now;
  try {
    localStorage.setItem(key, JSON.stringify(next));
    localStorage.setItem(GONE, JSON.stringify(gone));
  } catch { return false; }
  emit(kind);
  return true;
}

export function loadRemoved() {
  try { return JSON.parse(localStorage.getItem(GONE) || "{}"); } catch { return {}; }
}
export function forgetRemoved(keys) {
  const gone = loadRemoved();
  for (const k of keys) delete gone[k];
  try { localStorage.setItem(GONE, JSON.stringify(gone)); } catch { /* ignore */ }
}

// Write what came from the account as-is (no new timestamps, no removal markers).
export function replaceLocal(kind, list) {
  try { localStorage.setItem(kind === "pick" ? KEY : TKEY, JSON.stringify(list)); } catch { return; }
  emit(kind, true);
}

// Empty this browser's saved picks and tickets (after signing out).
export function clearLocal() {
  for (const k of [KEY, TKEY, GONE]) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  emit("pick", true);
  emit("ticket", true);
}

export function loadPicks() {
  return read(KEY);
}

export function savePicks(list) {
  return write(KEY, "pick", list);
}

export function addPick(p) {
  const list = loadPicks();
  list.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, created: new Date().toISOString(), result: null, ...p });
  return savePicks(list);
}

export function updatePick(id, patch) {
  const list = loadPicks().map((p) => (p.id === id ? { ...p, ...patch } : p));
  savePicks(list);
  return list;
}

export function removePick(id) {
  const list = loadPicks().filter((p) => p.id !== id);
  savePicks(list);
  return list;
}

// Tickets (a straight bet or a parlay, with its legs) for the live tracker.
export function loadTickets() {
  return read(TKEY);
}

export function saveTickets(list) {
  return write(TKEY, "ticket", list.slice(0, 200));
}

export function addTicket(t) {
  const list = loadTickets();
  const id = `t${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  list.unshift({ id, created: new Date().toISOString(), ...t });
  return saveTickets(list) ? id : null;
}

export function updateTicket(id, patch) {
  saveTickets(loadTickets().map((t) => (t.id === id ? { ...t, ...patch } : t)));
}

export function removeTicket(id) {
  saveTickets(loadTickets().filter((t) => t.id !== id));
}
