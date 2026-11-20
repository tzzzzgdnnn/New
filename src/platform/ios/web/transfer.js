// Safari → Home Screen data carry-over for the web build.
// iOS gives a Home Screen web app its own storage, separate from Safari's, so
// a fresh Home Screen copy would start empty. Before the user adds the app,
// the Safari page packs its localStorage (the app keeps everything there:
// profiles, history, resume points, lists, settings, custom servers, the
// secure-store fallback) into the page URL as #sp-import=<data>. With no
// manifest start_url, iOS saves the current URL, hash included, as the Home
// Screen app's start URL; its first launch unpacks and merges the data.
// localStorage is the source of truth (keepData's IndexedDB copy mirrors it).
// Saved logins and API keys never go into the URL: the Home Screen app asks
// for them again instead of carrying them in a link that can be shared.

export const IMPORT_HASH = "sp-import";
export const IMPORT_DONE_KEY = "sb_spImportDone";
export const SHEET_KEY = "sb_adblockSheet";

// Rebuildable caches and logs: left behind to keep the URL short.
const SKIP_EXACT = new Set([
  IMPORT_DONE_KEY,
  SHEET_KEY,
  "sb_nostalgia_cache_v1",
  "sb_diag_log",
  "sb_loadTimes",
  "streambert_serversCache",
  "streambert_aniskipCache",
  "streambert_anilistCache",
  "streambert_episodeGroupCache",
]);
const SKIP_PREFIX = ["sb_tmdb:", "streambert_profiles_corrupt_"];
const SKIP_SUFFIX = ["trendingCache", "episodeReleaseCache"];

// Credentials: the secure store (capacitor-storage_*: the web Keychain
// stand-in, and its streambert_secure_* fallback) holds the Wyzie / SubDL /
// TMDB keys and logins; plus anything named like a key, token or login.
const SECRET_PREFIXES = ["capacitor-storage_", "streambert_secure_"];
const SECRET_NAME = /api_?key|token|secret|passw|login|credential|cookie|bearer/i;
export const isSecretKey = (key) => SECRET_PREFIXES.some((p) => key.startsWith(p)) || SECRET_NAME.test(key);

export const shouldCarry = (key) =>
  !isSecretKey(key) &&
  !SKIP_EXACT.has(key) &&
  !SKIP_PREFIX.some((p) => key.startsWith(p)) &&
  !SKIP_SUFFIX.some((s) => key.endsWith(s));

// ── encoding ────────────────────────────────────────────────────────────────

function bytesToB64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64UrlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
const canGzip = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";

/** Pack a {key: string} map. "z." = gzip+base64url, "j." = plain base64url. */
export async function encodePayload(payload) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if (canGzip()) {
    try {
      return "z." + bytesToB64Url(await pipe(json, new CompressionStream("gzip")));
    } catch {}
  }
  return "j." + bytesToB64Url(json);
}

export async function decodePayload(data) {
  const kind = data.slice(0, 2);
  let bytes = b64UrlToBytes(data.slice(2));
  if (kind === "z.") bytes = await pipe(bytes, new DecompressionStream("gzip"));
  else if (kind !== "j.") throw new Error("unknown sp-import format");
  const payload = JSON.parse(new TextDecoder().decode(bytes));
  if (!payload || payload.v !== 1 || typeof payload.ls !== "object") throw new Error("bad sp-import payload");
  return payload;
}

/** Snapshot of everything worth carrying over. */
export function collectLocalStorage(ls = localStorage) {
  const out = {};
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k != null && shouldCarry(k)) out[k] = ls.getItem(k);
  }
  return out;
}

export async function buildPayload(ls = localStorage) {
  const data = collectLocalStorage(ls);
  const at = Date.now();
  return { v: 1, id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at, ls: data };
}

// ── merge (newest wins for history and resume data) ─────────────────────────

const parse = (s) => {
  try {
    return { ok: true, v: JSON.parse(s) };
  } catch {
    return { ok: false, v: s };
  }
};
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const stampOf = (v) => (isObj(v) ? Number(v.watchedAt ?? v.at ?? v.updatedAt ?? v.savedAt ?? v.addedAt) || 0 : 0);
const historyId = (h) => `${h.id}|${h.media_type}|${h.season ?? ""}|${h.episode ?? ""}`;
const listId = (x) => (isObj(x) && x.id != null ? `${x.id}|${x.media_type ?? ""}` : JSON.stringify(x));

