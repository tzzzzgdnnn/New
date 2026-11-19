// Kids profiles: the single source of truth for what a child may see.
//
// Rule: a title is shown only when TMDB's US certification is on the list
// below. Movies: G, PG. Shows: TV-Y, TV-Y7, TV-G. Anime follows the same rule
// by media type (TMDB), and HiAnime/MAL-style ratings allow "G" and "PG" only.
// Anything without a certification (unrated, "NR", no US entry, lookup
// failed) is hidden. List responses from TMDB are filtered here before any
// screen sees them (tmdbFetch calls filterKidsResponse), and every surface
// that shows titles from somewhere else (history, My List, downloads, curated
// rows, restored navigation) checks them through the same functions.
//
// This module has no React and no imports from the TMDB client: callers pass a
// `fetchJson(path)` that returns TMDB JSON, so it is testable on its own.

/** US certifications a Kids profile may watch, per media type. */
export const KIDS_ALLOWED = Object.freeze({
  movie: Object.freeze(["G", "PG"]),
  tv: Object.freeze(["TV-Y", "TV-Y7", "TV-G"]),
});

/** HiAnime / MyAnimeList-style ratings a Kids profile may watch. */
export const KIDS_ANIME_ALLOWED = Object.freeze(["G", "PG"]);

/** Bump when the rule changes so cached kid-filtered lists are not reused. */
export const KIDS_FILTER_VERSION = 2;

/** Highest minimum age (age-rating helpers) for a Kids profile; PG maps to 7. */
export const KIDS_MAX_AGE = 7;

/** TMDB genre ids never shown to Kids (a fast first pass; ratings decide). */
const KIDS_EXCLUDED_GENRES = new Set([27, 80, 10752, 10768]);

// ── Certifications ──────────────────────────────────────────────────────────

/** "tv-y7-fv" -> "TV-Y7", " pg " -> "PG", "NR"/"" -> null. */
export function normalizeCert(cert) {
  if (cert == null) return null;
  let c = String(cert).trim().toUpperCase().replace(/\s+/g, "");
  if (!c) return null;
  if (c === "TV-Y7-FV") c = "TV-Y7";
  if (["NR", "NOTRATED", "UNRATED", "N/A", "NA", "UR"].includes(c)) return null;
  return c;
}

/**
 * Whether a certification is allowed for a media type. Unrated is never allowed.
 * @param {"movie"|"tv"} mediaType
 * @param {string|null} cert
 */
export function isCertAllowed(mediaType, cert) {
  const c = normalizeCert(cert);
  if (!c) return false;
  const list = KIDS_ALLOWED[mediaType === "tv" ? "tv" : "movie"];
  return list.includes(c);
}

/**
 * HiAnime / MAL rating ("G - All Ages", "PG - Children", "PG-13 - Teens 13 or
 * older", "R - 17+", "R+", "Rx") -> allowed for Kids? Missing -> false.
 */
export function isAnimeRatingAllowed(rating) {
  if (rating == null) return false;
  const r = String(rating).trim().toUpperCase();
  if (!r || /^PG-?13/.test(r)) return false;
  return /^G(\b|$)/.test(r) || /^PG(\b|$)/.test(r);
}

