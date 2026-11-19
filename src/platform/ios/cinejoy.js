// Cinejoy on iOS: movies and series resolved straight to an HLS stream through
// Cinejoy's own stream API (utils/servers/cinejoy.js), like ani.pm for anime: no
// site, no embed page, no Cloudflare page in a web view. The lookup starts as
// soon as a title page publishes its context, so Play doesn't wait. The API
// allows any origin, so the web view's own fetch is used.
import { resolveCinejoy } from "../../utils/servers/cinejoy";
import { fetchImdbId, lastTmdbKey } from "../../utils/api";
import { diag } from "../../utils/diag";

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
    return (await r.text()).startsWith("#EXTM3U");
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
export function prefetchCinejoy(ctx, { now = Date.now } = {}) {
  const key = cinejoyKey(ctx);
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
    }, undefined, import.meta.env?.VITE_WEB ? playableHere : null);
  })()
    .then((r) => {
      entry.result = r;
      diag("player", `cinejoy ${key}: ${r.server} stream in ${now() - started} ms`);
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

/** Forget every lookup (tests). */
export const clearCinejoyCache = () => cache.clear();
