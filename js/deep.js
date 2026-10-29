// Advanced stats built by the data pipeline (data/<league>/...). Every function
// returns null/"" when the data isn't there, so pages fall back to ESPN-only.
import { esc, fx, pct, fmtDate } from "./ui.js";
import { mean, sum } from "./model.js";

const teamCache = new Map();
const playerCache = new Map();

const getData = (path) => fetch(path, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

export async function loadDeep(L) {
  if (!L.deep) return null;
  if (!teamCache.has(L.id)) teamCache.set(L.id, getData(`data/${L.deep}/teams.json`));
  const d = await teamCache.get(L.id);
  return d ? { ...d, kind: L.deep } : null;
}

export async function loadDeepPlayer(L, id) {
  if (!L.deep) return null;
  const key = `${L.id}/${id}`;
  if (!playerCache.has(key)) playerCache.set(key, getData(`data/${L.deep}/players/${id}.json`));
  return playerCache.get(key);
}

const SUFFIX = ["th", "st", "nd", "rd"];
const ord = (n) => (n == null ? "—" : `${n}${SUFFIX[(n % 100 - 20) % 10] || SUFFIX[n % 100] || "th"}`);
// Rank pill: low rank = tough for the bettor's side (red), high = favorable (green).
const rankTag = (r, of = 32, good = "fewest") => (r == null ? "" : `<span class="pill ${r <= of / 4 ? "neg" : r > (of * 3) / 4 ? "pos" : ""}" title="1st = ${good}">${ord(r)}</span>`);
// Shrink a raw ratio toward 1 by sample size, then cap: matchup effects beyond ±20-25% are mostly noise.
const shrink = (raw, gp, k) => Math.min(1.25, Math.max(0.8, 1 + (raw - 1) * (gp / (gp + k))));

// ---------------- NFL ----------------
const NFL_POS = { QB: "QB", RB: "RB", FB: "RB", HB: "RB", WR: "WR", TE: "TE" };
const NFL_MARKET = {
  pass_yds: ["pass_yds"], pass_att: ["pass_att"], pass_cmp: ["cmp"], pass_td: ["pass_td"],
  rush_yds: ["rush_yds"], rush_att: ["rush_att"], rec: ["rec"], rec_yds: ["rec_yds"], tgt: ["tgt"], long_rec: ["rec_yds"],
  rush_rec_yds: ["rush_yds", "rec_yds"], pass_rush_yds: ["pass_yds", "rush_yds"],
};
const NFL_LABEL = { pass_yds: "pass yds", pass_att: "pass att", cmp: "completions", pass_td: "pass TDs", rush_yds: "rush yds", rush_att: "rush att", rec: "receptions", rec_yds: "rec yds", tgt: "targets" };

function nflOpp(deep, m, next, athlete) {
  const stats = NFL_MARKET[m.key];
  const pos = NFL_POS[athlete?.position?.abbreviation] || null;
  const t = deep.teams?.[next.opp];
  if (!stats || !pos || !t) return null;
  const usePos = ["pass_yds", "pass_att", "pass_cmp", "pass_td"].includes(m.key) ? "QB" : pos;
  const al = t.allowed?.[usePos];
  const lg = deep.league?.allowed?.[usePos];
  if (!al || !lg) return null;
  const a = sum(stats.map((s) => al[s] || 0)), l = sum(stats.map((s) => lg[s] || 0));
  if (!(l > 0)) return null;
  const factor = shrink(a / l, t.games || 0, 4);
  const rk = stats.length === 1 ? al[`${stats[0]}_rank`] : null;
  const label = stats.map((s) => NFL_LABEL[s]).join(" + ");
  return {
    factor,
    why: `${next.opp} allows ${fx(a)} ${label}/game to ${usePos}s${rk ? ` (${ord(rk)} fewest of 32)` : ""} vs league ${fx(l)} over ${t.games} games → ×${factor.toFixed(3)}.`,
    extra: nflDefenseLine(deep, next.opp),
  };
}

function nflDefenseLine(deep, abbr) {
  const t = deep.teams?.[abbr];
  if (!t) return "";
  const d = t.def || {}, r = t.def_rank || {};
  return `<div><b>${esc(abbr)} defense:</b> vs pass ${fx(d.ypp_pass)} yds/dropback ${rankTag(r.ypp_pass, 32, "stingiest")} · EPA/dropback ${fx(d.epa_pass, 2)} ${rankTag(r.epa_pass, 32, "stingiest")} · sack rate ${pct(d.sack_rate, 1)}<br/>
    vs run ${fx(d.ypc)} yds/carry ${rankTag(r.ypc, 32, "stingiest")} · EPA/rush ${fx(d.epa_rush, 2)} ${rankTag(r.epa_rush, 32, "stingiest")} · QB rush yds allowed ${fx(t.allowed?.QB?.rush_yds)}/g ${rankTag(t.allowed?.QB?.rush_yds_rank)}</div>`;
}

function nflPanel(deep, p, next) {
  if (!p.weeks?.length) return "";
  const season = Math.max(...p.weeks.map((w) => w.s));
  const cur = p.weeks.filter((w) => w.s === season && !w.post);
  const prev = p.weeks.filter((w) => w.s === season - 1);
  const last4 = cur.slice(-4);
  const vsOpp = next?.opp ? p.weeks.filter((w) => w.opp === next.opp) : [];
  const pos = p.pos;
  const isQB = pos === "QB";
  const receiving = p.weeks.some((w) => w.tgt);
  const per = (ws, k) => (ws.length ? sum(ws.map((w) => w[k] || 0)) / ws.length : NaN);
  const ratio = (ws, a, b) => { const d = sum(ws.map((w) => w[b] || 0)); return d ? sum(ws.map((w) => w[a] || 0)) / d : NaN; };
  // Average of a per-game rate weighted by a volume column.
  const wavg = (ws, k, wk) => { const d = sum(ws.map((w) => (w[k] != null ? w[wk] || 0 : 0))); return d ? sum(ws.map((w) => (w[k] != null ? w[k] * (w[wk] || 0) : 0))) / d : NaN; };

  const kpiSet = (ws) => {
    if (isQB) return [
      ["Att/g", fx(per(ws, "att"))], ["Cmp %", pct(ratio(ws, "cmp", "att"))], ["CPOE", fx(wavg(ws, "cpoe", "att"))],
      ["aDOT", fx(wavg(ws, "padot", "att"))], ["Deep att/g", fx(per(ws, "deep"))], ["Time to throw", fx(wavg(ws, "ttt", "att"), 2)],
      ["Rush att/g", fx(per(ws, "car"))], ["Designed runs/g", fx(per(ws, "dr"))], ["Scrambles/g", fx(per(ws, "scr"))],
      ["Rush yds/g", fx(per(ws, "rushyd"))], ["Designed yds/g", fx(per(ws, "dry"))], ["Scramble yds/g", fx(per(ws, "scry"))],
    ];
    const r = [];
    if (receiving) r.push(
      ["Targets/g", fx(per(ws, "tgt"))], ["Target share", pct(mean(ws.filter((w) => w.tsh != null).map((w) => w.tsh)))], ["Air yds share", pct(mean(ws.filter((w) => w.ash != null).map((w) => w.ash)))],
      ["aDOT", fx(wavg(ws, "adot", "tgt"))], ["Catch rate", pct(ratio(ws, "rec", "tgt"))], ["Separation", `${fx(wavg(ws, "sep", "tgt"))} yds`],
      ["Cushion", `${fx(wavg(ws, "cush", "tgt"))} yds`], ["YAC/catch", fx(ratio(ws, "yac", "rec"))], ["YAC vs exp.", fx(wavg(ws, "yacoe", "rec"))],
    );
    if (pos === "RB" || per(ws, "car") > 3) r.push(["Carries/g", fx(per(ws, "car"))], ["Yds/carry", fx(ratio(ws, "rushyd", "car"))], ["RYOE/att", fx(wavg(ws, "ryoe", "car"), 2)], ["8+ box %", fx(wavg(ws, "box8", "car"), 0)]);
    return r;
  };
  const kpis = (ws, title) => ws.length ? `<h3 style="margin-top:12px">${title} <span class="faint" style="text-transform:none;letter-spacing:0">(${ws.length} games)</span></h3><div class="kpis" style="margin-top:6px">${kpiSet(ws).map(([k, v]) => `<div class="kpi"><div class="k">${k}</div><div class="v" style="font-size:17px">${v}</div></div>`).join("")}</div>` : "";

  let depth = "";
  if (receiving) {
    const rows = [["Short (under 5 air yds)", "ts", "cs"], ["5+ air yds", "t5", "c5"], ["10+ air yds", "t10", "c10"], ["20+ air yds", "t20", "c20"]];
    const tbl = (ws) => rows.map(([lbl, t, c]) => {
      const tt = sum(ws.map((w) => w[t] || 0)), cc = sum(ws.map((w) => w[c] || 0));
      return `<tr><td>${lbl}</td><td class="r">${tt}</td><td class="r">${cc}</td><td class="r">${tt ? pct(cc / tt) : "—"}</td><td class="r">${fx(cc / (ws.length || 1), 2)}</td></tr>`;
    }).join("");
    const g10 = sum(cur.map((w) => w.g10 || 0)), g20 = sum(cur.map((w) => w.g20 || 0)), recs = sum(cur.map((w) => w.rec || 0));
    depth = `<div class="grid two" style="margin-top:12px"><div><h3>Catches by depth · ${season}</h3><div class="table-wrap"><table><thead><tr><th>Depth of target</th><th class="r">Tgt</th><th class="r">Catches</th><th class="r">Catch %</th><th class="r">Per game</th></tr></thead><tbody>${tbl(cur)}</tbody></table></div>
      <p class="small muted">Catches gaining 10+ yds: <b>${g10}</b> (${recs ? pct(g10 / recs) : "—"} of catches, ${fx(g10 / (cur.length || 1), 2)}/g) · 20+ yds: <b>${g20}</b> (${fx(g20 / (cur.length || 1), 2)}/g)</p></div>
      <div><h3>${season - 1} season</h3><div class="table-wrap"><table><thead><tr><th>Depth</th><th class="r">Tgt</th><th class="r">Catches</th><th class="r">Catch %</th><th class="r">Per game</th></tr></thead><tbody>${prev.length ? tbl(prev) : `<tr><td colspan="5" class="muted">No data</td></tr>`}</tbody></table></div></div></div>`;
  }

  const cols = isQB
    ? [["att", "Att"], ["cmp", "Cmp"], ["pyd", "Pass yds"], ["padot", "aDOT"], ["car", "Rush"], ["dr", "Designed"], ["scr", "Scrambles"], ["rushyd", "Rush yds"], ["sk", "Sacked"]]
    : receiving
      ? [["tgt", "Tgt"], ["rec", "Rec"], ["ryd", "Yds"], ["adot", "aDOT"], ["tsh", "Tgt %"], ["sep", "Sep"], ["c10", "10+ ay catch"], ["g20", "20+ yd catch"], ["car", "Car"], ["rushyd", "Rush yds"]]
      : [["car", "Car"], ["rushyd", "Rush yds"], ["ryoe", "RYOE/att"], ["box8", "8+ box%"], ["tgt", "Tgt"], ["rec", "Rec"], ["ryd", "Rec yds"]];
  const counts = new Set(["car", "tgt", "rec", "att", "cmp", "dr", "scr", "sk", "c10", "g20", "ryd", "pyd", "rushyd"]);
  const fmtCell = (k, v) => (v == null ? (counts.has(k) ? 0 : "—") : k === "tsh" ? pct(v) : Number.isInteger(v) ? v : fx(v));
  const weekRows = [...p.weeks].reverse().slice(0, 20).map((w) => `<tr class="${next?.opp && w.opp === next.opp ? "hl" : ""}"><td>${w.s} W${w.w}${w.post ? " PO" : ""}</td><td>${w.home ? "vs" : "@"} ${esc(w.opp)}</td>${cols.map(([k]) => `<td class="r">${fmtCell(k, w[k])}</td>`).join("")}</tr>`).join("");

  const oppHist = vsOpp.length ? `<p class="small" style="margin:8px 0 0"><b>vs ${esc(next.opp)} before (${vsOpp.length} game${vsOpp.length === 1 ? "" : "s"}):</b> ${isQB ? `${fx(per(vsOpp, "att"))} att, ${fx(per(vsOpp, "pyd"))} pass yds, ${fx(per(vsOpp, "car"))} rushes for ${fx(per(vsOpp, "rushyd"))} yds per game` : `${fx(per(vsOpp, "tgt"))} tgt, ${fx(per(vsOpp, "rec"))} rec, ${fx(per(vsOpp, "ryd"))} rec yds, ${fx(per(vsOpp, "rushyd"))} rush yds per game`}</p>` : "";

  return `<div class="card" style="margin-top:14px">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">Advanced · ${esc(p.name)} (${esc(pos)})</h3><span class="pill gold">nflverse + Next Gen Stats</span></div>
    ${kpis(cur, `${season} season`)}${kpis(last4, "Last 4 games")}
    ${depth}
    ${next?.opp ? `<h3 style="margin-top:14px">Matchup: ${esc(next.opp)}</h3>${nflDefenseLine(deep, next.opp)}${oppHist}` : ""}
    <h3 style="margin-top:14px">Weekly</h3>
    <div class="table-wrap"><table><thead><tr><th>Week</th><th>Opp</th>${cols.map(([, l]) => `<th class="r">${l}</th>`).join("")}</tr></thead><tbody>${weekRows}</tbody></table></div>
    <p class="small faint" style="margin:8px 0 0">Separation and cushion are Next Gen Stats averages: yards to the nearest defender at the catch or incompletion (how open he gets), and at the snap. Depth = air yards past the line of scrimmage on the target. Designed runs exclude scrambles and kneels. Rank pills: 1st = stingiest defense.</p>
  </div>`;
}

function nflGamePanel(deep, H, A) {
  const h = deep.teams?.[H.abbreviation], a = deep.teams?.[A.abbreviation];
  if (!h || !a) return "";
  const row = (label, av, ar, hv, hr, d = 2) => `<tr><td>${label}</td><td class="r">${fx(av, d)} ${rankTag(ar, 32, "best")}</td><td class="r">${fx(hv, d)} ${rankTag(hr, 32, "best")}</td></tr>`;
  return `<div class="card" style="margin-top:14px"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Efficiency (nflverse play-by-play)</h3><span class="small muted">Rank pills: 1st = best</span></div>
    <div class="grid two" style="margin-top:8px">
      <div class="table-wrap"><table><thead><tr><th>Offense</th><th class="r">${esc(A.abbreviation)}</th><th class="r">${esc(H.abbreviation)}</th></tr></thead><tbody>
        ${row("EPA/play", a.off.epa_play, a.off_rank?.epa_play, h.off.epa_play, h.off_rank?.epa_play)}
        ${row("EPA/dropback", a.off.epa_pass, a.off_rank?.epa_pass, h.off.epa_pass, h.off_rank?.epa_pass)}
        ${row("EPA/rush", a.off.epa_rush, a.off_rank?.epa_rush, h.off.epa_rush, h.off_rank?.epa_rush)}
        ${row("Pass rate", a.off.pass_rate, null, h.off.pass_rate, null)}
        ${row("Plays/game", a.off.plays_g, null, h.off.plays_g, null, 1)}
      </tbody></table></div>
      <div class="table-wrap"><table><thead><tr><th>Defense</th><th class="r">${esc(A.abbreviation)}</th><th class="r">${esc(H.abbreviation)}</th></tr></thead><tbody>
        ${row("EPA/play allowed", a.def.epa_play, a.def_rank?.epa_play, h.def.epa_play, h.def_rank?.epa_play)}
        ${row("EPA/dropback allowed", a.def.epa_pass, a.def_rank?.epa_pass, h.def.epa_pass, h.def_rank?.epa_pass)}
        ${row("Yds/dropback allowed", a.def.ypp_pass, a.def_rank?.ypp_pass, h.def.ypp_pass, h.def_rank?.ypp_pass)}
        ${row("EPA/rush allowed", a.def.epa_rush, a.def_rank?.epa_rush, h.def.epa_rush, h.def_rank?.epa_rush)}
        ${row("Yds/carry allowed", a.def.ypc, a.def_rank?.ypc, h.def.ypc, h.def_rank?.ypc)}
      </tbody></table></div>
    </div>
    <p class="small muted" style="margin:8px 0 0">${esc(A.abbreviation)} passing (${ord(a.off_rank?.epa_pass)} offense) vs ${esc(H.abbreviation)} pass D (${ord(h.def_rank?.epa_pass)}); ${esc(A.abbreviation)} run game (${ord(a.off_rank?.epa_rush)}) vs ${esc(H.abbreviation)} run D (${ord(h.def_rank?.epa_rush)}). ${esc(H.abbreviation)} passing (${ord(h.off_rank?.epa_pass)}) vs ${esc(A.abbreviation)} pass D (${ord(a.def_rank?.epa_pass)}); run (${ord(h.off_rank?.epa_rush)}) vs run D (${ord(a.def_rank?.epa_rush)}).</p>
  </div>`;
}

// ---------------- NBA ----------------
const NBA_POS = { PG: "G", SG: "G", G: "G", SF: "F", PF: "F", F: "F", C: "C", FC: "C", GF: "F" };
const NBA_MARKET = {
  pts: ["pts"], reb: ["reb"], ast: ["ast"], fg3m: ["fg3m"], pra: ["pts", "reb", "ast"], pr: ["pts", "reb"], pa: ["pts", "ast"], ra: ["reb", "ast"],
  stl: ["stl"], blk: ["blk"], sb: ["stl", "blk"], tov: ["tov"], fgm: ["fgm"], fga: ["fga"], ftm: ["ftm"], fg3a: ["fg3a"],
};

function nbaOpp(deep, m, next, athlete) {
  const stats = NBA_MARKET[m.key];
  const pos = NBA_POS[athlete?.position?.abbreviation] || null;
  const t = deep.teams?.[next.opp];
  const lg = deep.league;
  if (!stats || !t || !lg) return null;
  const parts = [];
  let factor = 1;
  const gp = t.gp || 0;
  // Defense vs position.
  if (pos && t.dvp?.[pos] && lg.dvp?.[pos]) {
    const a = sum(stats.map((s) => t.dvp[pos][s] || 0)), l = sum(stats.map((s) => lg.dvp[pos][s] || 0));
    if (l > 0) {
      const f = shrink(a / l, gp, 10);
      factor *= f;
      parts.push(`${next.opp} allows ${fx(a)} ${stats.join("+")}/game to ${pos === "G" ? "guards" : pos === "F" ? "forwards" : "centers"} vs league ${fx(l)} (×${f.toFixed(3)})`);
    }
  }
  // Pace: expected possessions vs this player's team's normal pace.
  const myTeam = athlete?.team?.abbreviation;
  const mine = myTeam && deep.teams?.[myTeam];
  if (mine?.pace && t.pace) {
    const f = shrink(((mine.pace + t.pace) / 2) / mine.pace, Math.min(gp, mine.gp || 0), 10);
    factor *= f;
    parts.push(`expected pace ${fx((mine.pace + t.pace) / 2)} vs ${myTeam}'s usual ${fx(mine.pace)} (×${f.toFixed(3)})`);
  }
  // Rebounds: how many missed shots there are to grab in this matchup.
  if (stats.includes("reb") && mine?.fg_miss && t.opp_fg_miss && t.fg_miss && lg.fg_miss) {
    const expected = (mine.fg_miss + t.opp_fg_miss) / 2 + (t.fg_miss + (mine.opp_fg_miss || t.fg_miss)) / 2;
    const f = Math.pow(shrink(expected / (2 * lg.fg_miss), gp, 10), 0.5);
    factor *= f;
    parts.push(`about ${fx(expected)} missed FGs expected in this game vs league ${fx(2 * lg.fg_miss)} (×${f.toFixed(3)})`);
  }
  if (!parts.length) return null;
  return { factor, why: `${parts.join("; ")} → ×${factor.toFixed(3)}.`, extra: nbaTeamLine(deep, next.opp) };
}

function nbaTeamLine(deep, abbr) {
  const t = deep.teams?.[abbr];
  if (!t) return "";
  const r = t.rank || {};
  return `<div><b>${esc(abbr)}:</b> pace ${fx(t.pace)} ${rankTag(r.pace, 30, "slowest")} · def rating ${fx(t.drtg)} ${rankTag(r.drtg, 30, "best")} · their opponents miss ${fx(t.opp_fg_miss)} FG/g ${rankTag(r.opp_fg_miss, 30, "fewest")} · ${esc(abbr)} misses ${fx(t.fg_miss)} FG/g · reb rate ${pct(t.reb_pct, 1)}</div>`;
}

function nbaPanel(deep, p, next) {
  const games = p.games || [];
  if (!games.length) return "";
  const last10 = games.slice(-10);
  const avg = (ws, k) => mean(ws.map((g) => g[k]).filter((v) => v != null));
  const k = (ws) => [
    ["Usage %", fx(avg(ws, "usg"), 1)], ["Reb %", fx(avg(ws, "rebp"), 1)], ["OReb %", fx(avg(ws, "orebp"), 1)],
    ["DReb %", fx(avg(ws, "drebp"), 1)], ["Ast %", fx(avg(ws, "astp"), 1)], ["Misses on floor/g", fx(avg(ws, "rch"))],
    ["Team misses/g", fx(avg(ws, "tm_miss"))], ["Opp misses/g", fx(avg(ws, "opp_miss"))], ["Min/g", fx(avg(ws, "min"))],
  ];
  const kp = (ws, title) => `<h3 style="margin-top:12px">${title} <span class="faint" style="text-transform:none;letter-spacing:0">(${ws.length} games)</span></h3><div class="kpis" style="margin-top:6px">${k(ws).map(([a, b]) => `<div class="kpi"><div class="k">${a}</div><div class="v" style="font-size:17px">${b}</div></div>`).join("")}</div>`;
  const rows = [...games].reverse().slice(0, 15).map((g) => `<tr class="${next?.opp && g.opp === next.opp ? "hl" : ""}"><td>${fmtDate(g.date)}</td><td>${g.home ? "vs" : "@"} ${esc(g.opp)}</td><td class="r">${fx(g.min, 0)}</td><td class="r">${fx(g.usg, 1)}</td><td class="r">${g.reb ?? "—"}</td><td class="r">${fx(g.rch, 1)}</td><td class="r">${fx(g.rebp, 1)}</td><td class="r">${g.tm_miss ?? "—"}</td><td class="r">${g.opp_miss ?? "—"}</td><td class="r">${g.ast ?? "—"}</td><td class="r">${fx(g.astp, 1)}</td></tr>`).join("");

  // Next-game rebound outlook: expected misses from both teams -> share while he plays -> his conversion rate.
  let outlook = "";
  const mine = deep.teams?.[p.team], opp = next?.opp && deep.teams?.[next.opp];
  const recent = games.slice(-10);
  const conv = sum(recent.map((g) => g.reb || 0)) / sum(recent.map((g) => g.rch || 0));
  const perMin = sum(recent.map((g) => g.rch || 0)) / sum(recent.map((g) => g.min || 0));
  const avgGameMiss = avg(recent, "tm_miss") + avg(recent, "opp_miss");
  if (mine && opp && isFinite(conv) && isFinite(perMin) && avgGameMiss > 0) {
    const ourMiss = (mine.fg_miss + opp.opp_fg_miss) / 2;
    const theirMiss = (opp.fg_miss + mine.opp_fg_miss) / 2;
    const expMin = avg(recent, "min");
    const avail = perMin * expMin * ((ourMiss + theirMiss) / avgGameMiss);
    outlook = `<div class="notice" style="margin-top:12px"><b>Rebound outlook vs ${esc(next.opp)}:</b> expect about <b>${fx(ourMiss)}</b> ${esc(p.team)} misses + <b>${fx(theirMiss)}</b> ${esc(next.opp)} misses (${fx(ourMiss + theirMiss)} total vs his recent ${fx(avgGameMiss)}). In ~${fx(expMin, 0)} minutes that's ~<b>${fx(avail)}</b> missed shots while he's on the floor; at his recent ${pct(conv, 1)} conversion ≈ <b>${fx(avail * conv)} rebounds</b>.</div>`;
  }
  return `<div class="card" style="margin-top:14px">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">Advanced · usage & rebounding</h3><span class="pill gold">Computed from box scores</span></div>
    ${kp(games, "This season")}${games.length > 10 ? kp(last10, "Last 10") : ""}
    ${next?.opp ? `<h3 style="margin-top:14px">Matchup: ${esc(next.opp)}</h3>${nbaTeamLine(deep, next.opp)}` : ""}
    ${outlook}
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Date</th><th>Opp</th><th class="r">Min</th><th class="r">Usg%</th><th class="r">Reb</th><th class="r">Misses on floor</th><th class="r">Reb%</th><th class="r">Team misses</th><th class="r">Opp misses</th><th class="r">Ast</th><th class="r">Ast%</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="small faint" style="margin:8px 0 0">Misses on floor = both teams' missed shots (FGs plus ~44% of missed free throws) while he was playing, i.e. the rebounds available to anyone. Reb % = share of all rebounds he grabbed while on the floor. Usage % = share of team plays (shots, free-throw trips, turnovers) he used. NBA.com's tracking stats ("potential rebounds/assists", which only count chances near the player) block automated access, so these are the closest box-score equivalents.</p>
  </div>`;
}

function nbaGamePanel(deep, H, A) {
  const h = deep.teams?.[H.abbreviation], a = deep.teams?.[A.abbreviation];
  if (!h || !a) return "";
  const row = (label, k, d = 1, isPct = false, good = "best") => `<tr><td>${label}</td><td class="r">${isPct ? pct(a[k], 1) : fx(a[k], d)} ${rankTag(a.rank?.[k], 30, good)}</td><td class="r">${isPct ? pct(h[k], 1) : fx(h[k], d)} ${rankTag(h.rank?.[k], 30, good)}</td></tr>`;
  return `<div class="card" style="margin-top:14px"><h3>Team profile (box scores)</h3>
    <div class="table-wrap"><table><thead><tr><th></th><th class="r">${esc(A.abbreviation)}</th><th class="r">${esc(H.abbreviation)}</th></tr></thead><tbody>
      ${row("Pace (poss/48)", "pace", 1, false, "slowest")}${row("Offensive rating", "ortg")}${row("Defensive rating", "drtg")}
      ${row("FG misses/g", "fg_miss")}${row("Opponent FG misses/g", "opp_fg_miss", 1, false, "fewest")}${row("Rebound rate", "reb_pct", 1, true)}${row("3PA rate", "fg3a_rate", 1, true)}
    </tbody></table></div></div>`;
}

// ---------------- NHL ----------------
const NHL_POS = { C: "F", LW: "F", RW: "F", F: "F", W: "F", D: "D", G: "G" };

// Per-game fields ESPN's NHL game log lacks, keyed by event id, for merging into it.
export function deepGameStats(L, deepPlayer) {
  if (L.deep !== "nhl" || !deepPlayer?.games) return null;
  const m = new Map();
  for (const g of deepPlayer.games) m.set(String(g.ev), { hits: g.hits ?? null, blk: g.blk ?? null, pptoi: g.pptoi ?? null });
  return m;
}

function nhlOpp(deep, m, next, athlete) {
  const t = deep.teams?.[next.opp], lg = deep.league;
  if (!t || !lg) return null;
  const pos = NHL_POS[athlete?.position?.abbreviation] || "F";
  const gp = t.gp || 0;
  let raw = null, why = "";
  if (m.key === "sog" && t.allowed?.[pos] && lg.allowed?.[pos]) {
    raw = t.allowed[pos].sog / lg.allowed[pos].sog;
    why = `${next.opp} allows ${fx(t.allowed[pos].sog)} SOG/game to ${pos === "F" ? "forwards" : "defensemen"} vs league ${fx(lg.allowed[pos].sog)} (${ord(t.rank?.sa)} fewest shots allowed overall)`;
  } else if (["pts", "g", "a"].includes(m.key) && t.allowed?.[pos] && lg.allowed?.[pos]) {
    raw = t.allowed[pos].pts / lg.allowed[pos].pts;
    why = `${next.opp} allows ${fx(t.allowed[pos].pts, 2)} points/game to ${pos === "F" ? "forwards" : "defensemen"} vs league ${fx(lg.allowed[pos].pts, 2)}`;
  } else if (m.key === "hits" && lg.hits) {
    raw = t.hits_a / lg.hits;
    why = `${next.opp} absorbs ${fx(t.hits_a)} hits/game vs league ${fx(lg.hits)}`;
  } else if (m.key === "blk" && lg.sf) {
    raw = t.sf / lg.sf;
    why = `${next.opp} takes ${fx(t.sf)} shots/game vs league ${fx(lg.sf)} (more shots → more to block)`;
  } else if (m.key === "saves" && lg.sf) {
    raw = t.sf / lg.sf;
    why = `${next.opp} averages ${fx(t.sf)} shots on goal vs league ${fx(lg.sf)} (${ord(t.rank?.sf)} most)`;
  } else if (m.key === "ga" && lg.gf) {
    raw = t.gf / lg.gf;
    why = `${next.opp} scores ${fx(t.gf, 2)} goals/game vs league ${fx(lg.gf, 2)}`;
  }
  if (raw == null || !isFinite(raw)) return null;
  const factor = shrink(raw, gp, 12);
  return { factor, why: `${why} over ${gp} games → ×${factor.toFixed(3)}.`, extra: nhlTeamLine(deep, next.opp) };
}

function nhlTeamLine(deep, abbr) {
  const t = deep.teams?.[abbr];
  if (!t) return "";
  const r = t.rank || {};
  return `<div><b>${esc(abbr)}:</b> shots for ${fx(t.sf)}/g · shots against ${fx(t.sa)}/g ${rankTag(r.sa, 32, "fewest")} · goals against ${fx(t.ga, 2)}/g ${rankTag(r.ga, 32, "fewest")} · hits ${fx(t.hits)}/g</div>`;
}

function nhlPanel(deep, p, next) {
  const games = p.games || [];
  if (!games.length) return "";
  const goalie = p.pos === "G";
  const avg = (ws, k) => mean(ws.map((g) => g[k]).filter((v) => v != null));
  const last10 = games.slice(-10);
  const kp = (ws, title) => {
    const items = goalie
      ? [["Shots against/g", fx(avg(ws, "sa"))], ["Saves/g", fx(avg(ws, "saves"))], ["Save %", pct(sum(ws.map((g) => g.saves || 0)) / sum(ws.map((g) => g.sa || 0)), 1)], ["GA/g", fx(avg(ws, "ga"), 2)]]
      : [["TOI/g", fx(avg(ws, "toi"))], ["PP TOI/g", fx(avg(ws, "pptoi"), 2)], ["SOG/g", fx(avg(ws, "sog"), 2)], ["Shot attempts/g", fx(avg(ws.map((g) => ({ v: (g.sog || 0) + (g.miss || 0) })), "v"), 2)],
        ["SOG per 60", fx((60 * sum(ws.map((g) => g.sog || 0))) / sum(ws.map((g) => g.toi || 0)), 2)], ["Hits/g", fx(avg(ws, "hits"), 2)], ["Blocks/g", fx(avg(ws, "blk"), 2)], ["Points/g", fx(avg(ws.map((g) => ({ v: (g.g || 0) + (g.a || 0) })), "v"), 2)]];
    return `<h3 style="margin-top:12px">${title} <span class="faint" style="text-transform:none;letter-spacing:0">(${ws.length} games)</span></h3><div class="kpis" style="margin-top:6px">${items.map(([a, b]) => `<div class="kpi"><div class="k">${a}</div><div class="v" style="font-size:17px">${b}</div></div>`).join("")}</div>`;
  };
  const cols = goalie ? [["toi", "TOI"], ["sa", "SA"], ["saves", "SV"], ["ga", "GA"]] : [["toi", "TOI"], ["pptoi", "PP TOI"], ["sog", "SOG"], ["miss", "Missed"], ["hits", "Hits"], ["blk", "Blk"], ["g", "G"], ["a", "A"]];
  const rows = [...games].reverse().slice(0, 15).map((g) => `<tr class="${next?.opp && g.opp === next.opp ? "hl" : ""}"><td>${fmtDate(g.date)}</td><td>${g.home ? "vs" : "@"} ${esc(g.opp)}</td>${cols.map(([k]) => `<td class="r">${g[k] == null ? "—" : Number.isInteger(g[k]) ? g[k] : fx(g[k])}</td>`).join("")}</tr>`).join("");
  return `<div class="card" style="margin-top:14px">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">Advanced · ${goalie ? "goaltending" : "ice time, shots, hits & blocks"}</h3><span class="pill gold">From box scores</span></div>
    ${kp(games, "This season")}${games.length > 10 ? kp(last10, "Last 10") : ""}
    ${next?.opp ? `<h3 style="margin-top:14px">Matchup: ${esc(next.opp)}</h3>${nhlTeamLine(deep, next.opp)}` : ""}
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Date</th><th>Opp</th>${cols.map(([, l]) => `<th class="r">${l}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
}

function nhlGamePanel(deep, H, A) {
  const h = deep.teams?.[H.abbreviation], a = deep.teams?.[A.abbreviation];
  if (!h || !a) return "";
  const row = (label, k, d = 1, good = "best") => `<tr><td>${label}</td><td class="r">${fx(a[k], d)} ${rankTag(a.rank?.[k], 32, good)}</td><td class="r">${fx(h[k], d)} ${rankTag(h.rank?.[k], 32, good)}</td></tr>`;
  return `<div class="card" style="margin-top:14px"><h3>Team profile (box scores)</h3>
    <div class="table-wrap"><table><thead><tr><th></th><th class="r">${esc(A.abbreviation)}</th><th class="r">${esc(H.abbreviation)}</th></tr></thead><tbody>
      ${row("Shots on goal/g", "sf", 1, "most")}${row("Shots against/g", "sa", 1, "fewest")}${row("Goals/g", "gf", 2, "most")}${row("Goals against/g", "ga", 2, "fewest")}${row("Hits/g", "hits")}${row("Blocks/g", "blk")}
    </tbody></table></div></div>`;
}

// ---------------- dispatch ----------------
export function deepOppFactor(L, deep, m, next, athlete) {
  if (!deep || !next?.opp) return null;
  if (deep.kind === "nfl") return nflOpp(deep, m, next, athlete);
  if (deep.kind === "nba") return nbaOpp(deep, m, next, athlete);
  if (deep.kind === "nhl") return nhlOpp(deep, m, next, athlete);
  return null;
}

export function deepPlayerPanel(L, deep, deepPlayer, next) {
  if (!deep || !deepPlayer) return "";
  if (deep.kind === "nfl") return nflPanel(deep, deepPlayer, next);
  if (deep.kind === "nba") return nbaPanel(deep, deepPlayer, next);
  if (deep.kind === "nhl") return nhlPanel(deep, deepPlayer, next);
  return "";
}

export function deepGamePanel(L, deep, H, A) {
  if (!deep) return "";
  if (deep.kind === "nfl") return nflGamePanel(deep, H, A);
  if (deep.kind === "nba") return nbaGamePanel(deep, H, A);
  if (deep.kind === "nhl") return nhlGamePanel(deep, H, A);
  return "";
}
