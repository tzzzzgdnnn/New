// Custom servers, Direct mode: call a site's own stream API instead of
// loading its page (like Cinejoy). Pure logic (no DOM, no network), tested
// in scripts/test-custom-direct.mjs:
//  - learnFromLog: which request the page made returned the stream, turned
//    into a reusable request template with the path to the stream in its answer
//  - scanEndpoints: API addresses written in the page's scripts, for streams
//    built client-side
//  - buildDirectRequest / extractStream: replay a template for any title
//  - checkTitle: whether a page or API answer is about the title asked for
import { detectTemplate, buildUrl, originOf, templatePlaceholders, titleWords, ID_PLACEHOLDERS, PLACEHOLDERS } from "./template";

export const DIRECT_METHODS = Object.freeze(["GET", "POST"]);
export const EXTRACT_TYPES = Object.freeze(["path", "regex"]);
/** Request headers worth keeping (Cookie / auth headers never are). */
const KEEP_HEADERS = new Set(["accept", "content-type", "x-requested-with", "referer", "origin", "user-agent"]);
/** Request headers that mean the API wants a session or a signature. */
const AUTH_HEADER = /^(authorization|cookie|x-(csrf|xsrf|auth|token|access|api-?key|signature|sign|hash|vrf)[\w-]*)$/i;
/** Query keys / body fields that carry a signature or a session. */
const SIGNED_KEY = /^(token|_?sig|signature|sign|hash|vrf|key|auth|access_token|expires|exp|nonce|verify|h|t|_)$/i;
/** A value long and random enough to be a token, not a title id. */
const TOKEN_VALUE = /^[A-Za-z0-9+/=_-]{24,}$/;
/** Longest response text kept or scanned. */
export const MAX_TEXT = 512 * 1024;
const MAX_PATH_DEPTH = 8;
/** At most this many endpoints from scripts are tried. */
export const MAX_SCRIPT_CANDIDATES = 24;
const STREAM_RE = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi;
/** Default pattern for regex extraction: the first HLS / MP4 link in the answer. */
export const DEFAULT_STREAM_PATTERN = "https?://[^\\s\"'<>\\\\]+?\\.(?:m3u8|mp4)(?:\\?[^\\s\"'<>\\\\]*)?";
// Script addresses that are never a site's stream API.
const LIBRARY_SCRIPT = /(jquery|hls(\.min)?\.js|jwplayer|video(\.min)?\.js|plyr|artplayer|gtag|analytics|googletag|recaptcha|cloudflare|cdn-cgi|sentry|bootstrap|fontawesome|disqus|adsbygoogle|histats|popads|clappr|dash\.all)/i;
// Words in a script string that make it look like a stream API address.
const API_HINT = /\/api\/|\/apis?\b|\/sources?\b|\/stream|\/play(er)?\/|\/embed\/|\/ajax\/|\/get|\/links?\b|\.json\b|\/v\d\/|\/episode|\/movie|\/tv\//i;

// ── Small helpers ─────────────────────────────────────────────────────────

/** Unescape text the way JSON / JS strings carry URLs ("https:\/\/…", "\u0026"). */
export const unescapeText = (t) =>
  String(t || "")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/&amp;/g, "&");

const parseJson = (t) => {
  if (typeof t !== "string") return t && typeof t === "object" ? t : null;
  const s = t.trim();
  if (!/^[[{]/.test(s)) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null; // not JSON: the caller falls back to text matching
  }
};

const urlOrNull = (u, base) => {
  try {
    return new URL(u, base);
  } catch {
    return null;
  }
};

/** Same stream: equal, or the same file path (tokens in the query may differ). */
export function sameStream(a, b) {
  if (!a || !b) return false;
  const x = urlOrNull(unescapeText(a), "https://x.invalid/");
  const y = urlOrNull(unescapeText(b), "https://x.invalid/");
  if (!x || !y) return false;
  if (x.href === y.href) return true;
  return x.pathname.length > 8 && x.pathname === y.pathname;
}

/** Every HLS / MP4 link written in a text. */
export const streamUrlsIn = (text) => [...new Set(unescapeText(text).match(STREAM_RE) || [])];

/** Keep only harmless request headers (never Cookie or auth). */
export function safeHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (KEEP_HEADERS.has(k.toLowerCase()) && typeof v === "string" && v) out[k] = v;
  }
  return out;
}

/** Referer / Origin for a request made by a page (its origin, never the full address). */
export function pageHeaders(page, userAgent = null) {
  const o = originOf(page);
  const h = {};
  if (o) {
    h.Referer = `${o}/`;
    h.Origin = o;
  }
  if (userAgent) h["User-Agent"] = userAgent;
  return h;
}

// ── Response paths ────────────────────────────────────────────────────────

/** "data.sources.0.file" -> ["data","sources",0,"file"]. */
export const splitPath = (path) =>
  String(path || "")
    .split(".")
    .filter((p) => p !== "")
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p));

