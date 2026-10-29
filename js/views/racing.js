import { getJSON, pool } from "../espn.js";
import * as M from "../model.js";
import { esc, loading, errorBox, setTitle, pct, fx, fmtDate, gameChart, wireChartTips, toast } from "../ui.js";
import { addPick } from "../store.js";

const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const NASCAR = "https://cf.nascar.com";
const ESPN_SB = "https://site.web.api.espn.com/apis/site/v2/sports";
const SIMS = 5000;

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

// ---------- loaders: all return { races:[...], next } with races oldest -> newest ----------
async function jolpicaSeason(season) {
  const first = await getJSON(`${JOLPICA}/${season}/results.json?limit=100&offset=0`, 30 * 60e3);
  const total = Number(first.MRData.total);
  const pages = [first];
  for (let off = 100; off < total; off += 100) pages.push(await getJSON(`${JOLPICA}/${season}/results.json?limit=100&offset=${off}`, 30 * 60e3));
  const byRound = new Map();
  for (const p of pages) for (const r of p.MRData.RaceTable.Races) {
    const cur = byRound.get(r.round) || { ...r, Results: [] };
    cur.Results.push(...r.Results);
    byRound.set(r.round, cur);
  }
  return [...byRound.values()].map((r) => ({
    key: `${season}-${r.round}`, season: Number(season), round: Number(r.round), name: r.raceName,
    track: r.Circuit.circuitName, trackId: r.Circuit.circuitId, date: `${r.date}T${r.time || "12:00:00Z"}`,
    results: r.Results.map((x) => ({
      id: x.Driver.driverId, name: `${x.Driver.givenName} ${x.Driver.familyName}`, team: x.Constructor.name,
      pos: Number(x.position), grid: Number(x.grid) || null, status: x.status,
      dnf: !/Finished|Lap/.test(x.status), points: Number(x.points),
    })),
  }));
}

async function loadF1() {
  const sched = await getJSON(`${JOLPICA}/current.json`, 60 * 60e3);
  const season = Number(sched.MRData.RaceTable.season);
  const [cur, prev] = await Promise.all([jolpicaSeason(season), jolpicaSeason(season - 1).catch(() => [])]);
  const done = new Set(cur.map((r) => r.round));
  const upcoming = sched.MRData.RaceTable.Races.find((r) => !done.has(Number(r.round)));
  let next = null;
  if (upcoming) {
    next = { name: upcoming.raceName, track: upcoming.Circuit.circuitName, trackId: upcoming.Circuit.circuitId, date: `${upcoming.date}T${upcoming.time || "12:00:00Z"}`, round: Number(upcoming.round) };
    try {
      const q = await getJSON(`${JOLPICA}/${season}/${upcoming.round}/qualifying.json`, 10 * 60e3);
      const qr = q.MRData.RaceTable.Races[0]?.QualifyingResults || [];
      if (qr.length) next.grid = Object.fromEntries(qr.map((x) => [x.Driver.driverId, Number(x.position)]));
    } catch { /* no qualifying yet */ }
  }
  return { series: "Formula 1", races: [...prev, ...cur], next, season };
}

async function loadNascar() {
  // Pipeline file has full multi-season history incl. loop data; fall back to live recent races.
  try {
    const r = await fetch("data/nascar/summary.json", { cache: "no-cache" });
    if (r.ok) return await r.json();
  } catch { /* fall through */ }
  const year = new Date().getFullYear();
  const list = await getJSON(`${NASCAR}/cacher/${year}/1/race_list_basic.json`, 30 * 60e3);
  const done = list.filter((r) => r.winner_driver_id && r.race_type_id === 1).slice(-12);
  const races = (await pool(done, 4, async (r) => {
    const w = await getJSON(`${NASCAR}/cacher/${year}/1/${r.race_id}/weekend-feed.json`, 60 * 60e3);
    const wr = w.weekend_race?.[0];
    return {
      key: `${year}-${r.race_id}`, season: year, name: r.race_name, track: r.track_name, trackId: String(r.track_id), date: r.race_date,
      superspeedway: !!r.restrictor_plate,
      results: (wr?.results || []).map((x) => ({ id: String(x.driver_id), name: x.driver_fullname, team: x.team_name, pos: x.finishing_position, grid: x.starting_position, status: x.finishing_status, dnf: x.finishing_status !== "Running", lapsLed: x.laps_led })),
    };
  })).filter((r) => r && !r.error);
  const up = list.find((r) => !r.winner_driver_id && r.race_type_id === 1 && new Date(r.race_date) > Date.now() - 864e5);
  const next = up ? { name: up.race_name, track: up.track_name, trackId: String(up.track_id), date: up.race_date, superspeedway: !!up.restrictor_plate } : null;
  return { series: "NASCAR Cup", races, next, season: year, partial: true };
}

