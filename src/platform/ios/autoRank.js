// Player "Auto" ranking on iOS: measures the play candidates of the title on
// screen (in parallel, ~1.8 s budget) as soon as its page opens, so Play
// starts on the best server measured so far without waiting. Player only:
// downloads keep their own server order (webview.js downloadCandidates).
import {
  createMeasureCache,
  formatSample,
  measureCandidates,
  rankMeasured,
  MEASURE_BUDGET_MS,
} from "../../utils/servers/measure";
import { parseServerKey } from "../../utils/servers/catalog";
import { diag } from "../../utils/diag";

const STORE_KEY = "sb_serverMeasure";
const SAMPLE_BYTES = 256 * 1024; // enough for a stable rate, small enough for 1-2 s

/**
 * Network the measurements belong to. WKWebView has no Network Information
 * API, so this is the connection type when the browser exposes one, else one
 * shared key; the cache is also dropped whenever the device goes on/offline.
 */
export function networkKey() {
  try {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c) return [c.type, c.effectiveType].filter(Boolean).join("/") || "net";
  } catch {}
  return "net";
}

const store = {
  get: () => {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(v));
    } catch {}
  },
};

export const measureCache = createMeasureCache(store, { network: networkKey });

try {
  const reset = () => measureCache.clear();
  window.addEventListener?.("online", reset);
  window.addEventListener?.("offline", reset);
} catch {}

const listeners = new Set();
/** Called with no arguments whenever a measurement lands. Returns unsubscribe. */
export function onRankingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((fn) => {
  try {
    fn();
  } catch {}
});

const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

/**
 * Sample one server: latency is the time to the response headers, throughput
 * the rate at which the first SAMPLE_BYTES of the body arrive. Hosts that send
 * CORS headers give both; for the rest only an opaque answer is readable, so
 * the sample is latency-only. Errors and 4xx/5xx answers reject (no stream).
 */
export async function sampleServer(candidate, signal, fetchImpl = globalThis.fetch) {
  const t0 = now();
  let res;
  try {
    res = await fetchImpl(candidate.url, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      redirect: "follow",
      headers: { Range: `bytes=0-${SAMPLE_BYTES - 1}` },
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    // CORS refused (or a network error): latency through an opaque request.
    const t1 = now();
    const opaque = await fetchImpl(candidate.url, { method: "GET", mode: "no-cors", cache: "no-store", redirect: "follow", signal });
    if (opaque.type !== "opaque" && opaque.status >= 400) throw new Error(`HTTP ${opaque.status}`);
    return { bps: null, latencyMs: now() - t1 };
  }
  const latencyMs = now() - t0;
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  const reader = res.body?.getReader?.();
  if (!reader) return { bps: null, latencyMs };
  const t1 = now();
  let bytes = 0;
  try {
    while (bytes < SAMPLE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength || 0;
    }
  } finally {
    try {
      reader.cancel();
    } catch {}
  }
  const secs = Math.max(0.001, (now() - t1) / 1000);
  // Tiny bodies (a short HTML page) say nothing about bandwidth.
  return { bps: bytes >= 32 * 1024 ? bytes / secs : null, latencyMs };
}

let running = null; // { key, ctrl, promise }

/**
 * Start measuring `candidates` (the title's play candidates) in the
 * background. Fresh cached samples are reused instantly; a run for the same
 * list is not repeated. Returns the run's promise.
 */
export function prefetchRanking(candidates, { key = "", sample = sampleServer, budgetMs = MEASURE_BUDGET_MS } = {}) {
  if (!candidates?.length) return Promise.resolve(measureCache.all());
  if (running?.key === key && key) return running.promise;
  running?.ctrl.abort();
  const ctrl = new AbortController();
  const started = now();
  const promise = measureCandidates(candidates, {
    sample,
    cache: measureCache,
    budgetMs,
    signal: ctrl.signal,
    onResult: (provider, s) => {
      diag("player", `measure ${provider}: ${formatSample(s) || "?"}`);
      notify();
    },
  }).then((all) => {
    if (!ctrl.signal.aborted) diag("player", `measure done in ${Math.round(now() - started)} ms (${candidates.length} candidates)`);
    return all;
  });
  running = { key, ctrl, promise };
  promise.finally(() => {
    if (running?.promise === promise) running = null;
  });
  return promise;
}

/** Whether a measurement run is still going. */
export const isMeasuring = () => !!running;

/** Candidates in Auto order right now (best measured first, no waiting). */
export const autoOrder = (candidates, opts) => rankMeasured(candidates, (p) => measureCache.get(p), opts);

/** Measured sample of a server id (any audio mode), or undefined. */
export const sampleFor = (id) => measureCache.get(parseServerKey(id).sourceId);

/**
 * Real throughput from the native player (AVPlayer's observed bitrate at the
 * first frame, bits/s): the best reading there is for that server.
 */
export function recordPlayback(serverId, bitsPerSecond, latencyMs = null) {
  if (!serverId || !(bitsPerSecond > 0)) return;
  measureCache.record(parseServerKey(serverId).sourceId, {
    ok: true,
    bps: bitsPerSecond / 8,
    latencyMs,
    from: "play",
  });
  notify();
}
