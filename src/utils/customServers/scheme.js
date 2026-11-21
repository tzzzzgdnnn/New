// Custom servers: http ↔ https fallback for a site's links.
//
// Some sites answer only on http (home servers, small hosts), some only on
// https, and some send one to the other. Every link the app opens for a
// custom server (Test, Play, Downloads, the site's own API) is tried in
// order: the site's https first and http when that fails, except for
// addresses on the viewer's own network (http first, they rarely have a
// certificate) and hosts this session already saw working on one scheme.
// The native hidden page gets the second link as `altUrl` and loads it when
// the first one can't be reached. Pure logic, no I/O (tests import it).
import { isLocalAddress } from "./template.js";

/** host[:port] -> "http:" | "https:" that worked this session. */
const worked = new Map();

const parse = (url) => {
  try {
    const u = new URL(String(url).trim());
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
};

/** The same link on the other scheme (default ports dropped), or null. */
export function flipScheme(url) {
  const u = parse(url);
  if (!u) return null;
  const to = u.protocol === "https:" ? "http:" : "https:";
  // An explicit default port of the old scheme would be wrong on the new one.
  const port = (u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80") ? "" : u.port;
  const out = new URL(u.href);
  out.protocol = to;
  out.port = port;
  return out.href;
}

/** Session key for a link's host (port kept: a LAN box can have several servers). */
const hostKey = (u) => `${u.hostname.toLowerCase()}${u.port ? ":" + u.port : ""}`;

/** Record which scheme a link actually loaded on (the final page after redirects). */
export function rememberScheme(url) {
  const u = parse(url);
  if (u) worked.set(hostKey(u), u.protocol);
}

/** The scheme that worked for this link's host this session, or null. */
export function rememberedScheme(url) {
  const u = parse(url);
  return u ? worked.get(hostKey(u)) || null : null;
}

/** Tests: forget what worked. */
export const forgetSchemes = () => worked.clear();

/**
 * The links to try for one link, best first: [first, second]. The second is
 * null for non-http(s) links. Order: the scheme that worked this session;
 * else http first on the viewer's own network; else https first.
 */
export function schemeOrder(url) {
  const u = parse(url);
  if (!u) return [url, null];
  const flipped = flipScheme(url);
  const same = String(url).trim();
  const remembered = rememberedScheme(url);
  const want = remembered || (isLocalAddress(url) ? "http:" : "https:");
  return u.protocol === want ? [same, flipped] : [flipped, same];
}

/**
 * Whether a failed request is worth retrying on the other scheme: the
 * connection failed (no HTTP answer at all), TLS / certificate errors, ATS
 * refusing plain http, or an http answer from an https-only port.
 * `url` is the link that was asked for: a 400 / 426 / 497 only counts on
 * plain http (nginx's "plain HTTP request was sent to HTTPS port").
 * @param {{ status?: number, error?: unknown, url?: string }} r
 */
export function isSchemeFailure({ status, error, url } = {}) {
  if ((status === 400 || status === 426 || status === 497) && /^http:/i.test(String(url || ""))) return true;
  if (status && status > 0) return false;
  const msg = String(error?.message || error || "").toLowerCase();
  if (!msg && (status === 0 || status === undefined)) return true;
  return /ssl|tls|certificate|secure connection|could not connect|couldn.t connect|connection (refused|reset|lost|was lost)|timed out|network connection|app transport security|insecure|-1200|-120[1-6]|-1004|-1005|-1001|-1022|failed to fetch|load failed|econnrefused|econnreset|cannot parse response/.test(msg);
}

/**
 * Run `fn(url)` on the link and, when it fails at the connection (see
 * isSchemeFailure), on the other scheme. `fn` resolves { status, ... } or
 * throws. The scheme that answered is remembered for the session.
 */
export async function withSchemeFallback(url, fn) {
  const [first, second] = schemeOrder(url);
  let firstErr = null;
  let firstRes = null;
  try {
    firstRes = await fn(first);
    if (!isSchemeFailure({ status: firstRes?.status, url: first })) {
      rememberScheme(firstRes?.url || first);
      return firstRes;
    }
  } catch (e) {
    firstErr = e;
    if (!second || !isSchemeFailure({ error: e })) throw e;
  }
  if (!second) return firstRes;
  try {
    const res = await fn(second);
    const bad = isSchemeFailure({ status: res?.status, url: second });
    if (!bad) rememberScheme(res?.url || second);
    // Neither answered: the first answer stands.
    return bad && firstRes ? firstRes : res;
  } catch (e) {
    if (firstRes) return firstRes;
    throw firstErr || e;
  }
}

/**
 * The fields a native candidate carries for the fallback: `loadUrl` (the
 * link to open first, when it is not the link itself) and `altUrl` (the one
 * to open when that can't be reached). The candidate's `url` stays the link
 * as built: it names the link in caches and the learn log.
 */
export function schemeFields(url) {
  const [first, second] = schemeOrder(url);
  if (!second) return {};
  const link = String(url).trim();
  return first === link ? { altUrl: second } : { loadUrl: first, altUrl: link };
}
