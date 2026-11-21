// Custom servers, Direct mode on iOS: call a site's own stream API with the
// native HTTP client (no CORS, Referer / Origin allowed) and hand the stream
// to the native player as "<stream>#sb-direct", the way Cinejoy does: no
// page load, no ads, no redirects. The API is learned from what the site's
// page did during a Test or a first play (StreamSniffer's learn log), or from
// the routes its scripts build; hand-written fields are only a fallback.
import { CapacitorHttp } from "@capacitor/core";
import {
  buildDirectRequest,
  checkAnswer,
  directServerVariant,
  endpointCandidates,
  extractStream,
  extractorFor,
  learnFromLog,
  pageHeaders,
  scanEndpoints,
  scanWorthy,
  signedReason,
  MAX_TEXT,
} from "../../utils/customServers/direct";
import { originOf } from "../../utils/customServers/template";
import { withSchemeFallback } from "../../utils/customServers/scheme";
import { diag } from "../../utils/diag";

/** Play waits at most this long for a site's API before using its page. */
export const DIRECT_TIMEOUT_MS = 4000;
/** Downloads wait a little longer (the quality list comes from the stream). */
export const DIRECT_DOWNLOAD_TIMEOUT_MS = 8000;
/** A found stream is reused this long (most stream tokens outlive it). */
const DIRECT_CACHE_MS = 8 * 60_000;
/** Learning: requests tried at once, and scripts read from the page. */
const TRY_PARALLEL = 4;
const MAX_SCRIPTS = 8;
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;

/** Safari's user agent, so a site's API answers the app like the browser. */
export const SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/**
 * One request through the native HTTP client; text out. A link that can't
 * be reached on its scheme is tried once on the other (http ↔ https).
 */
const nativeRequest = (req) => withSchemeFallback(req.url, (url) => nativeRequestOnce({ ...req, url }));

async function nativeRequestOnce({ url, method = "GET", headers = {}, body = null, timeoutMs = DIRECT_TIMEOUT_MS }) {
  const res = await CapacitorHttp.request({
    url,
    method,
    headers: { "User-Agent": SAFARI_UA, ...headers },
    ...(body != null ? { data: body } : {}),
    responseType: "text",
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
  });
  const text = typeof res?.data === "string" ? res.data : JSON.stringify(res?.data ?? "");
  return { status: res?.status ?? 0, text: text.slice(0, MAX_TEXT), url: res?.url || url };
}

let http = nativeRequest;
/** Tests swap the HTTP client. */
export const setDirectHttp = (fn) => (http = fn || nativeRequest);
/** The HTTP client smart add and the crawler share. */
export const directHttp = (req) => http(req);

/** Reject after `ms` (the request itself keeps its own timeouts). */
const within = (p, ms, what) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms))]);

/**
 * Call a direct definition for one title.
 * @param {object} def { url, method, headers, body, extract, streamHeaders }
 * @param {object} values the title's values (TMDB ids, title, season, episode…)
 * @param {object|null} want TMDB's idea of the title, for the answer check
 * @returns {Promise<{ ok, stream?, status?, check?, error?, request? }>}
 */
export async function resolveDirect(def, values, want = null, { timeoutMs = DIRECT_TIMEOUT_MS } = {}) {
  const request = buildDirectRequest(def, values);
  if (!request) return { ok: false, error: "The API address needs a value this title doesn't have." };
  let res;
  try {
    res = await within(http({ ...request, timeoutMs }), timeoutMs + 500, "The site's API");
  } catch (e) {
    return { ok: false, request, error: e?.message || String(e) };
  }
  if (res.status < 200 || res.status >= 300) return { ok: false, request, status: res.status, error: `The API answered HTTP ${res.status}` };
  const check = want ? checkAnswer(res.text, want) : "unknown";
  if (check === "mismatch") return { ok: false, request, status: res.status, check, error: "The API answered for a different title." };
  const stream = extractStream(res.text, def.extract, res.url || request.url);
  if (!stream) return { ok: false, request, status: res.status, check, error: "No stream in the API's answer." };
  return { ok: true, request, status: res.status, check, stream };
}

// ── Play: cached lookups, like Cinejoy's prefetch ────────────────────────

const cache = new Map(); // key -> { at, promise }

/** Look up (or reuse) a server's direct stream for one title. */
export function cachedResolve(key, def, values, want, opts) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DIRECT_CACHE_MS) return hit.promise;
  const entry = { at: Date.now() };
  entry.promise = resolveDirect(def, values, want, opts).then((r) => {
    if (!r.ok) cache.delete(key); // a miss is retried next time
    diag("custom", `direct ${key}: ${r.ok ? `stream in HTTP ${r.status}` : r.error}`);
    return r;
  });
  cache.set(key, entry);
  while (cache.size > 60) cache.delete(cache.keys().next().value);
  return entry.promise;
}

export const clearDirectCache = () => cache.clear();

// ── Learning ─────────────────────────────────────────────────────────────