async function loadEspnRacing(L) {
  const sb = await getJSON(`${ESPN_SB}/${L.espn}/scoreboard`, 10 * 60e3);
  const cal = sb.leagues?.[0]?.calendar || [];
  const now = Date.now();
  const past = cal.filter((c) => new Date(c.endDate || c.startDate) < now);
  const races = (await pool(past, 4, async (c) => {
    const d = new Date(c.startDate);
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    const s = await getJSON(`${ESPN_SB}/${L.espn}/scoreboard?dates=${ymd}`, 60 * 60e3);
    const e = s.events?.[0];
    const comp = e?.competitions?.find((x) => !x.type || /race/i.test(x.type.abbreviation || "")) || e?.competitions?.[0];
    if (!comp) return null;
    return {
      key: e.id, season: d.getUTCFullYear(), name: c.label, track: e.circuit?.fullName || c.label, trackId: norm(c.label), date: c.startDate,
      results: comp.competitors.map((x) => ({ id: x.id, name: x.athlete?.displayName, team: x.team?.displayName || "", pos: x.order })),
    };
  })).filter((r) => r && !r.error && r.results?.length);
  const up = cal.find((c) => new Date(c.startDate) > now);
  return { series: L.name, races, next: up ? { name: up.label, track: up.label, trackId: norm(up.label), date: up.startDate } : null };
}

// ---------- model ----------
function driverTable(data) {
  const races = data.races;
  const latestSeason = Math.max(...races.map((r) => r.season));
  const drivers = new Map();
  races.forEach((r) => {
    const field = r.results.length;
    for (const x of r.results) {
      const d = drivers.get(x.id) || { id: x.id, name: x.name, team: x.team, starts: [] };
      d.name = x.name;
      if (r.season === latestSeason) d.team = x.team || d.team;
      d.starts.push({ ...x, field, race: r.name, track: r.track, trackId: r.trackId, date: r.date, season: r.season, superspeedway: r.superspeedway, event: r.key });
      drivers.set(x.id, d);
    }
  });
  // Only drivers who raced in the latest season.
  const active = [...drivers.values()].filter((d) => d.starts.some((s) => s.season === latestSeason));
  for (const d of active) {
    d.starts.sort((a, b) => new Date(b.date) - new Date(a.date));
    const cur = d.starts.filter((s) => s.season === latestSeason);
    d.season = {
      n: cur.length, wins: cur.filter((s) => s.pos === 1).length, top3: cur.filter((s) => s.pos <= 3).length,
      top5: cur.filter((s) => s.pos <= 5).length, top10: cur.filter((s) => s.pos <= 10).length,
      avg: M.mean(cur.map((s) => s.pos)), dnf: cur.filter((s) => s.dnf).length,
      avgStart: M.mean(cur.map((s) => s.grid).filter(Boolean)),
      lapsLed: cur.reduce((t, s) => t + (s.lapsLed || 0), 0),
      rating: M.mean(cur.map((s) => s.rating).filter((v) => v != null)),
    };
    const track = data.next ? d.starts.filter((s) => s.trackId === data.next.trackId) : [];
    d.track = { n: track.length, avg: M.mean(track.map((s) => s.pos)), best: track.length ? Math.min(...track.map((s) => s.pos)) : null };
    const typeMatch = data.next?.superspeedway != null ? d.starts.filter((s) => s.superspeedway === data.next.superspeedway).slice(0, 12) : [];
    d.type = { n: typeMatch.length, avg: M.mean(typeMatch.map((s) => s.pos)) };
    // Expected finish: recent form, then track history, then track type.
    const recent = d.starts.slice(0, 12).map((s) => s.pos);
    let mu = M.ewma(recent, 5);
    if (d.track.n >= 2) mu = 0.7 * mu + 0.3 * d.track.avg;
    if (data.next?.superspeedway && d.type.n >= 3) mu = 0.6 * mu + 0.4 * d.type.avg;
    if (data.next?.grid?.[d.id]) mu = 0.55 * mu + 0.45 * data.next.grid[d.id];
    // Few starts: pull toward mid-field.
    const field = M.mean(d.starts.slice(0, 12).map((s) => s.field)) || 20;
    const n = Math.min(recent.length, 12);
    d.mu = (n * mu + 2 * (field * 0.6)) / (n + 2);
    d.sd = Math.max(2.5, recent.length >= 3 ? M.stdev(recent) : field / 3);
    d.dnfRate = (d.starts.slice(0, 20).filter((s) => s.dnf).length + 0.5) / (Math.min(d.starts.length, 20) + 5);
  }
  return { drivers: active, latestSeason };
}

