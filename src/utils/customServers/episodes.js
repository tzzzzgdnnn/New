// Custom servers: episode numbers that differ from TMDB's. Anime sites often
// count episodes from 1 across every season (absolute numbering: One Piece
// 1071), and some sites split or merge seasons (TMDB S1E13 is the site's
// S2E1). Map by position when the counts line up, otherwise by air date or
// episode title. Pure logic.
import { similarity } from "./idmap";

/**
 * Episode counts per real season (specials, season 0, left out).
 * @param {{ seasons?: Array<{ season_number, episode_count }> }} tv TMDB /tv/{id}
 * @returns {Array<{ season: number, count: number }>}
 */
export function seasonCounts(tv) {
  return (tv?.seasons || [])
    .filter((s) => Number(s.season_number) > 0 && Number(s.episode_count) > 0)
    .map((s) => ({ season: Number(s.season_number), count: Number(s.episode_count) }))
    .sort((a, b) => a.season - b.season);
}

/** TMDB season + episode -> absolute number (1-based), or null when out of range. */
export function toAbsolute(counts, season, episode) {
  const s = Number(season);
  const e = Number(episode);
  if (!counts?.length || !(s > 0) || !(e > 0)) return null;
  let n = 0;
  for (const c of counts) {
    if (c.season === s) return e <= c.count || c === counts[counts.length - 1] ? n + e : null;
    n += c.count;
  }
  return null;
}

/** Absolute number -> TMDB { season, episode }, or null. */
export function fromAbsolute(counts, absolute) {
  let left = Number(absolute);
  if (!counts?.length || !(left > 0)) return null;
  for (const c of counts) {
    if (left <= c.count) return { season: c.season, episode: left };
    left -= c.count;
  }
  const last = counts[counts.length - 1];
  return { season: last.season, episode: last.count + left }; // newer than TMDB's count
}

/**
 * How a site numbers episodes, read from the sample link: no season in the
 * link and a show with more than one season (or a number past season 1's
 * count) means absolute numbering.
 * @returns {"season"|"absolute"|"single"}
 */
export function numberingFor({ hasSeason, episode, counts }) {
  if (hasSeason) return "season";
  if (!counts?.length) return "single";
  if (counts.length > 1 || Number(episode) > counts[0].count) return "absolute";
  return "single";
}

const day = (d) => {
  const t = Date.parse(String(d || "").slice(0, 10));
  return Number.isFinite(t) ? Math.round(t / 86400000) : null;
};

/**
 * The site's episode for one TMDB episode, when the numbers don't line up:
 * same air date (a day either way, for time zones), else the same title.
 * @param {{ airDate?, name? }} want the TMDB episode
 * @param {Array<{ season?, number, airDate?, title? }>} siteEpisodes the site's list
 * @returns {object|null} the site's episode
 */
export function matchEpisode(want, siteEpisodes) {
  const list = siteEpisodes || [];
  const d = day(want?.airDate);
  if (d != null) {
    const same = list.filter((e) => day(e.airDate) === d);
    if (same.length === 1) return same[0];
    const near = list.filter((e) => day(e.airDate) != null && Math.abs(day(e.airDate) - d) <= 1);
    if (near.length === 1) return near[0];
    if (same.length > 1 && want?.name) return best(same, want.name, 0.5) || same[0];
  }
  if (want?.name && !/^episode\s*\d+$/i.test(want.name)) return best(list, want.name, 0.85);
  return null;
}

function best(list, name, min) {
  let top = null;
  let score = min;
  for (const e of list) {
    const s = similarity(e.title, name);
    if (s >= score) {
      top = e;
      score = s;
    }
  }
  return top;
}

/**
 * Season / episode / absolute for a site, from TMDB's numbers.
 * @param {{ season, episode }} tmdbEp
 * @param {{ counts?, numbering?, offsets?, siteEpisodes?, airDate?, name? }} o
 *   offsets: learned split-season ranges (learnOffsets), kept per title per site
 */
export function siteNumbers(tmdbEp, { counts, offsets, siteEpisodes, airDate, name } = {}) {
  const season = Number(tmdbEp.season) || 1;
  const episode = Number(tmdbEp.episode) || 1;
  const absolute = toAbsolute(counts, season, episode);
  if (siteEpisodes?.length) {
    const hit = matchEpisode({ airDate, name }, siteEpisodes);
    if (hit) return { season: hit.season ?? season, episode: hit.number, absolute: absolute ?? hit.number, via: "match" };
  }
  const off = fromOffsets(offsets, season, episode);
  if (off) return { ...off, absolute, via: "offset" };
  return { season, episode, absolute, via: "tmdb" };
}

/**
 * Learn split seasons from two dated lists: for each TMDB season, which site
 * season holds its first episode, and from which episode on.
 * @param {Array<{ season, episode, airDate }>} tmdbEps
 * @param {Array<{ season, number, airDate }>} siteEps
 */
export function learnOffsets(tmdbEps, siteEps) {
  const out = {};
  const bySeason = new Map();
  for (const e of tmdbEps || []) {
    const hit = matchEpisode({ airDate: e.airDate }, siteEps);
    if (!hit || hit.season == null) continue;
    // A TMDB season whose second half the site calls a new season: start a new range.
    const k = String(e.season);
    const prev = bySeason.get(k);
    if (!prev || prev.season !== hit.season) {
      const start = e.episode - hit.number + 1;
      bySeason.set(k, { season: hit.season, start });
      if (!out[k]) out[k] = [];
      out[k].push({ from: e.episode, season: hit.season, start });
    }
  }
  return out;
}

/** Site numbers from learned ranges (learnOffsets), or null. */
export function fromOffsets(ranges, season, episode) {
  const list = ranges?.[String(season)];
  if (!list?.length) return null;
  const r = [...list].reverse().find((x) => episode >= x.from);
  return r ? { season: r.season, episode: episode - r.start + 1 } : null;
}