function mergeArrays(local, incoming) {
  const timed = [...local, ...incoming].some((x) => isObj(x) && Number(x.watchedAt) > 0);
  if (timed) {
    // Watch history: one entry per title/episode, newest watchedAt kept, newest first.
    const map = new Map();
    for (const h of [...local, ...incoming]) {
      const id = isObj(h) ? historyId(h) : JSON.stringify(h);
      const prev = map.get(id);
      if (!prev || stampOf(h) >= stampOf(prev)) map.set(id, h);
    }
    const cap = Math.max(100, local.length, incoming.length);
    return [...map.values()].sort((a, b) => stampOf(b) - stampOf(a)).slice(0, cap);
  }
  // Lists (saved titles, profiles, servers, search history): union, Safari's order first.
  const seen = new Map();
  for (const x of incoming) seen.set(listId(x), x);
  for (const x of local) {
    const id = listId(x);
    const prev = seen.get(id);
    if (!prev) seen.set(id, x);
    else if (stampOf(x) > stampOf(prev)) seen.set(id, x);
  }
  return [...seen.values()];
}

function mergeObjects(local, incoming) {
  const ls = stampOf(local);
  const is = stampOf(incoming);
  if (ls || is) return ls > is ? local : incoming;
  const out = { ...local };
  for (const [k, v] of Object.entries(incoming)) {
    const prev = out[k];
    if (prev === undefined) out[k] = v;
    else if (isObj(prev) && isObj(v) && (stampOf(prev) || stampOf(v))) out[k] = stampOf(prev) > stampOf(v) ? prev : v;
    else out[k] = v; // progress %, watched flags, settings maps: Safari's copy is the one just used
  }
  return out;
}

/** Merge one stored string. Returns the string to store. */
export function mergeValue(key, localRaw, incomingRaw) {
  if (localRaw == null) return incomingRaw;
  if (incomingRaw == null) return localRaw;
  const a = parse(localRaw);
  const b = parse(incomingRaw);
  if (!a.ok || !b.ok) return incomingRaw;
  if (Array.isArray(a.v) && Array.isArray(b.v)) return JSON.stringify(mergeArrays(a.v, b.v));
  if (isObj(a.v) && isObj(b.v)) return JSON.stringify(mergeObjects(a.v, b.v));
  // Resume seconds (dlTime_*): the later spot wins when they differ.
  if (/(^|\.)dlTime_/.test(key) && typeof a.v === "number" && typeof b.v === "number") return JSON.stringify(Math.max(a.v, b.v));
  return incomingRaw;
}

/** Write a payload into storage, merging with whatever is there. */
export function applyPayload(payload, ls = localStorage) {
  let written = 0;
  let failed = 0;
  for (const [k, v] of Object.entries(payload.ls)) {
    if (!shouldCarry(k) || typeof v !== "string") continue;
    try {
      const next = mergeValue(k, ls.getItem(k), v);
      if (next !== ls.getItem(k)) ls.setItem(k, next);
      written++;
    } catch {
      failed++;
    }
  }
  return { written, failed };
}

// ── URL hash ────────────────────────────────────────────────────────────────

export function readImportHash(loc = location) {
  const m = /(?:^#|&)sp-import=([^&]+)/.exec(loc.hash || "");
  return m ? m[1] : null;
}

export function stripImportHash() {
  try {
    if (!readImportHash()) return;
    history.replaceState(history.state, "", location.pathname + location.search);
  } catch {}
}

/** Safari side: put the current data into the URL (#sp-import=...). */
export async function writeImportHash() {
  const data = await encodePayload(await buildPayload());
  history.replaceState(history.state, "", `${location.pathname}${location.search}#${IMPORT_HASH}=${data}`);
  return data.length;
}

/**
 * Home Screen side, before the app boots: import the carried data once, then
 * clean the URL. Never throws; the app boots either way.
 */
export async function importFromHash() {
  const data = readImportHash();
  if (!data) return { imported: false };
  try {
    const payload = await decodePayload(data);
    if (localStorage.getItem(IMPORT_DONE_KEY) === payload.id) return { imported: false, already: true };
    const res = applyPayload(payload);
    localStorage.setItem(IMPORT_DONE_KEY, payload.id);
    return { imported: true, ...res };
  } catch (e) {
    console.warn("[sp-import] failed", e);
    return { imported: false, error: String(e?.message || e) };
  } finally {
    stripImportHash();
  }
}