function simulate(drivers, sims = SIMS) {
  const n = drivers.length;
  const counts = drivers.map(() => ({ win: 0, top3: 0, top5: 0, top10: 0, sumPos: 0 }));
  const posOf = new Float64Array(n);
  const ahead = new Map(); // "i|j" -> times i ahead of j
  const score = new Float64Array(n);
  const idx = Array.from({ length: n }, (_, i) => i);
  const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const pairs = [];
  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < n; i++) {
      const d = drivers[i];
      score[i] = Math.random() < d.dnfRate ? 1000 + Math.random() : d.mu + d.sd * randn();
    }
    idx.sort((a, b) => score[a] - score[b]);
    for (let p = 0; p < n; p++) {
      const i = idx[p];
      posOf[i] = p + 1;
      const c = counts[i];
      if (p === 0) c.win++;
      if (p < 3) c.top3++;
      if (p < 5) c.top5++;
      if (p < 10) c.top10++;
      c.sumPos += p + 1;
    }
    if (s < 2000) pairs.push(Float64Array.from(posOf));
  }
  drivers.forEach((d, i) => {
    const c = counts[i];
    d.p = { win: c.win / sims, top3: c.top3 / sims, top5: c.top5 / sims, top10: c.top10 / sims, avgPos: c.sumPos / sims };
  });
  return { h2h: (i, j) => pairs.reduce((t, row) => t + (row[i] < row[j] ? 1 : 0), 0) / pairs.length };
}

