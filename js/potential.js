// Potential stats: what a player's chances say he "should" have produced each game
// (potential assists, rebound chances, shot attempts, NFL expected stats), next to
// what he did. The prop model leans toward the expected numbers because luck evens out.
// Per-game x* fields come from the data pipeline (data/<league>/players/<id>.json).
import { esc, fx, fmtDate } from "./ui.js";
import { mean, sum } from "./model.js";

// Market -> expected fields (summed for combos), how much to lean on them, and what the
// "chances" column shows.
const SPEC = {
  basketball: {
    ast: { x: ["xast"], w: 0.6, chance: "pot_ast", chanceLabel: "Potential assists (est.)", why: "teammates' shooting on his passes" },
    reb: { x: ["xreb"], w: 0.5, chance: "rch", chanceLabel: "Rebound chances (est.)", why: "rebound chances at his usual conversion" },
    pts: { x: ["xpts"], w: 0.35, chance: "fga", chanceLabel: "Shot attempts", why: "his shots and free throws at his usual percentages" },
    fg3m: { x: ["xfg3m"], w: 0.5, chance: "fg3a", chanceLabel: "3-point attempts", why: "3-point attempts at his usual 3P%" },
    pra: { x: ["xpts", "xreb", "xast"], w: 0.4 }, pr: { x: ["xpts", "xreb"], w: 0.4 }, pa: { x: ["xpts", "xast"], w: 0.4 }, ra: { x: ["xreb", "xast"], w: 0.5 },
  },
  football: {
    rec: { x: ["xrec"], w: 0.5, chance: "tgt", chanceLabel: "Targets", why: "his targets and how catchable they were" },
    rec_yds: { x: ["xryd"], w: 0.5, chance: "air", chanceLabel: "Air yards", why: "his targets, air yards and field position" },
    rush_yds: { x: ["xrushyd"], w: 0.45, chance: "car", chanceLabel: "Carries", why: "his carries, down, distance and field position" },
    pass_yds: { x: ["xpyd"], w: 0.4, chance: "att", chanceLabel: "Pass attempts", why: "his pass attempts and air yards" },
    pass_cmp: { x: ["xcmp"], w: 0.5, chance: "att", chanceLabel: "Pass attempts", why: "his pass attempts and their depth" },
    pass_td: { x: ["xptd"], w: 0.6, chance: "att", chanceLabel: "Pass attempts", why: "where his throws happened on the field" },
    pass_int: { x: ["xint"], w: 0.6 },
    any_td: { x: ["xrtd", "xrushtd"], w: 0.6, chance: "tgt", chanceLabel: "Targets", why: "his red-zone and goal-line touches" },
    rush_rec_yds: { x: ["xryd", "xrushyd"], w: 0.45 }, pass_rush_yds: { x: ["xpyd", "xrushyd"], w: 0.4 },
  },
  hockey: {
    sog: { x: ["xsog"], w: 0.5, chance: "att", chanceLabel: "Shot attempts", why: "shot attempts at his usual on-target rate" },
    g: { x: ["xg"], w: 0.6, chance: "sog", chanceLabel: "Shots on goal", why: "shots on goal at his usual shooting %" },
  },
};

export const potentialSpec = (fam, m) => SPEC[fam]?.[m.key] || null;

// Per-game rows from the pipeline file, keyed by ESPN event id.
export function potentialByEvent(deepPlayer) {
  const rows = deepPlayer?.games || deepPlayer?.weeks;
  if (!rows) return null;
  const map = new Map();
  for (const r of rows) {
    if (!r.ev) continue;
    const x = {};
    for (const [k, v] of Object.entries(r)) if (/^x|^pot_|^rch$|^rconv$|^fga$|^fg3a$|^tgt$|^air$|^car$|^att$|^sog$|^miss$/.test(k)) x[k] = v;
    if (r.sog != null || r.miss != null) x.att = (r.sog || 0) + (r.miss || 0);
    map.set(String(r.ev), x);
  }
  return map;
}

