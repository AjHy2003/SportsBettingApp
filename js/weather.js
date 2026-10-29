// Game-time weather for outdoor football (Open-Meteo: free, no key) and what it
// does to scoring and the pass/run mix. No DOM; the daily picks job uses it too.
import { getJSON } from "./espn.js";

const SITE = "https://site.web.api.espn.com/apis/site/v2/sports";
const STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
// Covered or retractable roofs ESPN lists as outdoor (roofs close in bad weather).
const COVERED = /sofi stadium|allegiant|mercedes-benz stadium|nrg stadium|lucas oil|state farm stadium|u\.s\. bank stadium|caesars superdome|ford field|at&t stadium|dome\b/i;

const WMO = (c) => (c >= 95 ? "Thunderstorms" : c >= 85 ? "Snow showers" : c >= 80 ? "Rain showers" : c >= 71 ? "Snow" : c >= 61 ? "Rain" : c >= 51 ? "Drizzle" : c >= 45 ? "Fog" : c >= 3 ? "Cloudy" : c >= 1 ? "Partly cloudy" : "Clear");
const iso = (d) => d.toISOString().slice(0, 10);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

async function coords(venue) {
  const a = venue?.address || {};
  if (!a.city) return null;
  const d = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(a.city)}&count=10&language=en&format=json`, 7 * 864e5);
  const res = d.results || [];
  const state = STATES[a.state] || a.state;
  const us = !a.country || /usa|united states/i.test(a.country);
  const hit = (state && res.find((r) => r.country_code === "US" && r.admin1 === state)) || (us ? res.find((r) => r.country_code === "US") : res.find((r) => r.country_code !== "US")) || res[0];
  return hit ? { lat: hit.latitude, lon: hit.longitude } : null;
}

// ESPN's indoor flag lives on the scoreboard, not the game summary.
async function indoorFlag(L, sum) {
  const comp = sum?.header?.competitions?.[0];
  if (!comp?.date) return null;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(comp.date)).replaceAll("-", "");
  try {
    const sb = await getJSON(`${SITE}/${L.espn}/scoreboard?dates=${day}${L.id === "ncaaf" ? "&groups=80&limit=300" : ""}`, 30 * 60e3);
    return sb.events?.find((e) => String(e.id) === String(comp.id))?.competitions?.[0]?.venue?.indoor ?? null;
  } catch { return null; }
}

// -> { indoor, venue, wind, gust, temp, precip, snow, desc, at } or null (not football / no forecast yet).
export async function gameWeather(L, sum, { indoor = null } = {}) {
  if (L.markets !== "football") return null;
  const comp = sum?.header?.competitions?.[0];
  const venue = sum?.gameInfo?.venue;
  if (!comp?.date || !venue) return null;
  const name = venue.fullName || "";
  if (indoor == null) indoor = COVERED.test(name) ? true : await indoorFlag(L, sum);
  if (indoor || COVERED.test(name)) return { indoor: true, venue: name };
  const kick = new Date(comp.date);
  if (kick - Date.now() > 15 * 864e5) return null;
  const c = await coords(venue);
  if (!c) return null;
  const end = new Date(kick.getTime() + 4 * 3600e3);
  const f = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&hourly=temperature_2m,precipitation,snowfall,wind_speed_10m,wind_gusts_10m,weather_code&wind_speed_unit=mph&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=UTC&start_date=${iso(kick)}&end_date=${iso(end)}`, 60 * 60e3);
  const h = f.hourly;
  if (!h?.time) return null;
  // Kickoff through the next three hours.
  const idx = h.time.map((t, i) => [new Date(`${t}:00Z`).getTime(), i]).filter(([t]) => t >= kick.getTime() - 30 * 60e3 && t <= kick.getTime() + 3 * 3600e3).map(([, i]) => i);
  if (!idx.length) return null;
  const avg = (k) => idx.reduce((s, i) => s + (h[k][i] ?? 0), 0) / idx.length;
  const max = (k) => Math.max(...idx.map((i) => h[k][i] ?? 0));
  const tot = (k) => idx.reduce((s, i) => s + (h[k][i] ?? 0), 0);
  return {
    indoor: false, venue: name, at: comp.date,
    wind: Math.round(avg("wind_speed_10m")), gust: Math.round(max("wind_gusts_10m")), temp: Math.round(avg("temperature_2m")),
    precip: Math.round(tot("precipitation") * 100) / 100, snow: Math.round(tot("snowfall") * 10) / 10, desc: WMO(max("weather_code")),
  };
}

