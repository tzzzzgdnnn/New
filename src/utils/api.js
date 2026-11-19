import { isKidsProfileActive } from "./profileScope";
import {
  filterKidsResponse,
  kidsRewritePath,
  KIDS_FILTER_VERSION,
} from "../platform/ios/kids/kidsFilter.js";
import { storage } from "./storage";
import { serverCatalog, groupedLabel } from "./servers/catalog";

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p";

// ── TMDB metadata language ────────────────────────────────────────────────────
// Read lazily from localStorage so it always reflects the current setting.
// Falls back to "en-US".
function getTmdbLanguage() {
  try {
    const raw = localStorage.getItem("streambert_tmdbLang");
    return raw ? JSON.parse(raw) : "en-US";
  } catch {
    return "en-US";
  }
}

// Append the language query param to a TMDB path.
function withLanguage(path) {
  const lang = getTmdbLanguage();
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}language=${lang}`;
}

export const imgUrl = (path, size = "w500") =>
  path ? `${IMG_BASE}/${size}${path}` : null;

// Global auth-error callback, registered by App on mount
let _onAuthError = null;
let _onUnreachable = null;
export const setApiErrorHandlers = (onAuth, onUnreachable) => {
  _onAuthError = onAuth;
  _onUnreachable = onUnreachable;
};

// ── TMDB response cache: memory + storage, stale-while-revalidate ─────────
// Fresh for 5 minutes. After that the cached copy is still returned at once
// and a background request refreshes it. Copies are kept in localStorage
// (up to a day) so a cold start paints from cache instead of the network.
const _tmdbCache = new Map(); // key → { data, savedAt }
const _tmdbPending = new Map(); // key → Promise<data> (in-flight dedupe)
const TMDB_CACHE_TTL = 5 * 60 * 1000; // fresh window
const TMDB_STALE_MAX = 24 * 60 * 60 * 1000; // oldest copy still served
const TMDB_MEM_MAX = 200;
const TMDB_DISK_PREFIX = "sb_tmdb:";
const TMDB_DISK_MAX = 80;

const _diskKey = (key) => TMDB_DISK_PREFIX + key.slice(key.indexOf("|") + 1);

function _readDisk(key) {
  try {
    const raw = localStorage.getItem(_diskKey(key));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    return entry && entry.data !== undefined && entry.savedAt ? entry : null;
  } catch {
    return null;
  }
}

// One big detail response (a long-running show with credits) can be 100+ KB;
// 150 of those overran WebKit's ~5 MB localStorage quota, after which the
// app's own writes (progress, history, profiles) failed silently. Large
// responses stay in memory only.
const TMDB_DISK_ENTRY_MAX = 48 * 1024;

function _writeDisk(key, entry) {
  try {
    const json = JSON.stringify(entry);
    if (json.length > TMDB_DISK_ENTRY_MAX) return;
    localStorage.setItem(_diskKey(key), json);
  } catch {
    _pruneDisk(true);
  }
}

// Drop expired copies, and the oldest ones past the cap (or half on quota).
function _pruneDisk(aggressive = false) {
  try {
    const now = Date.now();
    const keep = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(TMDB_DISK_PREFIX)) continue;
      let savedAt = 0;
      try {
        savedAt = JSON.parse(localStorage.getItem(k))?.savedAt || 0;
      } catch {}
      if (now - savedAt > TMDB_STALE_MAX) localStorage.removeItem(k);
      else keep.push([k, savedAt]);
    }
    const cap = aggressive ? Math.floor(keep.length / 2) : TMDB_DISK_MAX;
    if (keep.length > cap) {
      keep.sort((a, b) => a[1] - b[1]);
      keep.slice(0, keep.length - cap).forEach(([k]) => localStorage.removeItem(k));
    }
  } catch {}
}
setTimeout(() => _pruneDisk(), 4000);

function _remember(key, data) {
  const entry = { data, savedAt: Date.now() };
  _tmdbCache.delete(key);
  _tmdbCache.set(key, entry);
  if (_tmdbCache.size > TMDB_MEM_MAX) _tmdbCache.delete(_tmdbCache.keys().next().value);
  _writeDisk(key, entry);
}

/** Clears the TMDB caches (memory and storage) and the persisted trending
 * cache. Called when the metadata language changes. */
export function clearTmdbCache() {
  _tmdbCache.clear();
  try {
    storage.remove(TRENDING_CACHE_KEY);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(TMDB_DISK_PREFIX)) localStorage.removeItem(k);
    }
  } catch {}
}

// ── Request queue (max 4 concurrent TMDB fetches) ────────────────────────────
// Prevents bursts of 10-20 parallel requests from carousel/similar-rows rapid
// navigation from hammering the API and triggering rate-limit responses.
let _inflight = 0;
const MAX_INFLIGHT = 4;
const _waiters = [];

function _acquireSlot() {
  if (_inflight < MAX_INFLIGHT) {
    _inflight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _waiters.push(resolve));
}

function _releaseSlot() {
  _inflight--;
  if (_waiters.length > 0) {
    _inflight++;
    _waiters.shift()();
  }
}

/**
 * TMDB GET with memory/disk cache.
 * @param {string} path e.g. "/movie/550"
 * @param {string} apiKey read access token
 * @param {{signal?: AbortSignal}} [opts] a signal makes the call cancellable
 *   (it then skips the shared in-flight request so aborting can't affect others)
 */
export const tmdbFetch = async (path, apiKey, opts = {}) => {
  // opts.kidsRaw: skip the Kids list filter. Only the Kids character catalog
  // uses it, and it verifies the one title it keeps (kidsCatalog.js).
  const view = (data) => (opts.kidsRaw ? data : forActiveProfile(path, data, apiKey));
  if (apiKey) _lastApiKey = apiKey;
  // Kids: search/discover never include adult titles and discover asks for
  // kid certifications; every title list is filtered before it is returned.
  if (isKidsProfileActive()) path = kidsRewritePath(path);
  const localizedPath = withLanguage(path);
  const cacheKey = `${apiKey}|${localizedPath}`;
  if (!apiKey) throw tmdbError("missing-token", "No TMDB token set. Add one in Settings.");
  let cached = _tmdbCache.get(cacheKey);
  if (!cached) {
    cached = _readDisk(cacheKey);
    if (cached) _tmdbCache.set(cacheKey, cached);
  }
  if (cached) {
    const age = Date.now() - cached.savedAt;
    if (age < TMDB_CACHE_TTL) return view(cached.data);
    if (age < TMDB_STALE_MAX) {
      // Stale: answer now, refresh quietly for next time.
      _tmdbNetwork(localizedPath, apiKey, cacheKey).catch(() => {});
      return view(cached.data);
    }
  }
  if (opts.signal) return view(await _tmdbRequest(localizedPath, apiKey, cacheKey, opts.signal));
  return view(await _tmdbNetwork(localizedPath, apiKey, cacheKey));
};

/** Error with a `code` and a message fit to show the viewer. */
function tmdbError(code, message, status) {
  const e = new Error(message);
  e.code = code;
  if (status) e.status = status;
  return e;
}

/** Short text for showing a TMDB failure to the viewer. */
export function describeTmdbError(err) {
  if (!err) return "Something went wrong.";
  if (err.name === "AbortError") return "";
  return err.message || "Something went wrong.";
}

/**
 * Warm the cache for a path (card press-in, hover). Never throws.
 * @param {string} path e.g. "/tv/1399"
 */
export const prefetchTmdb = (path, apiKey) => {
  if (!apiKey || !path) return;
  tmdbFetch(path, apiKey).catch(() => {});
};

function _tmdbNetwork(localizedPath, apiKey, cacheKey) {
  const inflight = _tmdbPending.get(cacheKey);
  if (inflight) return inflight;
  const p = _tmdbRequest(localizedPath, apiKey, cacheKey).finally(() =>
    _tmdbPending.delete(cacheKey),
  );
  _tmdbPending.set(cacheKey, p);
  return p;
}

// Network policy: each attempt times out after TMDB_TIMEOUT_MS; network
// errors, timeouts, 429 and 5xx are retried with backoff (429 honours
// Retry-After). 401/403 are not retried and report an invalid token.
const TMDB_TIMEOUT_MS = 12000;
const TMDB_RETRIES = 2;
const _sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

async function _tmdbRequest(localizedPath, apiKey, cacheKey, signal) {
  let lastErr = null;
  for (let attempt = 0; attempt <= TMDB_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (attempt > 0) await _sleep(lastErr?.retryAfterMs ?? 400 * 3 ** (attempt - 1), signal);
    await _acquireSlot();
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), TMDB_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${TMDB_BASE}${localizedPath}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctl.signal,
      });
    } catch (e) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      lastErr = ctl.signal.aborted
        ? tmdbError("timeout", "TMDB took too long to answer. Check your connection and try again.")
        : tmdbError("unreachable", "Can't reach TMDB. Check your internet connection.");
      continue;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      _releaseSlot();
    }

    if (res.status === 401 || res.status === 403) {
      _onAuthError?.();
      throw tmdbError("invalid-token", "Your TMDB token is invalid or was revoked. Update it in Settings.", res.status);
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      lastErr = tmdbError(
        res.status === 429 ? "rate-limited" : "server",
        res.status === 429 ? "TMDB is rate-limiting requests. Try again in a moment." : `TMDB is having problems (${res.status}). Try again shortly.`,
        res.status,
      );
      if (ra > 0) lastErr.retryAfterMs = Math.min(ra * 1000, 5000);
      continue;
    }
    if (!res.ok) throw tmdbError("http", `TMDB request failed (${res.status}).`, res.status);
    let data;
    try {
      data = await res.json();
    } catch {
      throw tmdbError("bad-response", "TMDB sent an unreadable response.");
    }
    _remember(cacheKey, data);
    return data;
  }
  if (lastErr?.code === "unreachable" || lastErr?.code === "timeout") _onUnreachable?.();
  throw lastErr || tmdbError("unreachable", "Can't reach TMDB.");
}

// Responses are cached unfiltered; Kids profiles get a filtered view of every
// title list (US certification checked per title, unrated hidden).
let _lastApiKey = null;
const forActiveProfile = (path, data, apiKey) =>
  isKidsProfileActive()
    ? filterKidsResponse(path, data, (p) => tmdbFetch(p, apiKey))
    : data;

/** TMDB JSON with the token last used by the app (for code without one). */
export const tmdbJson = (path) => tmdbFetch(path, _lastApiKey);
/** The TMDB token last used by the app, or null. */
export const lastTmdbKey = () => _lastApiKey;

// ── Home trending lists, kept 30 minutes (across restarts) ────────────────
// Saved as shown, so a Kids profile's copy is already filtered: a copy is
// only reused for the same language and the same kind of profile.
const TRENDING_CACHE_KEY = "trendingCache";
const TRENDING_CACHE_TTL = 30 * 60 * 1000;

/**
 * Trending lists saved for this language and kind of profile, or null.
 * @param {string} lang TMDB metadata language the lists were fetched in
 * @returns {{movies: object[], tv: object[]} | null}
 */
export function readTrendingCache(lang) {
  const c = storage.get(TRENDING_CACHE_KEY);
  const usable =
    c?.lang === lang &&
    c.kids === isKidsProfileActive() &&
    (!c.kids || c.kv === KIDS_FILTER_VERSION) &&
    Date.now() - c.ts < TRENDING_CACHE_TTL;
  return usable ? { movies: c.movies || [], tv: c.tv || [] } : null;
}

/** Save trending lists fetched in `lang` for the active profile. */
export function saveTrendingCache(lang, movies, tv) {
  storage.set(TRENDING_CACHE_KEY, { movies, tv, lang, kids: isKidsProfileActive(), kv: KIDS_FILTER_VERSION, ts: Date.now() });
}

// Documentation:
// https://vsembed.su/api/
// https://peachify.top/
// https://vidfast.vc
// https://rentry.co/aetherdomains
// https://vidrift.net/docs
// https://vidnest.fun

// ── Player Sources ────────────────────────────────────────────────────────────
// supportsProgress: true = executeJavaScript tracking works for this source
// cleanUserAgent:   true = load this source with the cleaned Chromium UA
//                   (default Electron UA minus the "Electron/x.y.z" and app
//                   tokens). Omit/false = Electron's untouched default UA.
//
const ALL_PLAYER_SOURCES = [
  {
    id: "vidfast",
    animeTmdb: true, // carries anime under its TMDB id
    label: "Vidfast",
    tag: null,
    note: null,
    supportsProgress: true,
    cleanUserAgent: true,
    colorParam: "theme", // hex without # → e.g. "e50914"
    langParam: "sub",
    params: {
      autoPlay: "true",
      poster: "true",
      title: "true",
      pip: "hide",
    },
    movieUrl: (id) => `https://vidfast.vc/movie/${id}`,
    tvUrl: (id, season, ep) =>
      `https://vidfast.vc/tv/${id}/${season}/${ep}`,
  },
  {
    id: "aether",
    label: "Aether",
    tag: null,
    note: "Multi Lang", // Has multiple audio languages
    supportsProgress: true,
    colorParam: null,
    langParam: null,
    params: {},
    movieUrl: (id) => `https://aether.ist/media/tmdb-movie-${id}`,
    tvUrl: (id, season, ep) =>
      `https://aether.ist/media/tmdb-tv-${id}/${season}/${ep}`,
  },
  {
    id: "vidrift",
    animeTmdb: true, // carries anime under its TMDB id
    label: "Vidrift",
    tag: null,
    note: "Multi Lang, Anime ✓",
    supportsProgress: true,
    supportsAnime: true, // AniList route; "?dub=1" starts on the English dub
    colorParam: "brandColor",
    langParam: "sub",
    params: {
      title: "true",
      hide: "next,episodes,cast",
    },
    movieUrl: (id) => `https://embed.vidrift.net/embed/movie/${id}`,
    tvUrl: (id, season, ep) =>
      `https://embed.vidrift.net/embed/tv/${id}/${season}/${ep}`,
    animeUrl: (anilistId, ep, lang) =>
      `https://embed.vidrift.net/embed/anilist/${anilistId}/${ep}${lang === "dub" ? "?dub=1" : ""}`,
  },
  {
    id: "vidnest",
    label: "Vidnest",
    tag: null, // not anime-only -> works for movies/TV as well
    note: "Anime ✓",
    supportsProgress: true,
    progressViaFrames: false,
    supportsAnime: true, // has a dedicated anime route (AniList id + sub/dub)
    colorParam: null, // no accent-colour query param documented
    langParam: null,
    params: {},
    movieUrl: (id) => `https://vidnest.fun/movie/${id}`,
    tvUrl: (id, season, ep) => `https://vidnest.fun/tv/${id}/${season}/${ep}`,
    // Anime route: AniList id (not TMDB), episode number, "sub" | "dub"
    animeUrl: (anilistId, ep, lang) =>
      `https://vidnest.fun/anime/${anilistId}/${ep}/${lang}`,
  },
  {
    id: "hianime",
    label: "HiAnime",
    tag: "ANIME",
    note: null,
    supportsProgress: true,
    async: true,
    params: {},
    movieUrl: (_id) => "https://hianime.at",
    tvUrl: (_id, _season, _ep) => "https://hianime.at",
  },
];