/** US certification of a movie from /movie/{id}/release_dates, or null. */
export function movieCertFromReleaseDates(data) {
  const us = (data?.results || []).find((r) => r?.iso_3166_1 === "US");
  const dates = us?.release_dates || [];
  // Theatrical (3) first, then limited (2), then everything else.
  const order = [3, 2, 1, 4, 5, 6];
  const sorted = [...dates].sort((a, b) => {
    const ia = order.indexOf(a?.type);
    const ib = order.indexOf(b?.type);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const d of sorted) {
    const c = normalizeCert(d?.certification);
    if (c) return c;
  }
  return null;
}

/** US rating of a show from /tv/{id}/content_ratings, or null. */
export function tvCertFromContentRatings(data) {
  const us = (data?.results || []).find((r) => r?.iso_3166_1 === "US");
  return normalizeCert(us?.rating);
}

// ── Items ───────────────────────────────────────────────────────────────────

/** "movie" | "tv" for a TMDB item (or a hint for lists without media_type). */
export function mediaTypeOf(item, hint) {
  const mt = item?.media_type || item?.mediaType;
  if (mt === "movie" || mt === "tv") return mt;
  if (hint === "movie" || hint === "tv") return hint;
  if (item?.first_air_date || (item?.name && !item?.title)) return "tv";
  return "movie";
}

// Downloads carry their own `id`; the TMDB id is `tmdbId` there.
const idOf = (item) => (item?.tmdbId != null ? item.tmdbId : item?.id ?? null);
export const kidsKey = (mediaType, id) => `${mediaType === "tv" ? "tv" : "movie"}_${id}`;

/** Sync first pass: adult flag and excluded genres. */
export function isKidSafe(item) {
  if (item?.adult === true) return false;
  const g = Array.isArray(item?.genre_ids)
    ? item.genre_ids
    : Array.isArray(item?.genres)
      ? item.genres.map((x) => x?.id)
      : [];
  return !g.some((id) => KIDS_EXCLUDED_GENRES.has(id));
}

/** Legacy sync filter for `{ results }` responses (adult flag + genres). */
export function filterKidSafeResults(data) {
  if (!Array.isArray(data?.results)) return data;
  const results = data.results.filter(isKidSafe);
  return results.length === data.results.length ? data : { ...data, results };
}

// ── Certification cache (global: a rating is a fact about the title) ────────

const CACHE_KEY = "sb_kids_cert_v1";
const RATED_TTL = 30 * 24 * 60 * 60 * 1000;
const UNRATED_TTL = 24 * 60 * 60 * 1000;
const CACHE_MAX = 4000;
let _mem = null;
const _pending = new Map();

function mem() {
  if (_mem) return _mem;
  _mem = new Map();
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY) || "{}");
    for (const [k, v] of Object.entries(raw || {})) if (v && v.t) _mem.set(k, v);
  } catch {}
  return _mem;
}

let _saveTimer = null;
function persist() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const m = mem();
      if (m.size > CACHE_MAX) {
        const old = [...m.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, m.size - CACHE_MAX);
        old.forEach(([k]) => m.delete(k));
      }
      globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(m)));
    } catch {}
  }, 300);
}

function fresh(entry) {
  if (!entry) return false;
  const ttl = entry.c ? RATED_TTL : UNRATED_TTL;
  return Date.now() - entry.t < ttl;
}

/** Test/maintenance hook: forget every cached certification. */
export function clearKidsCertCache() {
  _mem = new Map();
  _pending.clear();
  try {
    globalThis.localStorage?.removeItem(CACHE_KEY);
  } catch {}
}

/** Record a known certification (null = unrated). */
export function rememberKidsCert(mediaType, id, cert) {
  mem().set(kidsKey(mediaType, id), { c: normalizeCert(cert), t: Date.now() });
  persist();
}

/** Cached certification: string, null (unrated), or undefined (not known yet). */
export function cachedKidsCert(mediaType, id) {
  const e = mem().get(kidsKey(mediaType, id));
  return fresh(e) ? e.c : undefined;
}

/**
 * Sync verdict from the cache: true (allowed), false (blocked or unrated) or
 * undefined (not looked up yet; treat as hidden).
 */
export function cachedKidsVerdict(item, hint) {
  const id = idOf(item);
  if (id == null) return false;
  if (item?.adult === true) return false;
  const mt = mediaTypeOf(item, hint);
  const c = cachedKidsCert(mt, id);
  return c === undefined ? undefined : isCertAllowed(mt, c);
}

/** Sync "may show now": only titles already verified as allowed. */
export const isKidsAllowedNow = (item, hint) => cachedKidsVerdict(item, hint) === true;

/**
 * Look up (and cache) a title's US certification. A failed lookup is not
 * cached and resolves to null, so the title stays hidden.
 * @param {"movie"|"tv"} mediaType
 * @param {number|string} id
 * @param {(path: string) => Promise<object>} fetchJson
 */
export function resolveKidsCert(mediaType, id, fetchJson) {
  const mt = mediaType === "tv" ? "tv" : "movie";
  const cached = cachedKidsCert(mt, id);
  if (cached !== undefined) return Promise.resolve(cached);
  const key = kidsKey(mt, id);
  if (_pending.has(key)) return _pending.get(key);
  const path = mt === "tv" ? `/tv/${id}/content_ratings` : `/movie/${id}/release_dates`;
  const p = Promise.resolve()
    .then(() => fetchJson(path))
    .then((data) => {
      const cert = mt === "tv" ? tvCertFromContentRatings(data) : movieCertFromReleaseDates(data);
      rememberKidsCert(mt, id, cert);
      return cert;
    })
    .catch(() => null)
    .finally(() => _pending.delete(key));
  _pending.set(key, p);
  return p;
}

