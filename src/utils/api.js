import { isKidsProfileActive } from "./profileScope";
import { filterKidSafeResults } from "./kidsFilter";
import { storage } from "./storage";

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
    if (age < TMDB_CACHE_TTL) return forActiveProfile(cached.data);
    if (age < TMDB_STALE_MAX) {
      // Stale: answer now, refresh quietly for next time.
      _tmdbNetwork(localizedPath, apiKey, cacheKey).catch(() => {});
      return forActiveProfile(cached.data);
    }
  }
  if (opts.signal) return forActiveProfile(await _tmdbRequest(localizedPath, apiKey, cacheKey, opts.signal));
  return forActiveProfile(await _tmdbNetwork(localizedPath, apiKey, cacheKey));
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

// Responses are cached unfiltered; Kids profiles get a filtered view of lists.
const forActiveProfile = (data) =>
  isKidsProfileActive() ? filterKidSafeResults(data) : data;

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
    Date.now() - c.ts < TRENDING_CACHE_TTL;
  return usable ? { movies: c.movies || [], tv: c.tv || [] } : null;
}

/** Save trending lists fetched in `lang` for the active profile. */
export function saveTrendingCache(lang, movies, tv) {
  storage.set(TRENDING_CACHE_KEY, { movies, tv, lang, kids: isKidsProfileActive(), ts: Date.now() });
}

// Documentation:
// https://vsembed.su/api/
// https://peachify.top/
// https://vidfast.vc
// https://vidlove.cc/#embed
// https://rentry.co/aetherdomains
// https://vidrift.net/docs
// https://vidnest.fun
// https://devideosrc.co/docs
// https://frembed.bar/api-docs
// https://on.kinohub.vip/