// Web app: every embed runs sandboxed (no pop-ups, no redirects, no new
// tabs). Players that refuse to run sandboxed are left out there.
export const NEEDS_UNSANDBOXED = new Set([]);
// Web app: Cinejoy's direct stream (played in-page by hls.js, no embed, no
// ads) is the first server. Its URL is only a key; webview.js intercepts it.
const WEB_DIRECT_SOURCES = [
  {
    id: "cinejoy-direct",
    label: "Cinejoy",
    tag: null,
    note: "Direct, no ads",
    supportsAnime: false,
    movieUrl: (id) => `https://cinejoy.invalid/movie/${id}`,
    tvUrl: (id, season, ep) => `https://cinejoy.invalid/tv/${id}/${season}/${ep}`,
  },
];
export const PLAYER_SOURCES = import.meta.env?.VITE_WEB
  ? [...WEB_DIRECT_SOURCES, ...ALL_PLAYER_SOURCES.filter((s) => !NEEDS_UNSANDBOXED.has(s.id) && !["vidnest", "hexa"].includes(s.id)).sort((a, b) => (b.id === "vidrift") - (a.id === "vidrift"))]
  : ALL_PLAYER_SOURCES;

// Sources that require a transparent webRequest intercept to load properly
export const NEEDS_INTERCEPT = [];

