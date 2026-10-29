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
