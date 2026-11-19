// ani.pm on iOS: the main anime server. Resolves the title on screen (AniList
// id + episode + the profile's Sub/Dub choice) to a playable HLS master as
// soon as the title page publishes its context, so Play starts on it without
// waiting. ani.pm's API sends no CORS headers, so requests go through the
// native HTTP client (CapacitorHttp, URLSession). Player only: downloads keep
// their own server list.
import { CapacitorHttp } from "@capacitor/core";
import { resolveAnipm } from "../../utils/servers/anipm";
import { diag } from "../../utils/diag";

export const ANIPM_ID = "anipm";
export const ANIPM_LABEL = "ani.pm";
const MAX_AGE_MS = 20 * 60_000; // re-resolve after this, or 1 min before the session expires
const WAIT_ON_PLAY_MS = 3000; // Play waits at most this long for a lookup still running

const parse = (data) => (typeof data === "string" ? JSON.parse(data) : data);

/** GET through the native HTTP client (no CORS); JSON in, JSON out. */
async function nativeGet(url, headers) {
  const res = await CapacitorHttp.get({ url, headers, responseType: "json", connectTimeout: 8000, readTimeout: 8000 });
  if (!res || res.status >= 400) throw new Error(`HTTP ${res?.status}`);
  return parse(res.data);
}

let http = nativeGet;
/** Tests swap the HTTP client. */
export const setAnipmHttp = (fn) => (http = fn || nativeGet);

const nativeHttpAvailable = () => {
  try {
    return http !== nativeGet || !!window.Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
};

const cache = new Map(); // key -> { at, promise, result?, error? }

export const anipmKey = (ctx) => {
  if (!ctx?.isAnime || !ctx.anilistId) return null;
  const ep = ctx.type === "movie" ? 1 : ctx.episode ?? 1;
  return `${ctx.anilistId}:${ep}:${ctx.dubMode === "dub" ? "dub" : "sub"}`;
};

const fresh = (e, now) =>
  e &&
  now - e.at < MAX_AGE_MS &&
  (!e.result?.expiresAt || e.result.expiresAt - now > 60_000);

/**
 * Start (or reuse) the lookup for `ctx`. Resolves to the result or null
 * (not anime, no AniList id, no native HTTP, or ani.pm has no stream).
 */
export function prefetchAnipm(ctx, { now = Date.now } = {}) {
  const key = anipmKey(ctx);
  if (!key || !nativeHttpAvailable()) return Promise.resolve(null);
  const hit = cache.get(key);
  if (fresh(hit, now()) && !hit.error) return hit.promise;
  const started = now();
  const entry = { at: started };
  entry.promise = resolveAnipm(http, {
    anilistId: ctx.anilistId,
    episode: ctx.type === "movie" ? 1 : ctx.episode ?? 1,
    lang: ctx.dubMode === "dub" ? "dub" : "sub",
  })
    .then((r) => {
      entry.result = r;
      diag(
        "player",
        `ani.pm ${key}: ${r.lang} stream in ${r.ms.total} ms (bootstrap ${r.ms.bootstrap}, session ${r.ms.session}, stream ${r.ms.stream})`,
      );
      return r;
    })
    .catch((e) => {
      entry.error = e;
      entry.at = now() - MAX_AGE_MS + 60_000; // retry a failed lookup after a minute
      diag("player", `ani.pm ${key}: ${e?.message || e} after ${now() - started} ms`);
      return null;
    });
  cache.set(key, entry);
  while (cache.size > 30) cache.delete(cache.keys().next().value);
  return entry.promise;
}

/**
 * ani.pm candidates for the native player, best first: the HLS master
 * itself (played directly, "#sb-direct"), then the ani.pm embed page as a
 * sniffer fallback. Empty when ani.pm has nothing for this episode, or when
 * Dub was asked for and ani.pm only has Sub (Dub never silently plays Sub).
 * Waits up to `waitMs` for a lookup still running.
 */
export async function anipmCandidates(ctx, { waitMs = WAIT_ON_PLAY_MS } = {}) {
  const key = anipmKey(ctx);
  if (!key) return [];
  const r = await Promise.race([
    prefetchAnipm(ctx),
    new Promise((res) => setTimeout(() => res(null), waitMs)),
  ]);
  if (!r?.ok) return [];
  const wanted = ctx.dubMode === "dub" ? "dub" : "sub";
  if (r.lang !== wanted) return [];
  const id = `${ANIPM_ID}:${r.lang}`;
  const label = `${ANIPM_LABEL} · ${r.lang === "dub" ? "Dub" : "Sub"}`;
  return [
    { id, label, url: `${r.source}#sb-direct` },
    { id, label, url: r.embedUrl },
  ];
}

/**
 * What ani.pm reported for this episode ({ sub, dub }), from any finished
 * lookup of it (Sub or Dub), or null while unknown. The server sheet greys
 * out Dub when ani.pm says the episode has no dub.
 */
export function anipmAvailability(ctx) {
  const key = anipmKey(ctx);
  if (!key) return null;
  const base = key.replace(/:(sub|dub)$/, "");
  for (const k of [`${base}:sub`, `${base}:dub`]) {
    const a = cache.get(k)?.result?.availability;
    if (a) return a;
  }
  return null;
}

/** Forget every lookup (tests). */
export const clearAnipmCache = () => cache.clear();