export const getSourceUrl = (
  sourceId,
  type,
  id,
  season,
  ep,
  extraParams = {},
  // Optional: accent hex (with or without #) and subtitle ISO lang code
  accentColor = null,
  subtitleLang = null,
) => {
  const src =
    PLAYER_SOURCES.find((s) => s.id === sourceId) ?? PLAYER_SOURCES[0];
  // No usable ID yet (e.g. IMDb/Kinopoisk ID still being resolved) -> no URL
  if (!id) return null;
  // Movie-only source requested for a series -> no URL
  if (type !== "movie" && !src.tvUrl) return null;
  const baseUrl =
    type === "movie" ? src.movieUrl(id) : src.tvUrl(id, season, ep);
  const url = new URL(baseUrl);

  Object.entries(src.params || {}).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  // Inject accent color into the player if the source supports it
  if (accentColor && src.colorParam) {
    const hex = accentColor.replace(/^#/, "");
    url.searchParams.set(src.colorParam, src.colorWithHash ? `#${hex}` : hex);
  }

  if (subtitleLang && src.langParam) {
    url.searchParams.set(src.langParam, subtitleLang);
  }

  Object.entries(extraParams).forEach(([key, value]) => {
    if (value != null) {
      url.searchParams.set(key, value);
    }
  });

  return url.toString();
};

// ── Per-source user agent ─────────────────────────────────────────────────────
// Provided by the main process (buildCleanUserAgent() in index.js) via preload.
export const CLEAN_USER_AGENT =
  (typeof window !== "undefined" && window.electron?.cleanUserAgent) || "";

// Source should be loaded with the cleaned Chromium UA
export const sourceUsesCleanUa = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.cleanUserAgent ?? false;

export const sourceNeedsImdb = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.idType === "imdb";

// ── TMDB -> IMDb ID conversion ────────────────────────────────────────────────
// IMDb IDs never change, so they are cached for the whole session (separately
// from the 5 min tmdbFetch cache). In-flight requests are de-duplicated.
const _imdbCache = new Map(); // "movie:123" -> "tt0123456"
const _imdbPending = new Map(); // "movie:123" -> Promise<string>

/**
 * Resolve the IMDb ID for a TMDB movie / TV show.
 * @param {"movie"|"tv"} type
 * @param {number|string} tmdbId
 * @param {string} apiKey
 * @returns {Promise<string>} e.g. "tt0133093" (rejects if TMDB has none)
 */
export function fetchImdbId(type, tmdbId, apiKey) {
  const kind = type === "movie" ? "movie" : "tv";
  const key = `${kind}:${tmdbId}`;
  if (_imdbCache.has(key)) return Promise.resolve(_imdbCache.get(key));
  if (_imdbPending.has(key)) return _imdbPending.get(key);

  const p = tmdbFetch(`/${kind}/${tmdbId}/external_ids`, apiKey)
    .then((data) => {
      const imdb = data?.imdb_id;
      if (!imdb || !/^tt\d+$/.test(imdb)) {
        throw new Error(`No IMDb ID found for TMDB ${kind} ${tmdbId}`);
      }
      _imdbCache.set(key, imdb);
      return imdb;
    })
    .finally(() => _imdbPending.delete(key));
  _imdbPending.set(key, p);
  return p;
}

// Which ID a source expects: "tmdb" (default) | "imdb" | "kinopoisk"
export const sourceIdType = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.idType ?? "tmdb";

export const sourceNeedsKinopoisk = (sourceId) =>
  sourceIdType(sourceId) === "kinopoisk";

// Source can only play movies (no series route yet)
export const sourceIsMovieOnly = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.movieOnly ?? false;

// ── TMDB -> Kinopoisk ID conversion (via Wikidata) ────────────────────────────
// Wikidata properties: P2603 Kinopoisk film ID, P4947 TMDB movie ID,
// P4983 TMDB TV series ID, P345 IMDb ID.
// Kinopoisk IDs never change -> cached for the whole session, in-flight
// requests are de-duplicated.
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
const _kpCache = new Map(); // "movie:123" -> "5494049"
const _kpPending = new Map(); // "movie:123" -> Promise<string>

// value is validated by the callers (digits / tt+digits) before interpolation
async function _wikidataKinopoisk(prop, value) {
  const query = `SELECT ?kp WHERE { ?item wdt:${prop} "${value}" . ?item wdt:P2603 ?kp . } LIMIT 1`;
  const res = await fetch(
    `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`,
  );
  if (!res.ok) throw new Error(`Wikidata ${res.status}`);
  const data = await res.json();
  const kp = data?.results?.bindings?.[0]?.kp?.value;
  return /^\d+$/.test(kp ?? "") ? kp : null;
}

/**
 * Resolve the Kinopoisk ID for a TMDB movie / TV show via Wikidata.
 * 1st try: TMDB ID, 2nd try (fallback): IMDb ID.
 * @returns {Promise<string>} e.g. "5494049" (rejects if Wikidata has none)
 */
export function fetchKinopoiskId(type, tmdbId, apiKey) {
  const kind = type === "movie" ? "movie" : "tv";
  const key = `${kind}:${tmdbId}`;
  if (_kpCache.has(key)) return Promise.resolve(_kpCache.get(key));
  if (_kpPending.has(key)) return _kpPending.get(key);

  const p = (async () => {
    if (!/^\d+$/.test(String(tmdbId))) {
      throw new Error(`Invalid TMDB id ${tmdbId}`);
    }
    const tmdbProp = kind === "movie" ? "P4947" : "P4983";
    let kp = await _wikidataKinopoisk(tmdbProp, String(tmdbId));
    if (!kp) {
      // Fallback: some Wikidata items only carry the IMDb ID
      const imdb = await fetchImdbId(kind, tmdbId, apiKey).catch(() => null);
      if (imdb && /^tt\d+$/.test(imdb)) {
        kp = await _wikidataKinopoisk("P345", imdb);
      }
    }
    if (!kp) throw new Error(`No Kinopoisk ID found for TMDB ${kind} ${tmdbId}`);
    _kpCache.set(key, kp);
    return kp;
  })().finally(() => _kpPending.delete(key));
  _kpPending.set(key, p);
  return p;
}

export const sourceSupportsProgress = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.supportsProgress ?? false;

export const sourceProgressViaFrames = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.progressViaFrames ?? false;

export const sourceSkipsResetGuard = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.skipResetGuard ?? false;

export const sourceIsAsync = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.async ?? false;

// Source has its own anime route (AniList id + sub/dub) but is not anime-only
export const sourceSupportsAnime = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.supportsAnime ?? false;

// Source is usable for anime: anime-only (tagged) or anime-capable
export const sourceIsAnimeCapable = (sourceId) => {
  const src = PLAYER_SOURCES.find((s) => s.id === sourceId);
  return !!(src && (src.tag || src.supportsAnime));
};

/**
 * Build the anime-route URL for sources that support it (e.g. Vidnest).
 * @param {string} sourceId
 * @param {number|string} anilistId AniList media id of the season/movie
 * @param {number|string} episode   episode number inside that AniList entry
 * @param {"sub"|"dub"} dubMode
 * @returns {string|null} null if the source has no anime route or id is missing
 */
export const getAnimeSourceUrl = (
  sourceId,
  anilistId,
  episode,
  dubMode = "sub",
  extraParams = {},
) => {
  const src = PLAYER_SOURCES.find((s) => s.id === sourceId);
  if (!src?.animeUrl || !anilistId || !episode) return null;
  const url = new URL(
    src.animeUrl(anilistId, episode, dubMode === "dub" ? "dub" : "sub"),
  );
  Object.entries(src.params || {}).forEach(([k, v]) =>
    url.searchParams.set(k, v),
  );
  Object.entries(extraParams).forEach(([k, v]) => {
    if (v != null) url.searchParams.set(k, v);
  });
  return url.toString();
};

// Return the next non-async source after `currentId` in PLAYER_SOURCES order
export const getNextNonAsyncSource = (currentId) => {
  const nonAsync = PLAYER_SOURCES.filter((s) => !s.async);
  if (nonAsync.length === 0) return null;
  const idx = nonAsync.findIndex((s) => s.id === currentId);
  // If currentId is itself non-async, return the next one (wrap around).
  // If currentId is async (e.g. HiAnime), just return the first non-async.
  if (idx < 0) return nonAsync[0].id;
  return nonAsync[(idx + 1) % nonAsync.length].id;
};

// ── AniList API (anime metadata) ──────────────────────────────────────────────
const ANILIST_API = "https://graphql.anilist.co";

// Strip "(Source: ...)", "Note: ..." and similar attribution lines from AniList descriptions
export const cleanAnilistDescription = (desc) => {
  if (!desc) return desc;
  // Remove HTML by stripping all < and > characters and anything between them.
  // Splitting on < and dropping the tag portion of each chunk is immune to
  // unclosed/malformed tags and avoids any regex that starts with "<" (which
  // static analysers flag as potentially incomplete).
  let clean = desc
    .split("<")
    .map((chunk, i) => (i === 0 ? chunk : chunk.slice(chunk.indexOf(">") + 1)))
    .join("")
    .replace(/>/g, "");
  // Remove everything from "(Source:" onwards (including multi-line variants)
  clean = clean.replace(/\(Source:[^)]*\)/gi, "");
  // Remove "Note: ..." sentences/paragraphs at the end
  clean = clean.replace(/\bNote:[^\n]*/gi, "");
  // Remove trailing whitespace, newlines, punctuation left over
  clean = clean.replace(/[\s\n]+$/, "").trim();
  return clean;
};