/** The value at a dot / index path, or undefined. */
export function getPath(obj, path) {
  let cur = obj;
  for (const k of splitPath(path)) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Path to the first string in `obj` for which `test(value)` holds, or null. */
export function findPath(obj, test, path = [], depth = 0) {
  if (depth > MAX_PATH_DEPTH || obj == null) return null;
  if (typeof obj === "string") return test(obj) ? path.join(".") : null;
  if (typeof obj !== "object") return null;
  for (const [k, v] of Array.isArray(obj) ? obj.map((v, i) => [i, v]) : Object.entries(obj)) {
    const hit = findPath(v, test, [...path, k], depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * How to read the stream out of an answer: a JSON path when the answer is
 * JSON, else a regex. `want` is the stream the page played (null: any).
 * @returns {{ type: "path", path } | { type: "regex", pattern } | null}
 */
export function extractorFor(text, want = null) {
  const json = parseJson(text);
  const isStream = (s) => (want ? sameStream(s, want) || sameStream(s.replace(/^\/\//, "https://"), want) : streamUrlsIn(s).length > 0 && /^(https?:)?\/\//.test(s.trim()));
  if (json) {
    const path = findPath(json, isStream);
    if (path !== null) return { type: "path", path };
  }
  const found = streamUrlsIn(text);
  if (want ? found.some((u) => sameStream(u, want)) : found.length) return { type: "regex", pattern: DEFAULT_STREAM_PATTERN };
  return null;
}

/**
 * The stream in an answer, absolute, or null.
 * @param {string} text the answer
 * @param {{type, path?, pattern?}} extract
 * @param {string} base the API address (for relative links)
 */
export function extractStream(text, extract, base) {
  if (!extract) return null;
  let raw = null;
  if (extract.type === "path") {
    const v = getPath(parseJson(text), extract.path);
    raw = typeof v === "string" ? v : null;
  } else if (extract.type === "regex") {
    let re;
    try {
      re = new RegExp(extract.pattern || DEFAULT_STREAM_PATTERN, "i");
    } catch {
      return null; // a broken hand-written pattern finds nothing
    }
    const m = re.exec(unescapeText(text));
    raw = m ? m[1] || m[0] : null;
  }
  if (!raw) return null;
  const u = urlOrNull(unescapeText(raw).trim(), base);
  return u && /^https?:$/.test(u.protocol) ? u.href : null;
}

/** At most this many streams from one answer are tried (the extracted one first). */
export const MAX_STREAMS = 4;
/** Per-stream headers an API may name for its CDN (never Cookie or auth). */
const STREAM_HEADER = new Set(["referer", "origin", "user-agent"]);

/** The Referer / Origin / User-Agent an API answer gives one stream. */
function streamHeadersOf(entry) {
  const out = {};
  const h = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.headers : null;
  for (const [k, v] of Object.entries(h && typeof h === "object" ? h : {})) {
    if (STREAM_HEADER.has(k.toLowerCase()) && typeof v === "string" && v) out[k] = v;
  }
  return out;
}

/**
 * Every stream an answer offers for the title, the extracted one first, each
 * with the headers the answer names for it. A path into a list
 * ("streams.0.url") also yields the list's other entries in the API's order
 * (fmfau: a 2160p rendition its CDN has removed, then a working 1080p one).
 * @returns {Array<{ url: string, headers: object }>}
 */
export function extractStreams(text, extract, base) {
  const first = extractStream(text, extract, base);
  if (!first) return [];
  if (extract.type !== "path") return [{ url: first, headers: {} }];
  const json = parseJson(text);
  const parts = splitPath(extract.path);
  const at = parts.findLastIndex((p) => typeof p === "number");
  if (at < 0) return [{ url: first, headers: streamHeadersOf(getPath(json, parts.slice(0, -1).join("."))) }];
  const list = getPath(json, parts.slice(0, at).join("."));
  if (!Array.isArray(list)) return [{ url: first, headers: {} }];
  const rest = parts.slice(at + 1).join(".");
  const order = [parts[at], ...list.keys()].filter((i, n, a) => a.indexOf(i) === n);
  const out = [];
  for (const i of order) {
    const entry = list[i];
    const raw = rest ? getPath(entry, rest) : entry;
    const u = typeof raw === "string" ? urlOrNull(unescapeText(raw).trim(), base) : null;
    if (!u || !/^https?:$/.test(u.protocol) || out.some((x) => x.url === u.href)) continue;
    // The headers sit on the list entry (or on the object holding the link).
    const holder = rest.includes(".") ? getPath(entry, rest.split(".").slice(0, -1).join(".")) : entry;
    out.push({ url: u.href, headers: { ...streamHeadersOf(entry), ...streamHeadersOf(holder) } });
    if (out.length >= MAX_STREAMS) break;
  }
  return out;
}

// ── Request templates ─────────────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Put placeholders into a request body for the title's values: JSON fields
 * whose value is an id / season / episode, or form fields.
 */
export function templatizeBody(body, values, kind) {
  if (body == null || body === "") return null;
  let out = String(body);
  // Ids anywhere; season / episode only under a key that names them (they are small numbers).
  const subs = [
    ["imdb", values.imdb, "[\\w-]+"],
    ["tmdb", values.tmdb, "[\\w-]+"],
    ["anilist", values.anilist, "[\\w-]+"],
    ["mal", values.mal, "[\\w-]+"],
    ...(kind !== "movie"
      ? [
          ["season", values.season, "(?:season|seasons|season_number|ss|s)"],
          ["episode", values.episode, "(?:episode|episodes|episode_number|ep|eps|e)"],
        ]
      : []),
    ["year", values.year, "(?:year|release_year|y)"],
  ].filter(([, v]) => v != null && v !== "");
  for (const [ph, v, key] of subs) {
    const val = escapeRe(String(v));
    // "key":"27205" | "key":27205 | key=27205
    out = out.replace(new RegExp(`((?:"${key}"\\s*:\\s*"?)|(?:(?:^|[?&])${key}=))${val}(?![\\w])`, "gi"), `$1{${ph}}`);
  }
  if (values.title) out = out.split(JSON.stringify(values.title).slice(1, -1)).join("{title}");
  return out;
}

/** Whether a request carries a signature or a session that can't be replayed. */
export function signedReason(req) {
  for (const k of Object.keys(req.headers || {})) {
    if (AUTH_HEADER.test(k)) return `The site's API needs a ${k} header (a session or signature).`;
  }
  const u = urlOrNull(req.url);
  const fields = [];
  if (u) u.searchParams.forEach((v, k) => fields.push([k, v]));
  const body = parseJson(req.body);
  if (body && typeof body === "object" && !Array.isArray(body)) for (const [k, v] of Object.entries(body)) fields.push([k, String(v)]);
  for (const [k, v] of fields) {
    if (SIGNED_KEY.test(k) && v.length >= 8) return `The site signs its API requests (${k}=…).`;
    if (TOKEN_VALUE.test(v) && !/^tt\d+$/.test(v)) return `The site's API link carries a token (${k}).`;
  }
  if (u && u.pathname.split("/").some((seg) => TOKEN_VALUE.test(seg) && !/[-_]{2}/.test(seg) && /\d/.test(seg) && /[a-z]/i.test(seg))) {
    return "The site's API link carries a token in its path.";
  }
  return null;
}

/** Whether an answer looks encrypted (one long random-looking blob, no links). */
export function looksEncrypted(text) {
  const t = String(text || "").trim();
  if (t.length < 120 || streamUrlsIn(t).length) return false;
  const json = parseJson(t);
  const blobs = json ? collectStrings(json).filter((s) => s.length >= 120) : [t];
  return blobs.some((s) => /^[A-Za-z0-9+/=_-]+$/.test(s) && entropy(s) > 4.5);
}

function collectStrings(obj, out = [], depth = 0) {
  if (depth > MAX_PATH_DEPTH || obj == null) return out;
  if (typeof obj === "string") out.push(obj);
  else if (typeof obj === "object") for (const v of Object.values(obj)) collectStrings(v, out, depth + 1);
  return out;
}

function entropy(s) {
  const n = {};
  for (const c of s) n[c] = (n[c] || 0) + 1;
  return Object.values(n).reduce((h, k) => h - (k / s.length) * Math.log2(k / s.length), 0);
}

/**
 * A request the page made, as a reusable template, or { error }.
 * @param {{url, method?, headers?, body?, page?}} req
 * @param {object} values the title's values the page was opened with
 * @param {"movie"|"tv"|"anime"} kind
 */
export function templatizeRequest(req, values, kind) {
  const ids = { tmdb: values.tmdb, imdb: values.imdb, anilist: values.anilist, mal: values.mal };
  const d = detectTemplate(req.url, { kind, ids, title: values.title, year: values.year });
  const url = d.template;
  if (!url) return { error: "The API address couldn't be read." };
  const body = templatizeBody(req.body, values, kind);
  const used = [...templatePlaceholders(url), ...templatePlaceholders(body || "")];
  if (!used.some((p) => ID_PLACEHOLDERS.includes(p))) return { error: "The API call doesn't carry the title's id." };
  if (kind === "tv" && !used.includes("episode")) return { error: "The API call doesn't carry the episode." };
  return {
    url,
    method: DIRECT_METHODS.includes(String(req.method || "GET").toUpperCase()) ? String(req.method || "GET").toUpperCase() : "GET",
    body,
    headers: { ...safeHeaders(req.headers), ...pageHeaders(req.page || req.url) },
    slugStyle: d.slugStyle || null,
  };
}

/** Fill a request template for a title: { url, method, headers, body } or null. */
export function buildDirectRequest(def, values) {
  if (!def?.url) return null;
  const url = buildOptional(def.url, values);
  if (!url) return null;
  let body = null;
  if (def.body) {
    let missing = false;
    body = def.body.replace(/\{([a-z]+)\}/g, (all, ph) => {
      const v = ph === "title" ? values.title : ph === "season" || ph === "episode" ? values[ph] ?? 1 : values[ph];
      if (v == null || v === "") {
        missing = true;
        return all;
      }
      return ph === "title" ? JSON.stringify(String(v)).slice(1, -1) : String(v);
    });
    if (missing) return null;
  }
  return { url, method: def.method || "GET", headers: { ...(def.headers || {}) }, body };
}

/** Problems with a hand-written direct definition, or null. */
export function validateDirect(def) {
  if (!def?.url) return "Add the API address.";
  if (!originOf(def.url.replace(/\{[a-z]+\}/g, "1"))) return "The API address must start with http:// or https://";
  const used = [...templatePlaceholders(def.url), ...templatePlaceholders(def.body || "")];
  const unknown = used.filter((p) => !PLACEHOLDERS.includes(p));
  if (unknown.length) return `Unknown placeholder {${unknown[0]}}`;
  if (!used.some((p) => ID_PLACEHOLDERS.includes(p))) return "The API address or body needs {tmdb}, {imdb}, {anilist}, {mal}, {title} or {slug}";
  if (!EXTRACT_TYPES.includes(def.extract?.type)) return "Pick how to find the stream: a path or a regex.";
  if (def.extract.type === "path" && !def.extract.path) return "Add the path to the stream, like data.sources.0.file";
  if (def.extract.type === "regex") {
    try {
      new RegExp(def.extract.pattern || DEFAULT_STREAM_PATTERN);
    } catch (e) {
      return `The regex doesn't work: ${e.message}`;
    }
  }
  return null;
}

/** "Name: value" lines -> headers object (manual fields). */
export function parseHeaderLines(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export const headerLines = (h) =>
  Object.entries(h || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

// ── Learning from what the page did ──────────────────────────────────────

/** Whether a URL looks like a page asset rather than an API answer. */
const ASSET = /\.(js|css|png|jpe?g|gif|webp|svg|woff2?|ttf|ico|m3u8|mp4|ts|m4s|vtt|srt)(\?|$)/i;

/**
 * Find the API request that gave the page its stream.
 * @param {{ requests: Array<{url, method, headers, body, status, contentType, text, page}> }} log
 * @param {{ stream: string|null, values: object, kind: string }} opts
 * @returns {{ ok: true, def, matched: "stream"|"list" } | { ok: false, reason, encrypted?: boolean, signed?: boolean }}
 */
export function learnFromLog(log, { stream = null, values, kind }) {
  const reqs = (log?.requests || []).filter((r) => r && r.url && /^https?:/i.test(r.url) && !ASSET.test(r.url) && r.status >= 200 && r.status < 300 && r.text);
  let signed = null;
  let encrypted = false;
  let lastError = null;
  const tryOne = (r, want) => {
    const extract = extractorFor(String(r.text).slice(0, MAX_TEXT), want);
    if (!extract) return null;
    const why = signedReason(r);
    if (why) {
      signed = signed || why;
      return null;
    }
    const t = templatizeRequest(r, values, kind);
    if (t.error) {
      lastError = t.error;
      return null;
    }
    const server = apiServersFrom(r, reqs, reqs.map((x) => x.text));
    return { ...t, extract, ...(server ? { server } : {}) };
  };
  // 1. An answer that holds the very stream the page played.
  if (stream) {
    for (const r of reqs) {
      const def = tryOne(r, stream);
      if (def) return { ok: true, def, matched: "stream" };
    }
  }
  // 2. An answer with a list of streams (the page picked one of them).
  for (const r of reqs) {
    const def = tryOne(r, null);
    if (def) return { ok: true, def, matched: "list" };
  }
  for (const r of reqs) if (looksEncrypted(r.text)) encrypted = true;
  if (signed) return { ok: false, signed: true, reason: signed };
  if (encrypted) return { ok: false, encrypted: true, reason: "The site encrypts its API answers, so the stream can't be read without the page." };
  return { ok: false, reason: lastError || (reqs.length ? "None of the page's API answers held the stream." : "The page made no API calls (the stream is built in the page).") };
}

// ── Endpoints written in scripts ─────────────────────────────────────────

/** Whether a script address is worth scanning (not a known library or ad script). */
export const scanWorthy = (url) => !!url && /^https?:/i.test(url) && !LIBRARY_SCRIPT.test(url);

const HOLE = "\u0000";

/** A JS expression joined with "+" after a literal: identifier, call or number. */
const CONCAT_HOLE = /^\s*\+\s*(?:[A-Za-z_$][\w$]*(?:\.[\w$]+|\[[^\]]{1,20}\]|\([^()]{0,30}\))*|\d+)/;
const CONCAT_LIT = /^\s*\+\s*(["'])((?:(?!\1)[^\\\n]){0,80})\1/;

/**
 * The arguments of a call whose "(" was just read: split at top-level
 * commas, quotes and brackets respected. Returns { list, length } where
 * length includes the closing ")", or null when it doesn't close soon.
 */
function concatArgs(text) {
  const list = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (let i = 0; i < Math.min(text.length, 300); i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === "\\") cur += text[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) {
        if (cur.trim()) list.push(cur);
        return { list, length: i + 1 };
      }
      depth--;
    } else if (c === "," && depth === 0) {
      list.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  return null;
}

/**
 * API addresses a script builds: template literals ("/api/tv/${id}/${s}"),
 * string concatenation ("/api/tv/" + id + "/" + s, "/api/tv/".concat(id))
 * and bare paths ending in
 * "/" or "=". Holes are marked with \0, in order.
 * @returns {string[]} patterns like "/api/source/\0/\0/\0"
 */
export function scanEndpoints(text) {
  const src = String(text || "").slice(0, MAX_TEXT * 4);
  const out = new Set();
  for (const m of src.matchAll(/`([^`\n]{3,200})`/g)) {
    const raw = m[1];
    if (!raw.includes("${") || !API_HINT.test(raw.replace(/\$\{[^}]*\}/g, "1"))) continue;
    out.add(raw.replace(/\$\{[^}]*\}/g, HOLE));
  }
  for (const m of src.matchAll(/(["'])((?:https?:)?\/[^"'\s\\]{1,150})\1/g)) {
    const lit = m[2];
    if (!API_HINT.test(lit)) continue;
    let rest = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
    let pattern = lit;
    let holes = 0;
    for (let i = 0; i < 8; i++) {
      // "lit".concat(a, "/b/", c): bundlers write string joins this way.
      const call = /^\.concat\(/.exec(rest);
      if (call) {
        const args = concatArgs(rest.slice(call[0].length));
        if (!args) break;
        for (const a of args.list) {
          const lit = /^\s*(["'])((?:(?!\1)[^\\\n]){0,80})\1\s*$/.exec(a);
          if (lit) pattern += lit[2];
          else {
            pattern += HOLE;
            holes++;
          }
        }
        rest = rest.slice(call[0].length + args.length);
        continue;
      }
      const l = CONCAT_LIT.exec(rest);
      if (l) {
        pattern += l[2];
        rest = rest.slice(l[0].length);
        continue;
      }
      const h = CONCAT_HOLE.exec(rest);
      if (h) {
        pattern += HOLE;
        holes++;
        rest = rest.slice(h[0].length);
        continue;
      }
      break;
    }
    if (holes) out.add(pattern);
    else if (/[/=]$/.test(lit)) out.add(lit + HOLE);
  }
  return [...out].filter((p) => p.includes(HOLE) && p.split(HOLE).length - 1 <= 4);
}

/** Placeholder lists to try in a pattern's holes, best guess first. */
function holeFills(n, kind, values) {
  const ids = kind === "anime" ? ["anilist", "mal"] : ["tmdb", "imdb"];
  const have = ids.filter((p) => values[p] != null && values[p] !== "");
  const fills = [];
  for (const id of have) {
    if (kind === "movie") {
      if (n === 1) fills.push([id]);
      if (n === 2) fills.push(["@type", id]);
    } else if (kind === "tv") {
      if (n === 3) fills.push([id, "season", "episode"]);
      if (n === 4) fills.push(["@type", id, "season", "episode"]);
      if (n === 1) fills.push([id]);
    } else {
      if (n === 2) fills.push([id, "episode"]);
      if (n === 3) fills.push([id, "episode", "lang"]);
      if (n === 1) fills.push([id]);
    }
  }
  return fills;
}

/**
 * Templates to try from script patterns, absolute, filled for this kind.
 * @param {string[]} patterns from scanEndpoints
 * @param {string[]} bases origins the page and its frames ran on
 */
export function endpointCandidates(patterns, bases, kind, values) {
  const typeWord = kind === "movie" ? "movie" : "tv";
  const out = [];
  const seen = new Set();
  for (const p of patterns) {
    const n = p.split(HOLE).length - 1;
    // A pattern naming the other kind is not this kind's API.
    if (kind === "movie" && /\/(tv|series|episodes?)\b/i.test(p)) continue;
    if (kind !== "movie" && /\/(movies?|films?)\b/i.test(p)) continue;
    for (const fill of holeFills(n, kind, values)) {
      let i = 0;
      const tpl = p.replace(new RegExp(HOLE, "g"), () => {
        const ph = fill[i++];
        return ph === "@type" ? typeWord : `{${ph}}`;
      });
      const roots = /^https?:/i.test(tpl) ? [""] : tpl.startsWith("//") ? ["https:"] : bases;
      for (const root of roots) {
        const full = root + tpl;
        if (!originOf(full.replace(/\{[a-z]+\}/g, "1")) || seen.has(full)) continue;
        seen.add(full);
        out.push(full);
        if (out.length >= MAX_SCRIPT_CANDIDATES) return out;
      }
    }
  }
  return out;
}

// ── Title checks ─────────────────────────────────────────────────────────

const GENERIC = new Set(["watch", "online", "free", "full", "movie", "movies", "hd", "stream", "streaming", "player", "embed", "video", "episode", "season", "series", "tv", "show", "sub", "dub", "english", "eng", "the", "a", "of", "and", "in", "on", "s", "e", "ep", "home", "page", "loading", "just", "moment", "error", "not", "found"]);

/**
 * Whether a page / API title is about the title we asked for.
 * @param {string} found a page title or an API answer's title
 * @param {{ title: string, altTitles?: string[], year?: number }} want TMDB's title
 * @param {string[]} siteWords words of the site's own name (ignored)
 * @returns {"match"|"mismatch"|"unknown"}
 */
export function checkTitle(found, want, siteWords = []) {
  const ignore = new Set([...GENERIC, ...siteWords.flatMap((w) => titleWords(w))]);
  const words = titleWords(found).filter((w) => !ignore.has(w) && !/^\d+$/.test(w));
  if (words.length < 1) return "unknown";
  const names = [want.title, ...(want.altTitles || [])].filter(Boolean);
  const best = Math.max(
    0,
    ...names.map((n) => {
      const t = titleWords(n).filter((w) => !ignore.has(w));
      if (!t.length) return 0;
      const have = new Set(words);
      return t.filter((w) => have.has(w)).length / t.length;
    }),
  );
  if (best >= 0.75) return "match";
  // Only a couple of leftover words (site slogans, a tag): can't tell.
  if (words.length < 2) return "unknown";
  return best <= 0.34 ? "mismatch" : "unknown";
}

const TITLE_KEYS = ["title", "name", "original_title", "originalTitle", "original_name", "movie_title", "show_title"];
const TMDB_KEYS = ["tmdb", "tmdb_id", "tmdbId", "tmdbid"];
const IMDB_KEYS = ["imdb", "imdb_id", "imdbId", "imdbid"];

/** First value of any of `keys` in the top two levels of an object. */
function shallowFind(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) if (obj[k] != null && typeof obj[k] !== "object") return obj[k];
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const k of keys) if (v[k] != null && typeof v[k] !== "object") return v[k];
    }
  }
  return null;
}

/**
 * Whether a direct API answer is about the title asked for: its ids first,
 * then its title. Answers without either are "unknown" (and played).
 */
export function checkAnswer(text, want) {
  const json = parseJson(text);
  if (!json || typeof json !== "object") return "unknown";
  const tmdb = shallowFind(json, TMDB_KEYS);
  if (tmdb != null && want.tmdb != null && /^\d+$/.test(String(tmdb))) return String(tmdb) === String(want.tmdb) ? "match" : "mismatch";
  const imdb = shallowFind(json, IMDB_KEYS);
  if (imdb != null && want.imdb && /^tt\d+$/.test(String(imdb))) return String(imdb) === String(want.imdb) ? "match" : "mismatch";
  const title = shallowFind(json, TITLE_KEYS);
  // A title field on an episode answer is often the episode's name: only movies are checked by title.
  if (typeof title === "string" && want.title && want.kind === "movie") return checkTitle(title, want);
  return "unknown";
}

// ── Recipes that work for every title ────────────────────────────────────
// A learned API call is saved once and reused for all shows and movies:
//  - apiServersFrom: the API's own servers (?sub=vortex, ?server=…), each
//    its own Sources entry (directServerVariant builds that server's call)
//  - deriveDirect: the movie call turned into the TV call (and back) when the
//    API names the kind (?mediaType=movie, /movie/{tmdb})
//  - buildDirectRequest drops optional query fields a title has no value for
//    ({imdb}, {year}, {title}) as long as an id is still sent

/** Query keys / body fields that pick one of the API's servers. */
const SERVER_KEY = /^(sub|server|srv|servername|server_name|provider|source|src|host|mirror|embed)$/i;
/** Query keys / body fields that name the kind of title. */
const MEDIA_KEY = /^(media_?type|mediatype|type|kind|content_?type|category)$/i;
/** A value that looks like a server name, not an id, a language or a placeholder. */
const SERVER_VALUE = /^(?=.*[a-z])[a-z0-9][\w.-]{1,31}$/i;
const NOT_SERVER = /^(sub|dub|raw|movie|tv|anime|true|false|on|off|auto|default|en|eng)$/i;
/** At most this many API servers become Sources entries. */
export const MAX_API_SERVERS = 8;

const queryPairs = (url) => {
  const q = String(url || "").split("#")[0].split("?")[1] || "";
  return q
    .split("&")
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      const dec = (s) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, " "));
        } catch {
          return s;
        }
      };
      return i < 0 ? [dec(p), ""] : [dec(p.slice(0, i)), dec(p.slice(i + 1))];
    });
};
const pathOf = (url) => String(url || "").split(/[?#]/)[0];

/** Names a server list item can carry (a string, or an object's name/id/key). */
function itemNames(x) {
  if (typeof x === "string") return [x];
  if (x && typeof x === "object") return ["value", "key", "id", "slug", "name", "server", "code"].map((k) => x[k]).filter((v) => typeof v === "string");
  return [];
}

/** Arrays in an answer that list the current server among others. */
function serverListsIn(obj, current, out = [], depth = 0) {
  if (depth > MAX_PATH_DEPTH || obj == null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    const names = obj.map((x) => itemNames(x));
    if (obj.length > 1 && names.some((n) => n.some((v) => v.toLowerCase() === current.toLowerCase()))) {
      const idx = names.flat().findIndex((v) => v.toLowerCase() === current.toLowerCase());
      // the field the current server matched (value/key/id/…) names every item
      const field = typeof obj[0] === "string" ? null : ["value", "key", "id", "slug", "name", "server", "code"].find((k) => obj.some((x) => String(x?.[k] ?? "").toLowerCase() === current.toLowerCase()));
      out.push(obj.map((x) => (typeof x === "string" ? x : field ? x?.[field] : itemNames(x)[0])).filter((v) => typeof v === "string"));
      if (idx < 0) out.pop();
    }
    for (const x of obj) serverListsIn(x, current, out, depth + 1);
  } else for (const v of Object.values(obj)) serverListsIn(v, current, out, depth + 1);
  return out;
}

/**
 * The API's own servers for a learned call: the query key that picks one,
 * the server the page used and every server the API offers (from other calls
 * the page made to the same address, or a list in an answer), or null.
 * @param {{url}} req the call that gave the stream
 * @param {Array<{url, text?}>} others the page's other calls
 * @param {string[]} texts answers to look in for a server list
 */
export function apiServersFrom(req, others = [], texts = []) {
  const body = parseJson(req?.body);
  const bodyPairs = body && typeof body === "object" && !Array.isArray(body) ? Object.entries(body).filter(([, v]) => typeof v === "string") : [];
  const pairs = [...queryPairs(req?.url), ...bodyPairs.map(([k, v]) => [k, v, "body"])];
  const hit = pairs.find(([k, v]) => SERVER_KEY.test(k) && SERVER_VALUE.test(v) && !NOT_SERVER.test(v) && !/^\d+$/.test(v));
  if (!hit) return null;
  const [param, current, where] = hit;
  const seen = new Map([[current.toLowerCase(), current]]);
  const add = (v) => {
    if (typeof v === "string" && SERVER_VALUE.test(v) && !NOT_SERVER.test(v) && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  };
  for (const o of others) {
    if (!o?.url || pathOf(o.url) !== pathOf(req.url)) continue;
    for (const [k, v] of queryPairs(o.url)) if (k === param) add(v);
    const ob = parseJson(o.body);
    if (where && ob && typeof ob[param] === "string") add(ob[param]);
  }
  for (const t of texts) {
    const json = parseJson(String(t || "").slice(0, MAX_TEXT));
    if (json) for (const list of serverListsIn(json, current)) list.forEach(add);
  }
  return { param, current, list: [...seen.values()].slice(0, MAX_API_SERVERS), ...(where ? { in: "body" } : {}) };
}

const replaceParam = (url, param, value) =>
  String(url).replace(new RegExp(`([?&]${escapeRe(param)}=)[^&#]*`), (_, pre) => pre + encodeURIComponent(value));

/** A direct definition with another of the API's servers picked, or null. */
export function directServerVariant(def, value) {
  if (!def?.url || !def.server?.param || value == null) return null;
  const same = String(value).toLowerCase() === String(def.server.current).toLowerCase();
  if (def.server.in === "body") {
    const re = new RegExp(`("${escapeRe(def.server.param)}"\\s*:\\s*")${escapeRe(def.server.current)}(")`);
    const body = String(def.body || "").replace(re, (_, a, b) => a + JSON.stringify(String(value)).slice(1, -1) + b);
    if (body === def.body && !same) return null;
    return { ...def, body, server: { ...def.server, current: String(value) } };
  }
  const url = replaceParam(def.url, def.server.param, value);
  if (url === def.url && !same) return null;
  return { ...def, url, server: { ...def.server, current: String(value) } };
}

/** Display name of an API server ("vortex" -> "Vortex"). */
export const apiServerLabel = (v) => String(v).replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The call for another kind of title from a learned one: the kind field
 * switched (mediaType=movie -> tv, /movie/{tmdb} -> /tv/{tmdb}) and the
 * season/episode added or dropped. Null when the API doesn't name the kind.
 */
export function deriveDirect(def, from, to) {
  if (!def?.url || from === to || !["movie", "tv"].includes(from) || !["movie", "tv"].includes(to)) return null;
  const word = { movie: "movie", tv: "tv" };
  let url = def.url;
  let switched = false;
  const [base, query = ""] = url.split("?");
  let path = base;
  let q = query;
  // ?mediaType=movie / &type=tv
  q = q.replace(/(^|&)([^=&]+)=([^&]*)/g, (all, pre, k, v) => {
    if (MEDIA_KEY.test(decodeURIComponent(k)) && v.toLowerCase() === word[from]) {
      switched = true;
      return `${pre}${k}=${word[to]}`;
    }
    return all;
  });
  // a JSON body's {"type":"movie"}
  let body = def.body;
  if (!switched && body) {
    const b2 = body.replace(/"([A-Za-z_]+)"(\s*:\s*)"([A-Za-z]+)"/g, (all, k, sep, v) => (MEDIA_KEY.test(k) && v.toLowerCase() === word[from] ? `"${k}"${sep}"${word[to]}"` : all));
    if (b2 !== body) {
      body = b2;
      switched = "body";
    }
  }
  // /movie/{tmdb} <-> /tv/{tmdb}/{season}/{episode}
  if (!switched) {
    const re = from === "movie" ? /\/movies?\/(\{(?:tmdb|imdb)\})(?![^/]*\{)/ : /\/tv\/(\{(?:tmdb|imdb)\})\/\{season\}\/\{episode\}/;
    if (re.test(path)) {
      path = path.replace(re, to === "tv" ? "/tv/$1/{season}/{episode}" : "/movie/$1");
      switched = "path";
    }
  }
  if (!switched) return null;
  if (switched === true) {
    if (to === "tv" && !/\{episode\}/.test(path + q)) q += `${q ? "&" : ""}season={season}&episode={episode}`;
    if (to === "movie") q = q.split("&").filter((p) => !/=\{(season|episode)\}$/.test(p)).join("&");
  }
  url = q ? `${path}?${q}` : path;
  if (switched === "body" && to === "movie") body = body.replace(/,\s*"(season|episode)"\s*:\s*\{(season|episode)\}/g, "");
  if (body && switched !== "path" && to === "tv" && !/\{episode\}/.test(body + url)) {
    if (/^\s*\{[\s\S]*\}\s*$/.test(body)) body = body.replace(/\}\s*$/, `,"season":{season},"episode":{episode}}`);
  }
  return { ...def, url, body, derived: from };
}

/** Fill a template, dropping query fields that are only extra facts ({imdb}, {year}, {title}) when the title has no value for them. */
function buildOptional(url, values) {
  const full = buildUrl(url, values);
  if (full) return full;
  const [base, query] = url.split("?");
  if (!query) return null;
  const OPTIONAL = new Set(["imdb", "year", "title", "slug", "tvdb", "kitsu", "mal"]);
  const kept = query.split("&").filter((p) => {
    const phs = templatePlaceholders(p);
    const missing = phs.filter((ph) => buildUrl(`{${ph}}`, values) == null);
    return !missing.length || !missing.every((ph) => OPTIONAL.has(ph));
  });
  const rest = `${base}${kept.length ? `?${kept.join("&")}` : ""}`;
  // still needs an id
  if (!templatePlaceholders(rest).some((p) => ID_PLACEHOLDERS.includes(p))) return null;
  return buildUrl(rest, values);
}

/** Arrays of names written in a script (["vortex","nebula"] or [{id:"vortex"},…]) as JSON texts, for apiServersFrom. */
export function jsonArraysIn(script) {
  const out = [];
  const re = /\[\s*(?:(?:"[\w.-]{2,32}"|'[\w.-]{2,32}')\s*,\s*){1,15}(?:"[\w.-]{2,32}"|'[\w.-]{2,32}')\s*,?\s*\]/g;
  for (const m of String(script || "").slice(0, MAX_TEXT * 4).matchAll(re)) out.push(m[0].replace(/'/g, '"').replace(/,\s*\]$/, "]"));
  // [{id:"vortex",name:"Vortex"},…] / [{value:'nova'}]: the name fields as a plain list
  const objRe = /\[\s*\{[^\[\]]{0,4000}\}\s*\]/g;
  for (const m of String(script || "").slice(0, MAX_TEXT * 4).matchAll(objRe)) {
    const names = [...m[0].matchAll(/["']?(?:id|key|value|slug|server|code|name)["']?\s*:\s*["']([\w.-]{2,32})["']/g)].map((x) => x[1]);
    if (names.length > 1) out.push(JSON.stringify(names));
  }
  return out;
}