// ---------- view ----------
export async function renderRacing(ctx, L, q) {
  const { app } = ctx;
  setTitle(L.name);
  app.innerHTML = `<div class="crumbs"><a href="#/">Home</a> › ${esc(L.name)}</div><h1>${L.icon} ${esc(L.name)}</h1>${loading("Loading race results…")}`;
  let data;
  try {
    data = L.id === "f1" ? await loadF1() : L.id === "nascar" ? await loadNascar() : await loadEspnRacing(L);
  } catch (e) {
    if (ctx.alive()) app.innerHTML += errorBox(e);
    return;
  }
  if (!ctx.alive()) return;
  if (!data.races?.length) { app.innerHTML += `<div class="notice">No completed races found yet.</div>`; return; }

  const { drivers } = driverTable(data);
  const sim = simulate(drivers);
  drivers.sort((a, b) => b.p.win - a.p.win || a.mu - b.mu);
  const focus = q.driver ? drivers.find((d) => norm(d.name) === norm(q.driver)) || drivers.find((d) => norm(d.name).includes(norm(q.driver).slice(-6))) : null;
  const nx = data.next;
  const hasGrid = nx?.grid && Object.keys(nx.grid).length;

  app.innerHTML = `
    <div class="crumbs"><a href="#/">Home</a> › ${esc(L.name)}</div>
    <h1>${L.icon} ${esc(L.name)}</h1>
    <div class="card">
      ${nx ? `<div class="row" style="justify-content:space-between"><div><h2 style="margin:0">Next: ${esc(nx.name)}</h2><div class="muted small">${esc(nx.track)} · ${fmtDate(nx.date, { weekday: "short", month: "short", day: "numeric" })}</div></div>
        <div class="small muted">${hasGrid ? `<span class="pill gold">Qualifying in: grid used</span>` : "Probabilities update once qualifying is posted."}${data.partial ? ` · <span class="pill">Recent races only</span>` : ""}</div></div>` : `<div class="muted">Season complete — table shows season form.</div>`}
    </div>
    <div class="grid two" style="margin-top:14px">
      <div class="card">
        <h3>Bet checker</h3>
        <div class="form-row">
          <div class="field"><label>Driver</label><select id="r-d">${drivers.map((d) => `<option value="${esc(d.id)}" ${focus && focus.id === d.id ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select></div>
          <div class="field"><label>Market</label><select id="r-m"><option value="win">Win</option><option value="top3">Podium / Top 3</option><option value="top5">Top 5</option><option value="top10">Top 10</option><option value="h2h">Head to head</option></select></div>
          <div class="field hidden" id="r-vs-f"><label>vs</label><select id="r-vs">${drivers.map((d, i) => `<option value="${esc(d.id)}" ${i === 1 ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select></div>
          <div class="field"><label>Odds</label><input id="r-o" type="number" placeholder="+250"/></div>
        </div>
        <div id="r-out" style="margin-top:12px"></div>
      </div>
      <div class="card" id="r-driver"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3>Field · ${SIMS.toLocaleString()} simulated races</h3>
      <div class="table-wrap"><table><thead><tr><th>Driver</th><th class="r">Win</th><th class="r">Top 3</th><th class="r">Top 5</th><th class="r">Top 10</th><th class="r">Fair win</th><th class="r">Avg fin</th><th class="r">${nx ? "At track" : ""}</th><th class="r">Wins</th><th class="r">DNF</th><th>Last 5</th></tr></thead><tbody>
      ${drivers.map((d) => `<tr data-d="${esc(d.id)}" style="cursor:pointer" class="${focus?.id === d.id ? "hl" : ""}"><td><b>${esc(d.name)}</b> <span class="faint">${esc(d.team || "")}</span>${hasGrid && nx.grid[d.id] ? ` <span class="pill">P${nx.grid[d.id]}</span>` : ""}</td>
        <td class="r">${pct(d.p.win, 1)}</td><td class="r">${pct(d.p.top3)}</td><td class="r">${pct(d.p.top5)}</td><td class="r">${pct(d.p.top10)}</td>
        <td class="r">${d.p.win >= 0.005 ? M.fmtOdds(M.toAmerican(Math.min(0.99, d.p.win))) : "—"}</td><td class="r">${fx(d.season.avg)}</td><td class="r">${d.track.n ? `${fx(d.track.avg)} <span class="faint">(${d.track.n})</span>` : "—"}</td>
        <td class="r">${d.season.wins}</td><td class="r">${d.season.dnf}</td><td>${d.starts.slice(0, 5).map((s) => `<span class="pill" title="${esc(s.race)}">${s.pos}</span>`).join(" ")}</td></tr>`).join("")}
      </tbody></table></div>
      <details class="explain" style="margin-top:10px"><summary>How this is calculated</summary>
        <p>Each driver's expected finish blends recent results (newest weigh most), history at this track${L.id === "nascar" ? ", superspeedway form when relevant" : ""} and the qualifying grid once it's posted. Small samples are pulled toward mid-pack. Each simulated race adds driver-specific randomness and a crash/DNF chance from their recent DNF rate, then counts how often each driver wins, podiums or finishes top 10.</p>
      </details>
    </div>`;

  const $ = (s) => app.querySelector(s);
  wireChartTips(app);
  const byId = (id) => drivers.findIndex((d) => d.id === id);

  function showDriver(id) {
    const d = drivers[byId(id)];
    if (!d) return;
    const short = (s) => (s.race || s.track || "").replace(/^(the|formula 1|nascar cup series at)\s+/i, "").replace(/grand prix|gp\b/i, "").trim().slice(0, 6);
    const games = d.starts.slice(0, 16).map((s) => ({ value: s.pos, date: s.date, opp: short(s), home: true, result: s.dnf ? "DNF" : "", score: s.race }));
    $("#r-driver").innerHTML = `<h3>${esc(d.name)} · recent finishes</h3>
      <div class="kpis" style="margin-top:0">
        <div class="kpi"><div class="k">Avg finish</div><div class="v">${fx(d.season.avg)}</div></div>
        <div class="kpi"><div class="k">Top 10s</div><div class="v">${d.season.top10}/${d.season.n}</div></div>
        <div class="kpi"><div class="k">Model avg</div><div class="v">${fx(d.p.avgPos)}</div></div>
        ${d.season.lapsLed ? `<div class="kpi"><div class="k">Laps led</div><div class="v">${d.season.lapsLed}</div></div>` : ""}
        ${isFinite(d.season.rating) ? `<div class="kpi"><div class="k">Driver rating</div><div class="v">${fx(d.season.rating)}</div></div>` : ""}
      </div>
      <p class="small muted">Bars are finishing positions (lower is better); green = top 10.</p>
      ${gameChart(games, 10.5, d.mu, { height: 180, invert: true })}`;
  }

  function check() {
    const i = byId($("#r-d").value);
    const mk = $("#r-m").value;
    const d = drivers[i];
    $("#r-vs-f").classList.toggle("hidden", mk !== "h2h");
    let p, label;
    if (mk === "h2h") {
      const j = byId($("#r-vs").value);
      p = sim.h2h(i, j);
      label = `${d.name} finishes ahead of ${drivers[j].name}`;
    } else {
      p = d.p[mk];
      label = `${d.name} ${{ win: "wins", top3: "finishes top 3", top5: "finishes top 5", top10: "finishes top 10" }[mk]}`;
    }
    const odds = Number($("#r-o").value);
    const fair = M.toAmerican(Math.min(0.995, Math.max(0.002, p)));
    let verdict = "";
    if (odds) {
      const edge = p - M.impliedProb(odds);
      const ev = M.expectedValue(p, 0, odds);
      const grade = edge >= 0.05 ? "A" : edge >= 0.03 ? "B" : edge >= 0.015 ? "C" : "PASS";
      verdict = `<div class="verdict" style="margin-top:10px"><div class="grade ${grade}">${grade}</div><div><div class="call">${grade === "PASS" ? "PASS" : `<span class="over">BET</span>`}</div><div class="small muted">Edge ${(edge * 100).toFixed(1)} pts · EV ${(ev * 100).toFixed(1)}% · break-even ${pct(M.impliedProb(odds), 1)}</div></div></div>
        <button class="btn sm" id="r-save" style="margin-top:10px">★ Save pick</button>`;
    }
    $("#r-out").innerHTML = `<div><b>${esc(label)}</b>: <span style="font-size:20px;font-weight:800">${pct(p, 1)}</span> <span class="muted">fair ${M.fmtOdds(fair)}</span></div>${verdict}`;
    $("#r-save")?.addEventListener("click", () => {
      addPick({ league: L.id, athlete: d.name, athleteId: d.id, marketLabel: label, market: mk, side: "YES", odds, prob: p, eventDate: nx?.date, race: nx?.name });
      toast("Saved");
    });
    showDriver(d.id);
  }
  ["#r-d", "#r-m", "#r-vs", "#r-o"].forEach((s) => $(s).addEventListener("input", check));
  app.querySelectorAll("tr[data-d]").forEach((tr) => tr.addEventListener("click", () => { $("#r-d").value = tr.dataset.d; check(); $("#r-d").scrollIntoView({ behavior: "smooth", block: "center" }); }));
  check();
}

export function renderDriver(ctx, L, id) {
  location.replace(`#/l/${L.id}?driver=${encodeURIComponent(id)}`);
}