// A page of candidates (not the single top hit), so same-name remakes can be
// told apart by year: Hunter x Hunter 1999 (136) vs 2011 (11061).
const ANILIST_QUERY = `
query ($search: String, $type: MediaType, $formats: [MediaFormat]) {
  Page(perPage: 8) {
  media(search: $search, type: $type, format_in: $formats, sort: SEARCH_MATCH) {
    id
    idMal
    format
    title { romaji english native }
    description(asHtml: false)
    coverImage { extraLarge large }
    bannerImage
    genres
    averageScore
    episodes
    status
    season
    seasonYear
    studios(isMain: true) { nodes { name } }
    startDate { year month }
    relations {
      edges {
        relationType
        node {
          id
          type
          format
          title { romaji english }
          episodes
          startDate { year month }
          seasonYear
        }
      }
    }
  }
}
}`;

// ── AniList cache (localStorage + in-memory) ──────────────────────────────────
// v2: entries are keyed by page kind (tv/movie) and searched with a format
// filter; v1 entries could hold a movie for a TV page (Naruto Shippuden).
const ANILIST_CACHE_KEY = "streambert_anilistCache_v2";
const ANILIST_CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

// loaded once on first use, flushed to localStorage on write.
let _anilistCache = null;

function getAnilistCache() {
  if (_anilistCache) return _anilistCache;
  try {
    const raw = localStorage.getItem(ANILIST_CACHE_KEY);
    _anilistCache = raw ? JSON.parse(raw) : {};
  } catch {
    _anilistCache = {};
  }
  // Evict stale entries once on load
  const now = Date.now();
  for (const key of Object.keys(_anilistCache)) {
    if (now - _anilistCache[key].ts > ANILIST_CACHE_TTL) {
      delete _anilistCache[key];
    }
  }
  return _anilistCache;
}

