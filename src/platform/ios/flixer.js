// Flixer on iOS: movies and series resolved straight to a stream through
// Flixer's own source API (utils/servers/flixer.js), like Movy: no site, no
// embed page. Flixer's key and decrypter are its own WASM, fetched from the
// site and run here in the web view (it reads window/screen/canvas). The API
// and its assets send no CORS headers, so requests go through native HTTP.
// Domains: flixer.gd, then flixer.su and flixer.cx as fallbacks.
import { CapacitorHttp } from "@capacitor/core";
import { resolveFlixer, flixerApi, FLIXER_UA } from "../../utils/servers/flixer";
import { diag } from "../../utils/diag";

export const FLIXER_ID = "flixer-direct";
export const FLIXER_LABEL = "Flixer";
const MAX_AGE_MS = 15 * 60_000;
const WAIT_ON_PLAY_MS = 2500;

async function nativeGet(url, headers) {
  const res = await CapacitorHttp.get({ url, headers, responseType: "text", connectTimeout: 6000, readTimeout: 9000 });
  if (!res || res.status >= 400) throw new Error(`HTTP ${res?.status}`);
  return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
}

async function nativeBytes(url, headers) {
  const res = await CapacitorHttp.get({ url, headers, responseType: "arraybuffer", connectTimeout: 6000, readTimeout: 15000 });
  if (!res || res.status >= 400) throw new Error(`HTTP ${res?.status}`);
  const d = res.data;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  const bin = atob(String(d));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Flixer's WASM, loaded once per domain: { key, decrypt }.
const wasmByDomain = new Map();
async function loadWasmNative(domain) {
  if (wasmByDomain.has(domain)) return wasmByDomain.get(domain);
  const p = (async () => {
    const base = flixerApi(domain);
    const h = { "User-Agent": FLIXER_UA, Origin: `https://${domain}`, Referer: `https://${domain}/` };
    const [glue, bytes] = await Promise.all([
      nativeGet(`${base}/assets/wasm/img_data.js`, h),
      nativeBytes(`${base}/assets/wasm/img_data_bg.wasm`, h),
    ]);
    const blobUrl = URL.createObjectURL(new Blob([glue], { type: "text/javascript" }));
    try {
      const mod = await import(/* @vite-ignore */ blobUrl);
      await mod.default({ module_or_path: bytes });
      // The key check wants the page to have been open for a moment.
      const wait = 1500 - (performance?.now?.() || 0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const key = await mod.get_img_key();
      if (typeof key !== "string" || key.length !== 64) throw new Error("flixer: bad key");
      return { key, decrypt: (text, k) => mod.process_img_data(text, k) };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  })();
  wasmByDomain.set(domain, p);
  p.catch(() => wasmByDomain.delete(domain));
  return p;
}

let http = nativeGet;
let loadWasm = loadWasmNative;
/** Tests swap the HTTP client and the WASM loader. */
export const setFlixerHttp = (fn, wasm) => {
  http = fn || nativeGet;
  loadWasm = wasm || loadWasmNative;
};

const nativeHttpAvailable = () => {
  try {
    return http !== nativeGet || !!window.Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
};

// The domain that answered last goes first next time.
let domains = ["flixer.gd", "flixer.su", "flixer.cx"];
const cache = new Map();

/** Cache key, or null when Flixer isn't used (anime has ani.pm). */
export const flixerKey = (ctx) => {
  if (!ctx?.tmdbId || ctx.isAnime) return null;
  const s = ctx.tmdbSeason ?? ctx.season ?? 1;
  const e = ctx.tmdbEpisode ?? ctx.episode ?? 1;
  return ctx.type === "tv" ? `tv:${ctx.tmdbId}:${s}:${e}` : `movie:${ctx.tmdbId}`;
};

/** Start (or reuse) the lookup for `ctx`; resolves to the result or null. */
export function prefetchFlixer(ctx, { now = Date.now } = {}) {
  const key = flixerKey(ctx);
  if (!key || !nativeHttpAvailable()) return Promise.resolve(null);
  const hit = cache.get(key);
  if (hit && now() - hit.at < MAX_AGE_MS && !hit.error) return hit.promise;
  const started = now();
  const entry = { at: started };
  entry.promise = resolveFlixer(
    http,
    loadWasm,
    {
      type: ctx.type === "tv" ? "tv" : "movie",
      tmdbId: ctx.tmdbId,
      season: ctx.tmdbSeason ?? ctx.season ?? 1,
      episode: ctx.tmdbEpisode ?? ctx.episode ?? 1,
    },
    { domains },
  )
    .then((r) => {
      entry.result = r;
      domains = [r.domain, ...domains.filter((d) => d !== r.domain)];
      diag("player", `flixer ${key}: ${r.server}@${r.domain} in ${now() - started} ms`);
      return r;
    })
    .catch((e) => {
      entry.error = e;
      entry.at = now() - MAX_AGE_MS + 60_000;
      diag("player", `flixer ${key}: ${e?.message || e} after ${now() - started} ms`);
      return null;
    });
  cache.set(key, entry);
  while (cache.size > 30) cache.delete(cache.keys().next().value);
  return entry.promise;
}

/** Flixer's stream as a native-player / downloader candidate ("#sb-direct"). */
export async function flixerCandidates(ctx, { waitMs = WAIT_ON_PLAY_MS } = {}) {
  if (!flixerKey(ctx)) return [];
  const r = await Promise.race([prefetchFlixer(ctx), new Promise((res) => setTimeout(() => res(null), waitMs))]);
  if (!r?.ok) return [];
  // Its stream host wants the site as Referer.
  return [{ id: FLIXER_ID, label: FLIXER_LABEL, url: `${r.source}#sb-direct`, referer: `https://${r.domain}/` }];
}

/** Forget every lookup (tests). */
export const clearFlixerCache = () => cache.clear();
