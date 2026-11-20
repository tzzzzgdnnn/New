// Keeps room in localStorage for the viewer's own data (profiles, avatar,
// history, resume points, settings).
//
// WebKit (Safari, the home-screen web app and the iOS app's WKWebView) gives
// one site about 5 MB of localStorage. The app also keeps rebuildable caches
// there (TMDB responses, Nostalgia/Kids catalogs, the diagnostics log). Once
// those filled the quota every later setItem threw QuotaExceededError, so
// profile names, avatars, history, progress and settings silently stopped
// saving and came back old after a reload.
//
// This module (imported first by the iOS/web entry):
//  1) trims the caches at launch when they take more than their budget, and
//  2) wraps Storage.prototype.setItem so a write that hits the quota frees
//     cache space and is retried, instead of being lost. Cache writes never
//     evict anything themselves; they are simply dropped when full.
// Key names are unchanged, so nothing that reads them needs to change.

const CACHE_PREFIXES = ["sb_tmdb:", "dlDur_"];
const CACHE_KEYS = [
  "sb_nostalgia_cache_v1",
  "sb_kids_shows_v1",
  "sb_kids_cert_v1",
  "streambert_anilistCache",
  "streambert_episodeGroupCache",
  "streambert_aniskipCache",
];
const DIAG_KEY = "sb_diag_log";
/** Characters the caches together may use before launch trims them (~1.2 MB as UTF-16). */
const CACHE_BUDGET = 600 * 1024;
/** Longest diagnostics mirror kept in localStorage (characters). */
const DIAG_MAX = 120 * 1024;

const isCacheKey = (k) =>
  typeof k === "string" && (CACHE_KEYS.includes(k) || CACHE_PREFIXES.some((p) => k.startsWith(p)));

let ls = null;
try {
  ls = globalThis.localStorage || null;
} catch {}

const rawSet = typeof Storage !== "undefined" ? Storage.prototype.setItem : null;
const isQuota = (e) =>
  !!e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22 || e.code === 1014);

function cacheEntries() {
  const out = [];
  if (!ls) return out;
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (isCacheKey(k)) out.push([k, (ls.getItem(k) || "").length]);
  }
  return out;
}

function trimDiag(max) {
  try {
    const v = ls.getItem(DIAG_KEY);
    if (v && v.length > max) {
      const cut = v.slice(v.length - max);
      const nl = cut.indexOf("\n");
      rawSet.call(ls, DIAG_KEY, nl >= 0 ? cut.slice(nl + 1) : cut);
    }
  } catch {
    try { ls.removeItem(DIAG_KEY); } catch {}
  }
}

/**
 * Free cache space. `all` drops every cache (used when a real write hit the
 * quota); otherwise the largest caches go until they fit CACHE_BUDGET.
 * @returns {number} characters freed
 */
export function freeCacheSpace(all = false) {
  if (!ls || !rawSet) return 0;
  let freed = 0;
  try {
    const entries = cacheEntries().sort((a, b) => b[1] - a[1]);
    let total = entries.reduce((s, [, n]) => s + n, 0);
    for (const [k, n] of entries) {
      if (!all && total <= CACHE_BUDGET) break;
      ls.removeItem(k);
      total -= n;
      freed += n;
    }
    const before = (ls.getItem(DIAG_KEY) || "").length;
    trimDiag(all ? Math.floor(DIAG_MAX / 4) : DIAG_MAX);
    freed += Math.max(0, before - (ls.getItem(DIAG_KEY) || "").length);
  } catch {}
  return freed;
}

let installed = false;
export function installStorageGuard() {
  if (installed || !ls || !rawSet) return;
  installed = true;
  freeCacheSpace(false);
  try {
    Storage.prototype.setItem = function guardedSetItem(key, value) {
      try {
        return rawSet.call(this, key, value);
      } catch (e) {
        // Only localStorage, only quota errors, never for a cache's own write.
        if (this !== ls || !isQuota(e) || isCacheKey(String(key)) || String(key) === DIAG_KEY) throw e;
        if (freeCacheSpace(true) <= 0) throw e;
        return rawSet.call(this, key, value);
      }
    };
  } catch {}
  try {
    navigator.storage?.persist?.().catch?.(() => {});
  } catch {}
}

installStorageGuard();
