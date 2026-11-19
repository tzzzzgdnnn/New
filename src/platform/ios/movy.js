// Movy on iOS: movies and series resolved straight to an HLS stream through
// Movy's own stream API (utils/servers/movy.js), like ani.pm for anime: no
// site, no embed page, no Cloudflare page in a web view. The lookup starts as
// soon as a title page publishes its context, so Play doesn't wait. The API
// sends no CORS headers, so requests go through the native HTTP client.
import { CapacitorHttp } from "@capacitor/core";
import { resolveMovy } from "../../utils/servers/movy";
import { fetchImdbId, lastTmdbKey } from "../../utils/api";
import { diag } from "../../utils/diag";

export const MOVY_ID = "movy-direct";
export const MOVY_LABEL = "Movy";
const MAX_AGE_MS = 15 * 60_000;
const WAIT_ON_PLAY_MS = 2500; // Play waits at most this long for a lookup still running

async function nativeGet(url, headers) {
  const res = await CapacitorHttp.get({ url, headers, responseType: "text", connectTimeout: 6000, readTimeout: 8000 });
  if (!res || res.status >= 400) throw new Error(`HTTP ${res?.status}`);
  return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
}

let http = nativeGet;
let imdbLookup = (type, id) => fetchImdbId(type, id, lastTmdbKey()).catch(() => null);
/** Tests swap the HTTP client and the IMDb lookup. */
export const setMovyHttp = (fn, imdb) => {
  http = fn || nativeGet;
  if (imdb) imdbLookup = imdb;
};

const nativeHttpAvailable = () => {
  try {
    return http !== nativeGet || !!window.Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
};

const cache = new Map(); // key -> { at, promise, result?, error? }

/** Cache key, or null when Movy isn't used (anime has ani.pm). */
export const movyKey = (ctx) => {
  if (!ctx?.tmdbId || ctx.isAnime) return null;
  const s = ctx.tmdbSeason ?? ctx.season ?? 1;
  const e = ctx.tmdbEpisode ?? ctx.episode ?? 1;
  return ctx.type === "tv" ? `tv:${ctx.tmdbId}:${s}:${e}` : `movie:${ctx.tmdbId}`;
};

/** Start (or reuse) the lookup for `ctx`; resolves to the result or null. */
export function prefetchMovy(ctx, { now = Date.now } = {}) {
  const key = movyKey(ctx);
  if (!key || !nativeHttpAvailable()) return Promise.resolve(null);
  const hit = cache.get(key);
  if (hit && now() - hit.at < MAX_AGE_MS && !hit.error) return hit.promise;
  const started = now();
  const entry = { at: started };
  const type = ctx.type === "tv" ? "tv" : "movie";
  entry.promise = (async () => {
    const imdbId = ctx.imdbId || (await imdbLookup(type, ctx.tmdbId)) || "";
    return resolveMovy(http, {
      type,
      tmdbId: ctx.tmdbId,
      title: ctx.title || "",
      year: ctx.year || "",
      imdbId,
      season: ctx.tmdbSeason ?? ctx.season ?? 1,
      episode: ctx.tmdbEpisode ?? ctx.episode ?? 1,
    });
  })()
    .then((r) => {
      entry.result = r;
      diag("player", `movy ${key}: ${r.provider} stream in ${now() - started} ms`);
      return r;
    })
    .catch((e) => {
      entry.error = e;
      entry.at = now() - MAX_AGE_MS + 60_000; // retry a failed lookup after a minute
      diag("player", `movy ${key}: ${e?.message || e} after ${now() - started} ms`);
      return null;
    });
  cache.set(key, entry);
  while (cache.size > 30) cache.delete(cache.keys().next().value);
  return entry.promise;
}

/**
 * Movy's stream as a native-player / downloader candidate ("#sb-direct": the
 * stream itself, no page to load). Empty when Movy has nothing for this title.
 */
export async function movyCandidates(ctx, { waitMs = WAIT_ON_PLAY_MS } = {}) {
  if (!movyKey(ctx)) return [];
  const r = await Promise.race([prefetchMovy(ctx), new Promise((res) => setTimeout(() => res(null), waitMs))]);
  if (!r?.ok) return [];
  return [{ id: MOVY_ID, label: MOVY_LABEL, url: `${r.source}#sb-direct` }];
}

/** Forget every lookup (tests). */
export const clearMovyCache = () => cache.clear();