let _anilistFlushTimer = null;
function flushAnilistCache() {
  if (_anilistFlushTimer) clearTimeout(_anilistFlushTimer);
  _anilistFlushTimer = setTimeout(() => {
    _anilistFlushTimer = null;
    try {
      localStorage.setItem(ANILIST_CACHE_KEY, JSON.stringify(_anilistCache));
    } catch {}
  }, 500);
}

// AniList formats a page may map to. A TV page must never land on a movie,
// special or OVA (TMDB "Naruto Shippūden" searched unfiltered returns the
// movie "Naruto Shippuden the Movie: Blood Prison").
export const ANILIST_TV_FORMATS = ["TV", "TV_SHORT", "ONA"];
// Anime films are sometimes filed as specials/OVAs/ONAs, never as TV series.
export const ANILIST_MOVIE_FORMATS = ["MOVIE", "SPECIAL", "OVA", "ONA"];

const _alYear = (m) => m?.startDate?.year || m?.seasonYear || null;

/**
 * Best AniList candidate for a TMDB title. Search order wins, except that a
 * known TMDB year picks the candidate from that year (or the next/previous
 * year) over an older/newer same-name show: TMDB "Hunter x Hunter" (2011)
 * must not land on the 1999 series, which has different episodes.
 */
export const pickAnilistMatch = (list, { year = null, formats = null } = {}) => {
  const ok = (list || []).filter((m) => m && (!formats || !m.format || formats.includes(m.format)));
  if (!ok.length) return null;
  const y = Number(year) || null;
  if (y) {
    const exact = ok.find((m) => _alYear(m) === y);
    if (exact) return exact;
    const near = ok.find((m) => _alYear(m) && Math.abs(_alYear(m) - y) <= 1);
    if (near) return near;
  }
  return ok[0];
};

