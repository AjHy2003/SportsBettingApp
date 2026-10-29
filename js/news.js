// Sports news and video highlights from ESPN (no DOM; the daily picks job uses it too).
//   - leagueNews: headlines, stories and videos for a league (optionally one team).
//   - gameHighlights: the highlight package for every finished game, yesterday + today
//     (this week + last week for football), straight from the scoreboards.
//   - resolveClip: turns a video from the news feed into a playable MP4.
import { getJSON } from "./espn.js";

const SITE = "https://site.web.api.espn.com/apis/site/v2/sports";
const https = (u) => (u ? String(u).replace(/^http:\/\//, "https://") : null);

const etYmd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replaceAll("-", "");

// A playable clip from any ESPN video object, or null when there's no MP4.
export function videoOf(v, extra = {}) {
  const src = v?.links?.source;
  const mp4 = https(src?.HD?.href || src?.href || v?.links?.mobile?.source?.href);
  if (!mp4 || !/\.mp4(\?|$)/.test(mp4)) return null;
  return {
    id: String(v.id),
    headline: v.headline || v.title || "",
    description: v.description && v.description !== v.headline ? v.description : "",
    duration: v.duration || null,
    thumb: https(v.thumbnail || v.posterImages?.default?.href || v.images?.[0]?.url),
    mp4,
    web: https(v.links?.web?.href) || `https://www.espn.com/video/clip/_/id/${v.id}`,
    published: v.originalPublishDate || v.lastModified || null,
    ...extra,
  };
}

const KIND = { Media: "video", HeadlineNews: "news", Story: "story", Recap: "recap", Preview: "preview" };

function bestImage(images) {
  const list = (images || []).filter((i) => i?.url);
  const wide = list.find((i) => (i.width || 0) >= 400 && (!i.height || i.width / i.height > 1.2));
  return https((wide || list[0])?.url);
}

export function articleOf(a, L) {
  const cats = a.categories || [];
  // Some feeds (player news) embed the video itself.
  const vid = a.type === "Media" && Array.isArray(a.video) ? videoOf(a.video[0]) : null;
  return {
    ...(vid ? { mp4: vid.mp4, thumb: vid.thumb, duration: vid.duration, web: vid.web } : {}),
    id: String(a.id),
    kind: KIND[a.type] || "story",
    headline: a.headline || a.linkText || "",
    description: a.description || "",
    published: a.published || a.lastModified || null,
    image: bestImage(a.images),
    url: https(a.links?.web?.href),
    clipApi: a.type === "Media" ? https(a.links?.api?.self?.href) : null,
    byline: a.byline || "",
    premium: !!a.premium,
    athletes: cats.filter((c) => c.type === "athlete" && c.athleteId).map((c) => String(c.athleteId)),
    teams: cats.filter((c) => c.type === "team" && c.teamId).map((c) => String(c.teamId)),
    league: L.id,
  };
}

export async function leagueNews(L, { limit = 30, team = null } = {}) {
  const d = await getJSON(`${SITE}/${L.espn}/news?limit=${limit}${team ? `&team=${team}` : ""}`, 10 * 60e3);
  return (d.articles || []).map((a) => articleOf(a, L)).filter((a) => a.headline && (a.url || a.clipApi));
}

// News feed videos carry no MP4; ESPN's clip API has it.
export async function resolveClip(article) {
  if (!article?.clipApi) return null;
  const d = await getJSON(article.clipApi, 60 * 60e3);
  return videoOf(d.videos?.[0], { league: article.league });
}

// Scoreboards to scan for finished games: yesterday + today for daily sports,
// this week + last week for football.
async function boards(L) {
  if (L.id === "nfl" || L.id === "ncaaf") {
    const cur = await getJSON(`${SITE}/${L.espn}/scoreboard`, 5 * 60e3);
    const wk = cur.week?.number, type = cur.season?.type;
    const prev = wk > 1 ? await getJSON(`${SITE}/${L.espn}/scoreboard?week=${wk - 1}&seasontype=${type}`, 60 * 60e3).catch(() => null) : null;
    return [cur, prev].filter(Boolean);
  }
  const now = new Date();
  return Promise.all([etYmd(new Date(now - 864e5)), etYmd(now)].map((d) => getJSON(`${SITE}/${L.espn}/scoreboard?dates=${d}`, 5 * 60e3).catch(() => null))).then((x) => x.filter(Boolean));
}

export async function gameHighlights(L) {
  const out = [];
  for (const b of await boards(L)) {
    for (const e of b.events || []) {
      const comp = e.competitions?.[0];
      const state = e.status?.type?.state;
      if (!comp || state === "pre") continue;
      const cs = comp.competitors || [];
      const teams = [cs.find((c) => c.homeAway === "away"), cs.find((c) => c.homeAway === "home")].filter(Boolean);
      const score = teams.map((c) => `${c.team?.abbreviation} ${c.score ?? ""}`.trim()).join(" – ");
      for (const h of comp.highlights || []) {
        const v = videoOf(h, {
          league: L.id, eventId: String(e.id), gameHref: `#/l/${L.id}/g/${e.id}`, gameDate: e.date,
          matchup: teams.map((c) => c.team?.abbreviation).join(" @ "),
          score, status: e.status?.type?.shortDetail || "", final: state === "post",
          teams: teams.map((c) => String(c.team?.id)),
        });
        if (v) out.push(v);
      }
    }
  }
  const seen = new Set();
  return out.filter((v) => !seen.has(v.id) && seen.add(v.id)).sort((a, b) => new Date(b.published || b.gameDate) - new Date(a.published || a.gameDate));
}

// Every clip from one game summary (individual plays + the highlight package).
export const summaryClips = (sum, extra = {}) => (sum?.videos || []).map((v) => videoOf(v, extra)).filter(Boolean);

export const isStory = (a) => a.kind === "news" || a.kind === "story";

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return "";
  const m = Math.round((now - new Date(iso).getTime()) / 60e3);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const fmtDuration = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");
