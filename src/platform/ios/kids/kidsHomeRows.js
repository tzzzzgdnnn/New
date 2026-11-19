// Kids Home data (pure, no React): which rows a Kids profile gets and the
// genres it can browse. Every row is built only from the profile's own
// lists (watch history, My List, favorite characters' shows) plus
// favorite-genre rows from discover; there is no trending, Top 10 or
// in-theaters row. Rows are filtered by the Kids rules in KidsHome.jsx.

/** Row ids a Kids Home may show, in order. */
export const KIDS_HOME_ROWS = Object.freeze(["continue", "favorites", "myList", "watchAgain", "genres"]);

/** TMDB endpoints a Kids Home must never request (feeds, charts, theaters). */
export const KIDS_HOME_BANNED = /^\/(trending\/|movie\/(now_playing|upcoming|popular|top_rated)|tv\/(popular|top_rated|on_the_air|airing_today))/;

/** Genres a Kids profile can browse; TMDB ids differ between movies and TV. */
export const KIDS_GENRES = Object.freeze([
  { key: "animation", name: "Cartoons", emoji: "🎨", movie: 16, tv: 16 },
  { key: "family", name: "Family", emoji: "🏡", movie: 10751, tv: 10751 },
  { key: "kids", name: "Kids TV", emoji: "🧸", movie: null, tv: 10762 },
  { key: "comedy", name: "Funny", emoji: "😂", movie: 35, tv: 35 },
  { key: "adventure", name: "Adventure", emoji: "🗺️", movie: 12, tv: 10759 },
  { key: "fantasy", name: "Magic", emoji: "🪄", movie: 14, tv: 10765 },
  { key: "music", name: "Music", emoji: "🎵", movie: 10402, tv: null },
]);

const typeOf = (i) => (i?.media_type === "tv" || i?.mediaType === "tv" || (!i?.title && i?.name) ? "tv" : "movie");
const keyOf = (i) => `${typeOf(i)}_${i?.id ?? i?.tmdbId}`;

/** Unique items, first occurrence kept; items without an id are dropped. */
export function uniqueItems(list) {
  const seen = new Set();
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || (it.id == null && it.tmdbId == null)) continue;
    const k = keyOf(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/** Watch history, newest first, one entry per title. */
export function historyTitles(history, cap = 20) {
  const list = [...(Array.isArray(history) ? history : [])].sort((a, b) => (b?.watchedAt || 0) - (a?.watchedAt || 0));
  return uniqueItems(list.map((h) => ({ ...h, media_type: typeOf(h) }))).slice(0, cap);
}

/** Shows of the picked favorite characters, in pick order. */
export function favoriteShows(characters, favoriteKeys) {
  const keys = Array.isArray(favoriteKeys) ? favoriteKeys : [];
  const byKey = new Map((characters || []).map((c) => [c.key, c]));
  return uniqueItems(keys.map((k) => byKey.get(k)?.item).filter(Boolean));
}

/** Kids genres ranked by how often they appear across the given titles. */
export function favoriteGenres(items, n = 3) {
  const score = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const t = typeOf(it);
    for (const gid of it?.genre_ids || (it?.genres || []).map((g) => g.id) || []) {
      const g = KIDS_GENRES.find((x) => x[t] === gid);
      if (g) score.set(g.key, (score.get(g.key) || 0) + 1);
    }
  }
  const ranked = KIDS_GENRES.filter((g) => score.has(g.key)).sort((a, b) => score.get(b.key) - score.get(a.key));
  // Nothing to go on yet: start with cartoons and family.
  return (ranked.length ? ranked : KIDS_GENRES.slice(0, 2)).slice(0, n);
}

/** Discover paths for one genre (kids certifications are added by tmdbFetch). */
export function genrePaths(genre) {
  const out = [];
  if (genre?.movie) out.push({ path: `/discover/movie?with_genres=${genre.movie}&sort_by=popularity.desc`, type: "movie" });
  if (genre?.tv) out.push({ path: `/discover/tv?with_genres=${genre.tv}&sort_by=popularity.desc`, type: "tv" });
  return out;
}