/**
 * Search variants for a TMDB title, most AniList-friendly first. AniList's
 * search mis-ranks romanized long vowels ("Shippūden"), so the accent-free
 * spelling ("Shippuden") and the doubled-vowel romaji ("Shippuuden") go first.
 */
export const anilistSearchTitles = (title) => {
  const raw = String(title || "").trim();
  if (!raw) return [];
  const doubled = raw
    .replace(/ā/g, "aa").replace(/ī/g, "ii").replace(/ū/g, "uu")
    .replace(/ē/g, "ee").replace(/ō/g, "ou")
    .replace(/Ā/g, "Aa").replace(/Ī/g, "Ii").replace(/Ū/g, "Uu")
    .replace(/Ē/g, "Ee").replace(/Ō/g, "Ou");
  const plain = raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  // Last resorts: no punctuation ("Food Wars! Shokugeki no Soma" finds
  // nothing on AniList, "Food Wars Shokugeki no Soma" does) and no
  // ": The Movie" suffix ("A Silent Voice: The Movie").
  const bare = plain.replace(/[!?:;,.~]+/g, " ").replace(/\s+/g, " ").trim();
  const noSuffix = plain.replace(/\s*[:\-–]?\s*the movie$/i, "").trim();
  // ...and the main title before "!" or ":" ("Food Wars! Shokugeki no Soma").
  const head = plain.split(/[!:]/)[0].trim();
  return [...new Set([plain, doubled, raw, bare, noSuffix, head.length >= 4 ? head : ""].filter(Boolean))];
};