// Multipliers for scoring, passing and rushing. Rough fits to NFL weather splits:
// each mph of sustained wind above 10 costs ~1.2% of passing and ~0.75% of scoring.
export function weatherEffect(w) {
  if (!w || w.indoor || w.wind == null) return null;
  const windX = Math.max(0, w.wind - 10);
  const wet = w.precip >= 0.1, soaked = w.precip >= 0.3, snow = w.snow >= 0.2, cold = w.temp <= 25;
  const total = clamp(1 - 0.0075 * windX - (wet ? 0.02 : 0) - (soaked ? 0.02 : 0) - (snow ? 0.04 : 0) - (cold ? 0.02 : 0), 0.82, 1);
  const pass = clamp(1 - 0.012 * windX - (wet ? 0.03 : 0) - (soaked ? 0.03 : 0) - (snow ? 0.05 : 0) - (cold ? 0.02 : 0), 0.75, 1);
  const rush = clamp(1 + 0.004 * windX + (wet || snow ? 0.02 : 0), 1, 1.08);
  const why = [windX > 0 && `${w.wind} mph wind${w.gust >= w.wind + 8 ? ` (gusts ${w.gust})` : ""}`, snow ? `${w.snow}" snow` : wet ? (soaked ? "heavy rain" : "rain") : "", cold && `${w.temp}°F`].filter(Boolean);
  return { total, pass, rush, significant: total < 0.985 || pass < 0.985, why: why.join(", ") };
}

export function weatherLine(w) {
  if (!w) return "";
  if (w.indoor) return "🏟️ Indoors / roof";
  return [`${w.wind >= 15 ? "🌬️" : "💨"} ${w.wind} mph${w.gust >= w.wind + 8 ? `, gusts ${w.gust}` : ""}`, `${w.temp}°F`, w.desc, w.snow >= 0.2 ? `${w.snow}" snow` : w.precip >= 0.05 ? `${w.precip}" rain` : ""].filter(Boolean).join(" · ");
}

// Which way each football market leans in weather.
// Wind cuts passing efficiency (yards per throw) more than volume, so attempts,
// completions, targets and catches take half the passing effect.
const GROUP = {
  pass_yds: "pass", pass_td: "pass", rec_yds: "pass", long_rec: "pass", pass_att: "vol", pass_cmp: "vol", rec: "vol", tgt: "vol",
  rush_att: "rush", rush_yds: "rush", long_rush: "rush", rush_rec_yds: "mix", pass_rush_yds: "qb", any_td: "total",
};

// Prop multiplier. With a Vegas total in play, the total already prices the weather and
// the Vegas adjustment passed it on with this market's elasticity (el), so divide that
// part out: the combined effect then equals the weather estimate.
export function weatherPropFactor(eff, marketKey, el = 0) {
  if (!eff?.significant) return null;
  const g = GROUP[marketKey];
  if (!g) return null;
  let f = g === "pass" ? eff.pass : g === "vol" ? 1 - (1 - eff.pass) / 2 : g === "rush" ? eff.rush : g === "mix" ? (eff.pass + eff.rush) / 2 : g === "qb" ? 0.85 * eff.pass + 0.15 * eff.rush : eff.total;
  if (el > 0) f /= Math.pow(eff.total, el);
  f = clamp(f, 0.75, 1.12);
  return Math.abs(f - 1) < 0.005 ? null : f;
}