/** Whether a title may be shown/played on a Kids profile (looks it up if needed). */
export async function resolveKidsVerdict(item, fetchJson, hint) {
  const id = idOf(item);
  if (id == null || item?.adult === true) return false;
  const mt = mediaTypeOf(item, hint);
  const cert = await resolveKidsCert(mt, id, fetchJson);
  return isCertAllowed(mt, cert);
}

/** Keep only allowed titles, in order. Unrated or unknown titles are dropped. */
export async function filterKidsItems(items, fetchJson, hint) {
  const list = Array.isArray(items) ? items : [];
  const ok = await Promise.all(list.map((it) => resolveKidsVerdict(it, fetchJson, hint).catch(() => false)));
  return list.filter((_, i) => ok[i]);
}

// ── TMDB request rewriting and list responses ───────────────────────────────

const enc = (s) => encodeURIComponent(s);

/** Discover query params that ask TMDB for kid-rated titles only. */
export function kidsDiscoverParams(mediaType) {
  const certs = KIDS_ALLOWED[mediaType === "tv" ? "tv" : "movie"].join("|");
  return `certification_country=US&certification=${enc(certs)}&include_adult=false`;
}

/**
 * Path a Kids profile requests instead: search and discover never include
 * adult titles, and discover asks for kid certifications up front.
 */
export function kidsRewritePath(path) {
  const p = String(path || "");
  const [base] = p.split("?");
  const add = (extra) => p + (p.includes("?") ? "&" : "?") + extra;
  const disc = base.match(/^\/discover\/(movie|tv)$/);
  if (disc) {
    if (/[?&]certification(=|\.)/.test(p)) return /[?&]include_adult=/.test(p) ? p : add("include_adult=false");
    return add(kidsDiscoverParams(disc[1]));
  }
  if (/^\/search\//.test(base) && !/[?&]include_adult=/.test(p)) return add("include_adult=false");
  return p;
}

/**
 * For a TMDB path that returns titles: which arrays hold them and the media
 * type to assume when items carry none. null for everything else (details,
 * ratings, images, seasons...).
 */
export function kidsListShape(path) {
  const base = String(path || "").split("?")[0];
  let m;
  if ((m = base.match(/^\/(search|discover)\/(movie|tv)$/))) return { keys: ["results"], hint: m[2] };
  if (/^\/search\/multi$/.test(base)) return { keys: ["results"], hint: null };
  if ((m = base.match(/^\/trending\/(movie|tv|all)\/(day|week)$/))) return { keys: ["results"], hint: m[1] === "all" ? null : m[1] };
  if ((m = base.match(/^\/(movie|tv)\/(popular|top_rated|now_playing|upcoming|on_the_air|airing_today)$/))) return { keys: ["results"], hint: m[1] };
  if ((m = base.match(/^\/(movie|tv)\/\d+\/(recommendations|similar)$/))) return { keys: ["results"], hint: m[1] };
  if (/^\/collection\/\d+$/.test(base)) return { keys: ["parts"], hint: "movie" };
  if ((m = base.match(/^\/person\/\d+\/(combined_credits|movie_credits|tv_credits)$/)))
    return { keys: ["cast", "crew"], hint: m[1] === "movie_credits" ? "movie" : m[1] === "tv_credits" ? "tv" : null };
  if (/^\/(keyword|company|network)\/\d+\/(movies|tv)$/.test(base)) return { keys: ["results"], hint: base.endsWith("/tv") ? "tv" : "movie" };
  return null;
}

/**
 * Kids view of a TMDB response: title lists keep only allowed titles (people
 * and anything unrated are dropped). Other responses are returned unchanged.
 */
export async function filterKidsResponse(path, data, fetchJson) {
  const shape = kidsListShape(path);
  if (!shape || !data || typeof data !== "object") return data;
  const out = { ...data };
  for (const key of shape.keys) {
    if (!Array.isArray(data[key])) continue;
    const titles = data[key].filter((it) => it && it.media_type !== "person" && isKidSafe(it));
    out[key] = await filterKidsItems(titles, fetchJson, shape.hint);
  }
  return out;
}
