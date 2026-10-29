// Saved picks in localStorage (per browser).
const KEY = "picklab.picks.v1";

export function loadPicks() {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}

export function savePicks(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
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
const TKEY = "picklab.tickets.v1";

export function loadTickets() {
  try { return JSON.parse(localStorage.getItem(TKEY) || "[]"); } catch { return []; }
}

export function saveTickets(list) {
  try { localStorage.setItem(TKEY, JSON.stringify(list.slice(0, 200))); return true; } catch { return false; }
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