// tmdbId is used as the cache key (unique per show) while title is used for the AniList search query.
// `kind` ("tv" | "movie") keeps TMDB TV and movie ids apart in the cache;
// `formats` limits the AniList formats the search may return.
export const fetchAnilistData = async (
  title,
  type = "ANIME",
  tmdbId = null,
  { kind = "any", formats = null, year = null } = {},
) => {
  const cacheKey = tmdbId
    ? `${type}__${kind}__tmdb_${tmdbId}`
    : `${type}__${kind}__${title.toLowerCase().trim()}`;

  const cache = getAnilistCache();
  const entry = cache[cacheKey];
  if (entry && Date.now() - entry.ts <= ANILIST_CACHE_TTL) {
    const wrongFormat =
      entry.data && formats && entry.data.format && !formats.includes(entry.data.format);
    const y = Number(year) || null;
    const wrongYear = entry.data && y && _alYear(entry.data) && Math.abs(_alYear(entry.data) - y) > 1;
    if (!wrongFormat && !wrongYear) return entry.data;
    delete cache[cacheKey];
    flushAnilistCache();
  }

  try {
    let data = null;
    let answered = false;
    for (const search of anilistSearchTitles(title)) {
      const res = await fetch(ANILIST_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          query: ANILIST_QUERY,
          variables: { search, type, formats: formats || undefined },
        }),
      });
      const json = await res.json();
      // A 404 "Not Found." answer means no hit for this spelling: try the next.
      if (json?.data) answered = true;
      data = pickAnilistMatch(json?.data?.Page?.media, { year, formats });
      if (data) break;
    }
    if (!answered) throw new Error("AniList: no answer");

    cache[cacheKey] = { data, ts: Date.now() };
    flushAnilistCache();

    return data;
  } catch {
    if (entry) return entry.data;
    return null;
  }
};