/** Run `fn` over `items`, `n` at a time, stopping at the first truthy result. */
async function firstOf(items, n, fn) {
  let i = 0;
  let found = null;
  const worker = async () => {
    while (!found && i < items.length) {
      const item = items[i++];
      const r = await fn(item);
      if (r && !found) found = r;
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return found;
}

/** Script texts the page ran: inline ones from the log, site bundles fetched. */
async function scriptTexts(log) {
  const inline = (log?.scripts || []).filter((s) => s.text).map((s) => s.text);
  const urls = [...new Set((log?.scripts || []).filter((s) => s.url && scanWorthy(s.url)).map((s) => s.url))].slice(0, MAX_SCRIPTS);
  const fetched = await Promise.all(
    urls.map((url) =>
      http({ url, timeoutMs: DIRECT_TIMEOUT_MS })
        .then((r) => (r.status === 200 && r.text.length < MAX_SCRIPT_BYTES ? r.text : null))
        .catch((e) => {
          diag("custom", `script ${url}: ${e?.message || e}`);
          return null;
        }),
    ),
  );
  return [...inline, ...fetched.filter(Boolean)];
}

/**
 * Learn a site's stream API for one kind of link.
 * @param {{ kind, values, want, stream, streamHeaders, log, page }} input
 *   stream: what the page played; streamHeaders: the headers it played with;
 *   log: { requests, scripts } from the hidden page (all frames)
 * @returns {Promise<{ ok: true, def, via: "page"|"scripts" } | { ok: false, reason }>}
 */
export async function learnDirect({ kind, values, want, stream, streamHeaders = {}, log, page = null }) {
  const keep = (def, via) => ({
    ok: true,
    via,
    def: {
      url: def.url,
      method: def.method,
      headers: def.headers,
      body: def.body ?? null,
      extract: def.extract,
      ...(def.server ? { server: def.server } : {}),
      streamHeaders: { ...pageHeaders(page), ...streamHeaders, "User-Agent": SAFARI_UA },
      source: "auto",
      learnedAt: Date.now(),
    },
  });
  // 1. A request the page made held the stream: replay it to be sure.
  const fromLog = learnFromLog(log, { stream, values, kind });
  if (fromLog.ok) {
    const r = await resolveDirect(fromLog.def, values, want);
    if (r.ok) return keep(fromLog.def, "page");
    diag("custom", `learned API didn't replay: ${r.error}`);
    return { ok: false, reason: `The site's API only answers its own page (${r.error}).` };
  }
  if (fromLog.encrypted || fromLog.signed) return { ok: false, reason: fromLog.reason };
  // 2. The stream was built in the page: API addresses in its scripts.
  const texts = await scriptTexts(log);
  const patterns = texts.flatMap((t) => scanEndpoints(t));
  const bases = [...new Set([page, ...(log?.requests || []).map((r) => r.page), ...(log?.scripts || []).map((s) => s.page)].map(originOf).filter(Boolean))];
  const candidates = endpointCandidates(patterns, bases, kind, values);
  diag("custom", `direct: ${patterns.length} script endpoint(s), ${candidates.length} to try`);
  const hit = await firstOf(candidates, TRY_PARALLEL, async (url) => {
    const def = { url, method: "GET", headers: pageHeaders(page || url), body: null };
    const req = buildDirectRequest(def, values);
    if (!req) return null;
    const res = await http({ ...req, timeoutMs: DIRECT_TIMEOUT_MS }).catch(() => null);
    if (!res || res.status < 200 || res.status >= 300) return null;
    const extract = extractorFor(res.text, stream) || extractorFor(res.text, null);
    if (!extract || signedReason({ url: req.url })) return null;
    if (want && checkAnswer(res.text, want) === "mismatch") return null;
    return { ...def, extract };
  });
  if (hit) return keep(hit, "scripts");
  return { ok: false, reason: fromLog.reason };
}

/**
 * The "Test direct" steps for a definition: request built, status code,
 * stream found, stream playable (native headless player), title check.
 * @param {(url, headers) => Promise<{ok, detail?, error?}>|null} playable
 */
export async function testDirect(def, values, want, { playable = null } = {}) {
  const steps = [];
  const request = buildDirectRequest(def, values);
  steps.push({
    id: "d-request",
    ok: !!request,
    label: "Direct: request built",
    detail: request ? `${request.method} ${request.url}` : "The API address needs a value this title doesn't have.",
  });
  if (!request) return { ok: false, steps };
  const r = await resolveDirect(def, values, want);
  steps.push({
    id: "d-status",
    ok: r.status >= 200 && r.status < 300,
    label: "Direct: API answered",
    detail: r.status ? `HTTP ${r.status}` : r.error,
  });
  steps.push({
    id: "d-stream",
    ok: r.ok,
    label: "Direct: stream URL found",
    detail: r.ok ? r.stream : r.check === "mismatch" ? "The API answered for a different title (skipped)" : r.error,
  });
  let play = { ok: false, error: "Skipped: no stream" };
  if (r.ok && playable) play = await playable(r.stream, def.streamHeaders || {});
  else if (r.ok) play = { ok: false, error: "Checking playback needs the iPhone app." };
  steps.push({ id: "d-playable", ok: !!play.ok, label: "Direct: stream playable", detail: play.ok ? play.detail || "Ready to play" : play.error });
  return { ok: steps.every((s) => s.ok), steps, stream: r.stream || null };
}

/**
 * Try every server the site's API offers (?sub=vortex, nova, zen…), not only
 * the first that works: [{ value, ok, stream?, detail }], in the API's order.
 * Stops trying (the rest marked not tried) when `signal` aborts.
 */
export async function testApiServers(def, values, want, { playable = null, signal = null } = {}) {
  const out = [];
  for (const value of def?.server?.list || []) {
    if (signal?.aborted) {
      out.push({ value, ok: false, tried: false, detail: "Not tried (stopped)" });
      continue;
    }
    const v = directServerVariant(def, value);
    const r = v ? await resolveDirect(v, values, want) : { ok: false, error: "No request" };
    let play = r.ok ? (playable ? await playable(r.stream, def.streamHeaders || {}) : { ok: true }) : { ok: false, error: r.error };
    out.push({ value, ok: !!play.ok, tried: true, stream: r.stream || null, detail: play.ok ? r.stream : play.error || r.error });
  }
  return out;
}
