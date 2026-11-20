// Rivestream on iOS: movies and series resolved straight to a stream through
// Rivestream's own source API (utils/servers/rivestream.js), like Flixer: no
// site, no embed page. Its API sends no CORS headers, so it goes through
// native HTTP. Each verified Rivestream server is its own direct server.
import { CapacitorHttp } from "@capacitor/core";
import { resolveRive, RIVE_SERVERS, RIVE_ORIGIN } from "../../utils/servers/rivestream";
import { diag } from "../../utils/diag";

export const RIVE_IDS = Object.keys(RIVE_SERVERS).map((s) => `rive-${s}`);
const MAX_AGE_MS = 15 * 60_000;
const WAIT_ON_PLAY_MS = 2500;

async function nativeGet(url, headers) {
  const res = await CapacitorHttp.get({ url, headers, responseType: "text", connectTimeout: 6000, readTimeout: 12000 });
  if (!res || res.status >= 400) throw new Error(`HTTP ${res?.status}`);
  return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
}

let http = nativeGet;
/** Tests swap the HTTP client. */
export const setRiveHttp = (fn) => {
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

/** Cache key, or null when Rivestream isn't used (anime has ani.pm). */
export const riveKey = (ctx) => {
  if (!ctx?.tmdbId || ctx.isAnime) return null;
  const s = ctx.tmdbSeason ?? ctx.season ?? 1;
  const e = ctx.tmdbEpisode ?? ctx.episode ?? 1;
  return ctx.type === "tv" ? `tv:${ctx.tmdbId}:${s}:${e}` : `movie:${ctx.tmdbId}`;
};

function lookup(ctx, server, now) {
  const key = `${riveKey(ctx)}:${server}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < MAX_AGE_MS && !hit.error) return hit.promise;
  const started = now();
  const entry = { at: started };
  entry.promise = resolveRive(
    http,
    {
      type: ctx.type === "tv" ? "tv" : "movie",
      tmdbId: ctx.tmdbId,
      season: ctx.tmdbSeason ?? ctx.season ?? 1,
      episode: ctx.tmdbEpisode ?? ctx.episode ?? 1,
    },
    server,
    { now },
  )
    .then((r) => {
      diag("player", `rivestream ${key}: ${r.quality} in ${now() - started} ms`);
      return r;
    })
    .catch((e) => {
      entry.error = e;
      entry.at = now() - MAX_AGE_MS + 60_000;
      diag("player", `rivestream ${key}: ${e?.message || e} after ${now() - started} ms`);
      return null;
    });
  cache.set(key, entry);
  while (cache.size > 60) cache.delete(cache.keys().next().value);
  return entry.promise;
}

/** Start (or reuse) every server's lookup for `ctx`. */
export function prefetchRive(ctx, { now = Date.now } = {}) {
  if (!riveKey(ctx) || !nativeHttpAvailable()) return Promise.resolve([]);
  return Promise.all(Object.keys(RIVE_SERVERS).map((s) => lookup(ctx, s, now)));
}

/** Each Rivestream server's stream as a native-player / downloader candidate ("#sb-direct"). */
export async function riveCandidates(ctx, { waitMs = WAIT_ON_PLAY_MS } = {}) {
  if (!riveKey(ctx) || !nativeHttpAvailable()) return [];
  const servers = Object.keys(RIVE_SERVERS);
  const results = await Promise.all(
    servers.map((s) => Promise.race([lookup(ctx, s, Date.now), new Promise((res) => setTimeout(() => res(null), waitMs))])),
  );
  return results
    .map((r, i) => (r?.ok ? { id: `rive-${servers[i]}`, label: RIVE_SERVERS[servers[i]].label, url: `${r.source}#sb-direct`, referer: `${RIVE_ORIGIN}/` } : null))
    .filter(Boolean);
}

/** Forget every lookup (tests). */
export const clearRiveCache = () => cache.clear();
