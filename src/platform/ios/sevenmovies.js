// 7Movies on iOS: its two Vidrift servers, Orion and Evion, as direct streams
// (utils/servers/sevenmovies.js), like Movy and Cinejoy: no site, no embed page
// in a web view. One lookup gives both. Vidrift's embed page sends no CORS
// headers, so requests go through the native HTTP client. The native player
// adds Referer https://embed.vidrift.net/ for Orion's playlists.
import { CapacitorHttp } from "@capacitor/core";
import { resolveSevenMovies } from "../../utils/servers/sevenmovies";
import { diag } from "../../utils/diag";

export const ORION_ID = "7movies-orion";
export const EVION_ID = "7movies-evion";
export const ORION_LABEL = "7Movies Orion";
export const EVION_LABEL = "7Movies Evion";
export const SEVENMOVIES_IDS = [ORION_ID, EVION_ID];
const MAX_AGE_MS = 15 * 60_000;
const WAIT_ON_PLAY_MS = 2500;

async function nativeGet(url, headers) {
  const res = await CapacitorHttp.get({ url, headers, responseType: "text", connectTimeout: 6000, readTimeout: 10000 });
  if (!res || res.status >= 400) throw new Error(`HTTP ${res?.status}`);
  return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
}

let http = nativeGet;
/** Tests swap the HTTP client. */
export const setSevenMoviesHttp = (fn) => {
  http = fn || nativeGet;
};

const nativeHttpAvailable = () => {
  try {
    return http !== nativeGet || !!window.Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
};

const cache = new Map();

export const sevenMoviesKey = (ctx) => {
  if (!ctx?.tmdbId || ctx.isAnime) return null;
  const s = ctx.tmdbSeason ?? ctx.season ?? 1;
  const e = ctx.tmdbEpisode ?? ctx.episode ?? 1;
  return ctx.type === "tv" ? `tv:${ctx.tmdbId}:${s}:${e}` : `movie:${ctx.tmdbId}`;
};

export function prefetchSevenMovies(ctx, { now = Date.now } = {}) {
  const key = sevenMoviesKey(ctx);
  if (!key || !nativeHttpAvailable()) return Promise.resolve(null);
  const hit = cache.get(key);
  if (hit && now() - hit.at < MAX_AGE_MS && !hit.error) return hit.promise;
  const started = now();
  const entry = { at: started };
  entry.promise = resolveSevenMovies(http, {
    type: ctx.type === "tv" ? "tv" : "movie",
    tmdbId: ctx.tmdbId,
    season: ctx.tmdbSeason ?? ctx.season ?? 1,
    episode: ctx.tmdbEpisode ?? ctx.episode ?? 1,
  })
    .then((r) => {
      entry.result = r;
      diag("player", `7movies ${key}: orion=${!!r.orion} evion=${!!r.evion} in ${now() - started} ms`);
      return r;
    })
    .catch((e) => {
      entry.error = e;
      entry.at = now() - MAX_AGE_MS + 60_000;
      diag("player", `7movies ${key}: ${e?.message || e} after ${now() - started} ms`);
      return null;
    });
  cache.set(key, entry);
  while (cache.size > 30) cache.delete(cache.keys().next().value);
  return entry.promise;
}

/** Orion and Evion as native-player / downloader candidates ("#sb-direct"). */
export async function sevenMoviesCandidates(ctx, { waitMs = WAIT_ON_PLAY_MS } = {}) {
  if (!sevenMoviesKey(ctx)) return [];
  const r = await Promise.race([prefetchSevenMovies(ctx), new Promise((res) => setTimeout(() => res(null), waitMs))]);
  if (!r) return [];
  const out = [];
  if (r.orion) out.push({ id: ORION_ID, label: ORION_LABEL, url: `${r.orion}#sb-direct` });
  if (r.evion) out.push({ id: EVION_ID, label: EVION_LABEL, url: `${r.evion}#sb-direct` });
  return out;
}

export const clearSevenMoviesCache = () => cache.clear();