// Expected value of this market in one game, or null.
export function expectedFor(fam, m, x) {
  const spec = potentialSpec(fam, m);
  if (!spec || !x) return null;
  const vals = spec.x.map((k) => x[k]);
  return vals.every((v) => v != null && isFinite(v)) ? sum(vals) : null;
}

// Card for a player page: per-game actual vs chances vs expected, and the lean.
export function potentialCard(fam, m, games, res) {
  const spec = potentialSpec(fam, m);
  const rows = games.filter((g) => g.expected != null && g.value != null).slice(0, 10);
  if (!spec || rows.length < 3) return "";
  // The numbers the model actually used (recent games weighted more), when it ran.
  const p = res?.potential;
  const act = p ? p.actual : mean(rows.map((g) => g.value)), exp = p ? p.expected : mean(rows.map((g) => g.expected));
  const chances = spec.chance ? rows.map((g) => g.x?.[spec.chance]).filter((v) => v != null) : [];
  const f = p?.factor ?? 1;
  const verdict = Math.abs(f - 1) < 0.01 ? "right in line with his chances, so nothing changes"
    : f > 1 ? `<b class="pos">below</b> what his chances say: he's been unlucky, so the model leans up`
    : `<b class="neg">above</b> what his chances say: some of that is luck, so the model leans down`;
  const d = act < 5 ? 2 : 1;
  return `<div class="card" style="margin-top:14px">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">🎯 Potential · ${esc(m.label)}</h3>${p ? `<span class="pill ${p.factor > 1.005 ? "pos" : p.factor < 0.995 ? "neg" : ""}">projection ×${p.factor.toFixed(3)}</span>` : ""}</div>
    <p class="small muted" style="margin:6px 0 10px">What his chances say he should have had${spec.why ? ` (${esc(spec.why)})` : ""}, vs what he actually got. ${p ? `Weighting recent games more, over ${p.n} games` : `Over his last ${rows.length} games`} he's ${verdict}.</p>
    <div class="kpis" style="margin-top:0">
      ${chances.length ? `<div class="kpi"><div class="k">${esc(spec.chanceLabel)}/g</div><div class="v">${fx(mean(chances), 1)}</div></div>` : ""}
      <div class="kpi"><div class="k">Expected/g</div><div class="v">${fx(exp, d)}</div></div>
      <div class="kpi"><div class="k">Actual/g</div><div class="v">${fx(act, d)}</div></div>
    </div>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Date</th><th>Opp</th>${spec.chance ? `<th class="r">${esc(spec.chanceLabel)}</th>` : ""}<th class="r">Expected</th><th class="r">Actual</th><th class="r">Luck</th></tr></thead><tbody>
      ${rows.map((g) => { const l = g.value - g.expected; return `<tr><td>${fmtDate(g.date)}</td><td>${g.home ? "vs" : "@"} ${esc(g.opp || "")}</td>${spec.chance ? `<td class="r">${g.x?.[spec.chance] != null ? fx(g.x[spec.chance], 1) : "—"}</td>` : ""}<td class="r">${fx(g.expected, d)}</td><td class="r"><b>${Number.isInteger(g.value) ? g.value : fx(g.value, 1)}</b></td><td class="r ${l > 0 ? "pos" : l < 0 ? "neg" : ""}">${l > 0 ? "+" : ""}${fx(l, d)}</td></tr>`; }).join("")}
    </tbody></table></div>
    <p class="small faint" style="margin:8px 0 0">${fam === "football" ? "Expected stats come from nflverse play-by-play (ffopportunity): what the same targets, carries and throws are usually worth, adjusted to his own usual efficiency so only the swing beyond his normal counts as luck." : fam === "hockey" ? "From shot attempts in each box score and his season on-target and shooting rates, shrunk toward the league." : "NBA.com's tracking data isn't reachable from the data servers, so these are box-score estimates: potential assists = assists ÷ teammates' FG% that game; rebound chances = misses while he's on the floor."}</p>
  </div>`;
}