// ── AniList sequel chain (TV entries only) ───────────────────────────────────
// Long shows are one TMDB entry with many seasons, while AniList splits them
// into one entry per cour (AoT: S1 25, S2 12, S3 12, S3 Part 2 10, ...).
// The chain lets a TMDB season/episode be mapped onto the right AniList entry.
const ANILIST_RELATIONS_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    relations { edges { relationType node { id type format episodes } } }
  }
}`;
const _chainCache = new Map();

/** Next TV-format sequel from a Media's relations edges, or null. */
export const nextTvSequel = (edges) =>
  (edges || []).find(
    (e) =>
      e.relationType === "SEQUEL" &&
      e.node?.type === "ANIME" &&
      ANILIST_TV_FORMATS.includes(e.node.format),
  )?.node || null;

/**
 * [{ id, episodes }] from `root` along TV sequels, at most `max` entries.
 * The first hop comes from root's own relations (already fetched); later hops
 * are one AniList request each. Stops at a sequel with an unknown episode count.
 */
export const fetchAnilistChain = async (root, { max = 12, fetchImpl = fetch } = {}) => {
  if (!root?.id) return null;
  if (_chainCache.has(root.id)) return _chainCache.get(root.id);
  const chain = [{ id: root.id, episodes: root.episodes || null }];
  let edges = root.relations?.edges;
  try {
    while (chain.length < max && chain[chain.length - 1].episodes) {
      const next = nextTvSequel(edges);
      if (!next || chain.some((c) => c.id === next.id)) break;
      chain.push({ id: next.id, episodes: next.episodes || null });
      const res = await fetchImpl(ANILIST_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: ANILIST_RELATIONS_QUERY, variables: { id: next.id } }),
      });
      edges = (await res.json())?.data?.Media?.relations?.edges;
    }
  } catch {}
  _chainCache.set(root.id, chain);
  return chain;
};

/** Absolute episode number of TMDB season/episode (specials not counted). */
export const tmdbAbsoluteEpisode = (tmdbSeasons, season, episode) => {
  const ep = Number(episode);
  if (!ep || !Array.isArray(tmdbSeasons)) return null;
  let offset = 0;
  for (const s of tmdbSeasons) {
    if (s.season_number > 0 && s.season_number < Number(season)) offset += s.episode_count || 0;
  }
  return offset + ep;
};

/**
 * Map an absolute episode onto the chain: { anilistId, episode } where
 * episode is the number inside that AniList entry, or null when it falls
 * past the chain. An entry with an unknown count (still airing) takes the rest.
 */
export const mapAbsoluteToAnilist = (chain, absolute) => {
  let left = Number(absolute);
  if (!left || !Array.isArray(chain) || !chain.length) return null;
  for (const c of chain) {
    if (!c.episodes || left <= c.episodes) return { anilistId: c.id, episode: left };
    left -= c.episodes;
  }
  return null;
};

/**
 * Build an ordered list of seasons from AniList data.
 * AniList represents each season of a series as a separate Media entry
 * linked by SEQUEL/PREQUEL relations. This function walks the SEQUEL chain
 * starting from the fetched entry and returns seasons sorted by air date.
 *
 * Returns: [{ seasonNum, title, episodes, year, month }]
 */
export const buildAnilistSeasons = (anilistData) => {
  if (!anilistData) return null;

  const main = {
    id: anilistData.id,
    title:
      anilistData.title?.english ||
      anilistData.title?.romaji ||
      anilistData.title?.native,
    episodes: anilistData.episodes || null,
    year: anilistData.startDate?.year || anilistData.seasonYear || 9999,
    month: anilistData.startDate?.month || 0,
  };

  // Collect direct TV-format sequels from relations
  const sequels = (anilistData.relations?.edges || [])
    .filter(
      (e) =>
        e.relationType === "SEQUEL" &&
        e.node.type === "ANIME" &&
        (e.node.format === "TV" || e.node.format === "TV_SHORT"),
    )
    .map((e) => ({
      id: e.node.id,
      title: e.node.title?.english || e.node.title?.romaji,
      episodes: e.node.episodes || null,
      year: e.node.startDate?.year || e.node.seasonYear || 9999,
      month: e.node.startDate?.month || 0,
    }));

  const all = [main, ...sequels].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month,
  );

  return all.map((s, i) => ({ seasonNum: i + 1, ...s }));
};

// TMDB genre ID 16 = Animation. Treat it as anime when origin_country includes JP or language is jp
export const isAnimeContent = (item, details) => {
  const d = details || item;
  const lang = d.original_language;
  const countries = d.origin_country || [];
  const genreIds = d.genre_ids || (d.genres || []).map((g) => g.id);
  const hasAnimation = genreIds.includes(16);
  return hasAnimation && (lang === "ja" || countries.includes("JP"));
};

// Default sources
export const ANIME_DEFAULT_SOURCE = "hianime";
export const NON_ANIME_DEFAULT_SOURCE = "vidrift";

// ── Episode Group fetch (localStorage + in-memory cache, 7-day TTL) ─────────
// Episode groups almost never change -> cache aggressively across sessions.
const EG_CACHE_KEY = "streambert_episodeGroupCache";
const EG_CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

let _egCache = null;

function getEgCache() {
  if (_egCache) return _egCache;
  try {
    const raw = localStorage.getItem(EG_CACHE_KEY);
    _egCache = raw ? JSON.parse(raw) : {};
  } catch {
    _egCache = {};
  }
  // Evict stale entries once on load
  const now = Date.now();
  for (const key of Object.keys(_egCache)) {
    if (now - _egCache[key].ts > EG_CACHE_TTL) delete _egCache[key];
  }
  return _egCache;
}

let _egFlushTimer = null;
function flushEgCache() {
  if (_egFlushTimer) clearTimeout(_egFlushTimer);
  _egFlushTimer = setTimeout(() => {
    _egFlushTimer = null;
    try {
      localStorage.setItem(EG_CACHE_KEY, JSON.stringify(_egCache));
    } catch {}
  }, 500);
}

export const fetchEpisodeGroup = async (groupId, apiKey) => {
  const cache = getEgCache();
  const entry = cache[groupId];
  if (entry && Date.now() - entry.ts <= EG_CACHE_TTL) return entry.data;

  const data = await tmdbFetch(`/tv/episode_group/${groupId}`, apiKey);
  cache[groupId] = { data, ts: Date.now() };
  flushEgCache();
  return data;
};

// Native player server list: every server for this kind of content. Anime
// lists all of them under Sub and every anime-route server under Dub, each
// labelled with its group ("Vidnest · Dub").
export const nativeServerList = (isAnime) =>
  serverCatalog(sourcesForContent(isAnime).filter((s) => !s.async), isAnime).map((e) => ({
    id: e.key,
    label: groupedLabel(e),
  }));

// Server list split by content type: anime titles get anime servers only,
// movies/series get the regular servers only (anime-only ones hidden).
// Falls back to everything if a type would end up with no servers.
export const sourcesForContent = (isAnime, list = PLAYER_SOURCES) => {
  const animeOk = (s) => !!(s.tag || s.supportsAnime || s.animeTmdb);
  const out = isAnime ? list.filter(animeOk) : list.filter((s) => !s.tag);
  return out.length ? out : list;
};