// ── Player Sources ────────────────────────────────────────────────────────────
// supportsProgress: true = executeJavaScript tracking works for this source
// cleanUserAgent:   true = load this source with the cleaned Chromium UA
//                   (default Electron UA minus the "Electron/x.y.z" and app
//                   tokens). Omit/false = Electron's untouched default UA.
//
export const PLAYER_SOURCES = [
  {
    id: "vidsrc",
    animeTmdb: true, // carries anime under its TMDB id
    label: "VidSrc",
    tag: null,
    note: null,
    supportsProgress: true,
    progressViaFrames: true, // video is in a nested iframe, needs main-process frame query
    colorParam: null, // vidsrc doesn't support color param
    langParam: "ds_lang", // ISO 639-1 language code
    params: {
      autoplay: "1"
    },
    movieUrl: (id) => `https://vsembed.su/embed/movie/${id}`,
    tvUrl: (id, season, ep) =>
      `https://vsembed.su/embed/tv/${id}/${season}/${ep}`,
  },
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
    id: "vidlove",
    animeTmdb: true, // carries anime under its TMDB id
    label: "Vidlove",
    tag: null,
    note: null,
    supportsProgress: true,
    colorParam: "primarycolor", // hex without # → e.g. "e50914"
    params: {
      autoplay: "true",
      autonext: "false",
      tour: "true",
      showNextEpisode: "false",
      hideautonext: "true",
      hidenextbutton: "true",
    },
    movieUrl: (id) => `https://player.vidlove.cc/embed/movie/${id}`,
    tvUrl: (id, season, ep) =>
      `https://player.vidlove.cc/embed/tv/${id}/${season}/${ep}`,
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
    note: "Multi Lang, Anime ✓", // Has Anime sub/dub and multi language support but not with anilistId
    supportsProgress: true,
    colorParam: "brandColor",
    langParam: "sub",
    params: {
      title: "true",
      hide: "next,episodes,cast",
    },
    movieUrl: (id) => `https://embed.vidrift.net/embed/movie/${id}`,
    tvUrl: (id, season, ep) =>
      `https://embed.vidrift.net/embed/tv/${id}/${season}/${ep}`,
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
    id: "devideosrc",
    label: "DeVideoSrc",
    tag: null,
    note: "🇩🇪",
    supportsProgress: true,
    progressViaFrames: true, // player may sit in a nested provider iframe -> main-process frame query
    skipResetGuard: true, // no quality-change reset -> don't "seek back" after a manual rewind
    idType: "imdb", // needs an IMDb ID (tt…) instead of the TMDB ID
    colorParam: "color", // hex WITH # (URLSearchParams encodes it as %23)
    colorWithHash: true,
    langParam: null,
    params: {
      autoplay: "1",
      muted: "0",
    },
    movieUrl: (id) => `https://devideosrc.co/custom/movie/${id}`,
    tvUrl: (id, season, ep) =>
      `https://devideosrc.co/custom/serial/${id}/${season}/${ep}`,
  },
  {
    id: "frembed",
    label: "Frembed",
    tag: null, // movies, TV and anime (anime uses the normal movie/serie endpoints)
    note: "🇫🇷",
    supportsProgress: true,
    progressViaFrames: true,
    skipResetGuard: true, // no quality-change reset -> don't "seek back" after a manual rewind
    colorParam: null,
    langParam: null,
    params: {},
    movieUrl: (id) => `https://frembed.uno/embed/movie/${id}`,
    tvUrl: (id, season, ep) =>
      `https://frembed.uno/embed/serie/${id}?sa=${season}&epi=${ep}`,
  },
  {
    id: "kinohub",
    label: "KinoHub",
    tag: null,
    note: "🇷🇺",
    supportsProgress: true,
    progressViaFrames: true, // player may sit in a nested iframe -> main-process frame query
    idType: "kinopoisk", // needs a Kinopoisk ID (resolved via Wikidata)
    movieOnly: true, // series support not implemented yet
    colorParam: null,
    langParam: null,
    params: {},
    movieUrl: (id) => `https://on.kinohub.vip/movie/${id}`,
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

// Sources that require a transparent webRequest intercept to load properly
export const NEEDS_INTERCEPT = ["vidsrc", "devideosrc", "frembed", "kinohub"];

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

const ANILIST_QUERY = `
query ($search: String, $type: MediaType) {
  Media(search: $search, type: $type, sort: SEARCH_MATCH) {
    id
    idMal
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
}`;

// ── AniList cache (localStorage + in-memory) ──────────────────────────────────
const ANILIST_CACHE_KEY = "streambert_anilistCache";
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

// tmdbId is used as the cache key (unique per show) while title is used for the AniList search query.
export const fetchAnilistData = async (
  title,
  type = "ANIME",
  tmdbId = null,
) => {
  const cacheKey = tmdbId
    ? `${type}__tmdb_${tmdbId}`
    : `${type}__${title.toLowerCase().trim()}`;

  const cache = getAnilistCache();
  const entry = cache[cacheKey];
  if (entry && Date.now() - entry.ts <= ANILIST_CACHE_TTL) {
    // Sanity-check: make sure cached data actually belongs to this title.
    const cachedTitles = [
      entry.data?.title?.romaji,
      entry.data?.title?.english,
      entry.data?.title?.native,
    ]
      .filter(Boolean)
      .map((t) => t.toLowerCase());
    const searchTitle = title.toLowerCase();
    const isMismatch =
      entry.data !== null &&
      cachedTitles.length > 0 &&
      !cachedTitles.some(
        (t) => t.includes(searchTitle) || searchTitle.includes(t),
      );
    if (!isMismatch) return entry.data;
    // Mismatch detected
    delete cache[cacheKey];
    flushAnilistCache();
  }

  try {
    const res = await fetch(ANILIST_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: ANILIST_QUERY,
        variables: { search: title, type },
      }),
    });
    const json = await res.json();
    const data = json?.data?.Media || null;

    cache[cacheKey] = { data, ts: Date.now() };
    flushAnilistCache();

    return data;
  } catch {
    if (entry) return entry.data;
    return null;
  }
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

// Native player server list. Anime titles list only the viewer's chosen
// audio mode: anime-route servers appear once as "Vidnest · Sub" or
// "Vidnest · Dub". In Dub mode the TMDB-route servers are left out because
// they only carry the subbed version (unless no anime route exists at all).
export const nativeServerList = (isAnime, dubMode = "sub") => {
  const mode = dubMode === "dub" ? "dub" : "sub";
  const suffix = mode === "dub" ? "Dub" : "Sub";
  const usable = sourcesForContent(isAnime).filter((s) => !s.async);
  if (!isAnime) return usable.map((s) => ({ id: s.id, label: s.label }));
  const animeRoutes = usable.filter((s) => s.animeUrl);
  const list = mode === "dub" && animeRoutes.length ? animeRoutes : usable;
  return list.map((s) =>
    s.animeUrl
      ? { id: `${s.id}:${mode}`, label: `${s.label} · ${suffix}` }
      : { id: s.id, label: s.label },
  );
};

// Server list split by content type: anime titles get anime servers only,
// movies/series get the regular servers only (anime-only ones hidden).
// Falls back to everything if a type would end up with no servers.
export const sourcesForContent = (isAnime, list = PLAYER_SOURCES) => {
  const animeOk = (s) => !!(s.tag || s.supportsAnime || s.animeTmdb);
  const out = isAnime ? list.filter(animeOk) : list.filter((s) => !s.tag);
  return out.length ? out : list;
};
