// Avatar sources for the picker, all fetched at runtime from TMDB (no image
// files are bundled): character art from the Nostalgia titles, this week's
// trending titles and a title search. Lists are cached for CACHE_TTL_MS.
import { tmdbFetch } from "../../../utils/api";
import { secureStorage, storage, STORAGE_KEYS } from "../../../utils/storage";
import NOSTALGIA from "../nostalgia.json";

/** How long fetched avatar lists stay cached. */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Avatars per title row. */
export const MIN_ROW_AVATARS = 6;
export const MAX_ROW_AVATARS = 10;

const CACHE_KEY = "avatarCatalog";
const ANIMATION_GENRE = 16;
const BACKDROP_SHARE = 6; // of MAX_ROW_AVATARS; posters fill the rest
const SEARCH_RESULTS = 6;
const IMAGE_LANGS = "en,null";

// Never offered as an avatar source (by id and by name).
const EXCLUDED_TV_IDS = new Set([66732]);
const EXCLUDED_NAME = /stranger\s+things/i;

/** Channels in the order their titles appear (matches the Nostalgia rails). */
const CHANNEL_ORDER = ["Cartoon Network", "Nickelodeon", "Disney", "Toonami", "Boomerang", "Other", "Movies"];

const CHANNEL_LABELS = { Other: "More Classics", Movies: "Childhood Movies" };

const BUILTIN_TMDB_TOKEN = (import.meta.env.VITE_TMDB_TOKEN || "").trim();

/** TMDB token the app uses: the one saved in Settings, else the built-in one. */
export async function getTmdbToken() {
  return (await secureStorage.get(STORAGE_KEYS.API_KEY)) || BUILTIN_TMDB_TOKEN || null;
}

const isExcluded = (type, id, name) =>
  (type === "tv" && EXCLUDED_TV_IDS.has(Number(id))) || EXCLUDED_NAME.test(name || "");

// ── Cache ────────────────────────────────────────────────────────────────

function readCache() {
  const c = storage.get(CACHE_KEY);
  return c && typeof c === "object" ? c : {};
}

function cached(slot) {
  const entry = readCache()[slot];
  return entry && Date.now() - entry.ts < CACHE_TTL_MS ? entry.value : undefined;
}

function remember(slot, value) {
  const c = readCache();
  const now = Date.now();
  for (const [k, v] of Object.entries(c)) if (!(now - v?.ts < CACHE_TTL_MS)) delete c[k];
  c[slot] = { ts: now, value };
  storage.set(CACHE_KEY, c);
  return value;
}

// ── Nostalgia titles ─────────────────────────────────────────────────────

/**
 * Nostalgia titles grouped by channel, live-action included (rows check for
 * animation once loaded).
 * @returns {{channel: string, titles: {type: "tv"|"movie", id: number, name: string}[]}[]}
 */
export function nostalgiaChannels() {
  const groups = new Map(CHANNEL_ORDER.map((c) => [c, []]));
  const add = (channel, type, e) => {
    if (!e?.tmdb_id || isExcluded(type, e.tmdb_id, e.title)) return;
    groups.get(channel).push({ type, id: e.tmdb_id, name: e.title });
  };
  (NOSTALGIA.tv || []).forEach((e) => add(groups.has(e.network) ? e.network : "Other", "tv", e));
  (NOSTALGIA.anime || []).forEach((e) => add("Toonami", e.type === "movie" ? "movie" : "tv", e));
  (NOSTALGIA.movies || []).forEach((e) => add("Movies", "movie", e));
  return CHANNEL_ORDER.map((channel) => ({ channel: CHANNEL_LABELS[channel] || channel, titles: groups.get(channel) })).filter(
    (g) => g.titles.length,
  );
}

const byVotes = (a, b) => (b.vote_average || 0) - (a.vote_average || 0);

// Textless backdrops (iso null) show the characters best; posters fill in.
function pickImages(images) {
  const backdrops = [...(images?.backdrops || [])].sort(
    (a, b) => (a.iso_639_1 === null ? 0 : 1) - (b.iso_639_1 === null ? 0 : 1) || byVotes(a, b),
  );
  const posters = [...(images?.posters || [])].sort(byVotes);
  const take = backdrops.slice(0, BACKDROP_SHARE);
  for (const p of posters) {
    if (take.length >= MAX_ROW_AVATARS) break;
    take.push(p);
  }
  for (const b of backdrops.slice(BACKDROP_SHARE)) {
    if (take.length >= MAX_ROW_AVATARS) break;
    take.push(b);
  }
  return take.map((i) => i.file_path).filter(Boolean);
}

/**
 * Avatar images for one title, from its own posters and backdrops.
 * @param {{type: "tv"|"movie", id: number}} title
 * @param {string} apiKey
 * @returns {Promise<{name: string, animated: boolean, images: string[]}>}
 */
export async function loadTitleAvatars({ type, id }, apiKey) {
  const slot = `t_${type}_${id}`;
  const hit = cached(slot);
  if (hit) return hit;
  const d = await tmdbFetch(`/${type}/${id}?append_to_response=images&include_image_language=${IMAGE_LANGS}`, apiKey);
  const name = d.title || d.name || "";
  const animated = (d.genres || []).some((g) => g.id === ANIMATION_GENRE);
  const images = isExcluded(type, id, name) ? [] : pickImages(d.images);
  return remember(slot, { name, animated, images });
}

// ── Trending ─────────────────────────────────────────────────────────────

const TRENDING_SOURCES = [
  { id: "tv", title: "Trending Shows", path: "/trending/tv/week", type: "tv" },
  { id: "movie", title: "Trending Movies", path: "/trending/movie/week", type: "movie" },
  {
    id: "anime",
    title: "Popular Anime",
    path: "/discover/tv?with_genres=16&with_original_language=ja&sort_by=popularity.desc",
    type: "tv",
  },
];

const toTitle = (type) => (r) => ({
  type,
  id: r.id,
  name: r.title || r.name || "",
  image: r.poster_path || r.backdrop_path || null,
});

const usable = (t) => t.image && !isExcluded(t.type, t.id, t.name);

/**
 * This week's trending rows, one avatar (the poster) per title.
 * @returns {Promise<{id: string, title: string, items: object[]}[]>}
 */
export async function loadTrending(apiKey) {
  const hit = cached("trending");
  if (hit) return hit;
  const rows = await Promise.all(
    TRENDING_SOURCES.map(async (s) => {
      const data = await tmdbFetch(s.path, apiKey);
      return { id: s.id, title: s.title, items: (data.results || []).map(toTitle(s.type)).filter(usable) };
    }),
  );
  return remember("trending", rows);
}

/**
 * Shows and movies matching a search, for per-title avatar rows.
 * @returns {Promise<{type: "tv"|"movie", id: number, name: string}[]>}
 */
export async function searchTitles(query, apiKey) {
  const q = query.trim();
  if (!q) return [];
  const data = await tmdbFetch(`/search/multi?query=${encodeURIComponent(q)}&include_adult=false`, apiKey);
  return (data.results || [])
    .filter((r) => r.media_type === "tv" || r.media_type === "movie")
    .map((r) => toTitle(r.media_type)(r))
    .filter(usable)
    .slice(0, SEARCH_RESULTS);
}
