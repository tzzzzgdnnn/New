// Cinejoy on iOS: movies and series resolved straight to an HLS stream through
// Cinejoy's own stream API (utils/servers/cinejoy.js), like ani.pm for anime: no
// site, no embed page, no Cloudflare page in a web view. The lookup starts as
// soon as a title page publishes its context, so Play doesn't wait. The API
// allows any origin, so the web view's own fetch is used.
import { resolveCinejoy } from "../../utils/servers/cinejoy";
import { fetchImdbId, lastTmdbKey } from "../../utils/api";
import { diag } from "../../utils/diag";
import { streamMaxHeight } from "../../utils/servers/quality";

export const CINEJOY_ID = "cinejoy-direct";
export const CINEJOY_LABEL = "Cinejoy";
const MAX_AGE_MS = 15 * 60_000;
const WAIT_ON_PLAY_MS = 2500; // Play waits at most this long for a lookup still running

const timedFetch = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout?.(8000) });

let http = timedFetch;
let imdbLookup = (type, id) => fetchImdbId(type, id, lastTmdbKey()).catch(() => null);
/** Tests swap the HTTP client and the IMDb lookup. */
export const setCinejoyHttp = (fn, imdb) => {
  http = fn || timedFetch;
  if (imdb) imdbLookup = imdb;
};

const nativeHttpAvailable = () => typeof WebAssembly !== "undefined" && !!globalThis.crypto?.subtle;

// Web app: a stream counts only if this browser can fetch its playlist (CORS,
// not removed, not an anti-scrape redirect).
const playableHere = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout?.(5000) });
    if (!r.ok || /dontscrape/.test(r.url)) return false;
    const text = await r.text();
    // Tallest rendition, for the best-quality pick across upstreams.
    return text.startsWith("#EXTM3U") ? { ok: true, height: streamMaxHeight(text) } : false;
  } catch {
    return false;
  }
};

// Android app: the same check through the native HTTP client.
const playableNatively = async (url) => {
  try {
    const { CapacitorHttp } = await import("@capacitor/core");
    const r = await CapacitorHttp.get({ url, responseType: "text", connectTimeout: 5000, readTimeout: 5000 });
    const text = String(r.data || "");
    return r.status < 400 && text.startsWith("#EXTM3U") ? { ok: true, height: streamMaxHeight(text) } : false;
  } catch {
    return false;
  }
};

const cache = new Map(); // key -> { at, promise, result?, error? }

/** Cache key, or null when Cinejoy isn't used (anime has ani.pm). */
export const cinejoyKey = (ctx) => {
  if (!ctx?.tmdbId || ctx.isAnime) return null;
  const s = ctx.tmdbSeason ?? ctx.season ?? 1;
  const e = ctx.tmdbEpisode ?? ctx.episode ?? 1;
  return ctx.type === "tv" ? `tv:${ctx.tmdbId}:${s}:${e}` : `movie:${ctx.tmdbId}`;
};

/** Start (or reuse) the lookup for `ctx`; resolves to the result or null. */
/**
 * Automated party test (scripts/party-e2e.mjs): a fixed https test stream set
 * in this origin's localStorage ("sbTestStream") stands in for Cinejoy, so
 * the test never touches real streaming hosts. Unset for everyone else.
 */
const testStream = () => {
  try {
    const u = localStorage.getItem("sbTestStream");
    return u && /^https:\/\/[^\s]+$/.test(u) ? u : null;
  } catch {
    return null;
  }
};

export function prefetchCinejoy(ctx, { now = Date.now } = {}) {
  const key = cinejoyKey(ctx);
  const test = key && testStream();
  if (test) return Promise.resolve({ ok: true, server: "test", source: test, subtitles: [] });
  if (!key || !nativeHttpAvailable()) return Promise.resolve(null);
  const hit = cache.get(key);
  if (hit && now() - hit.at < MAX_AGE_MS && !hit.error) return hit.promise;
  const started = now();
  const entry = { at: started };
  const type = ctx.type === "tv" ? "tv" : "movie";
  entry.promise = (async () => {
    const imdbId = ctx.imdbId || (await imdbLookup(type, ctx.tmdbId)) || "";
    return resolveCinejoy(http, {
      type,
      tmdbId: ctx.tmdbId,
      title: ctx.title || "",
      year: ctx.year || "",
      imdbId,
      season: ctx.tmdbSeason ?? ctx.season ?? 1,
      episode: ctx.tmdbEpisode ?? ctx.episode ?? 1,
      // Web app: the browser must be able to read the playlist (CORS). The
  // Android app reads and plays it natively (no CORS), like the iPhone app,
  // so only a removed / dead stream is turned away there.
  }, undefined, import.meta.env?.VITE_ANDROID ? playableNatively : import.meta.env?.VITE_WEB ? playableHere : null);
  })()
    .then((r) => {
      entry.result = r;
      diag("player", `cinejoy ${key}: ${r.server} stream${r.height ? ` (${r.height}p)` : ""} in ${now() - started} ms`);
      return r;
    })
    .catch((e) => {
      entry.error = e;
      entry.at = now() - MAX_AGE_MS + 60_000; // retry a failed lookup after a minute
      diag("player", `cinejoy ${key}: ${e?.message || e} after ${now() - started} ms`);
      return null;
    });
  cache.set(key, entry);
  while (cache.size > 30) cache.delete(cache.keys().next().value);
  return entry.promise;
}

/**
 * Cinejoy's stream as a native-player / downloader candidate ("#sb-direct": the
 * stream itself, no page to load). Empty when Cinejoy has nothing for this title.
 */
export async function cinejoyCandidates(ctx, { waitMs = WAIT_ON_PLAY_MS } = {}) {
  if (!cinejoyKey(ctx)) return [];
  const r = await Promise.race([prefetchCinejoy(ctx), new Promise((res) => setTimeout(() => res(null), waitMs))]);
  if (!r?.ok) return [];
  return [{ id: CINEJOY_ID, label: CINEJOY_LABEL, url: `${r.source}#sb-direct` }];
}

/** The finished lookup for `ctx` if it is already in hand (sync), else null. */
export function cachedCinejoy(ctx) {
  const key = cinejoyKey(ctx);
  const hit = key && cache.get(key);
  return hit?.result?.ok ? hit.result : null;
}

/** Forget the lookup for `ctx` (its stream failed to play: look it up again). */
export function forgetCinejoy(ctx) {
  const key = cinejoyKey(ctx);
  if (key) cache.delete(key);
}

/** Forget every lookup (tests). */
export const clearCinejoyCache = () => cache.clear();
