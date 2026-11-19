// localStorage-based persistence (works in both Vite dev and prod)
import { getActiveProfileId, scopedKey } from "./profileScope";
import { diag } from "./diag";

// Failed saves (quota) and unreadable values are logged and announced
// ("sb-storage-error") so the app can tell the viewer, instead of the old
// silent catch {} that dropped progress/history writes without a trace.
let _lastStorageEvent = 0;
// The log names ordinary settings keys, but never the keys that hold
// credentials (API keys, tokens, PINs): those show as "a secure key".
const SENSITIVE_KEY = /key|token|secret|pass|pin|auth/i;
// Only names from a fixed list of plain settings keys are ever logged. The
// label is read from that list, never copied from the caller, so nothing a
// caller passes in (such as a credential key) can reach the log.
let _loggable = null;
function logLabel(key) {
  try {
    _loggable ||= Object.values(STORAGE_KEYS).filter((k) => typeof k === "string" && !SENSITIVE_KEY.test(k));
    const i = _loggable.indexOf(String(key ?? ""));
    return i >= 0 ? _loggable[i] : "a secure or unlisted key";
  } catch {
    return "a key";
  }
}
function reportStorageProblem(kind, key, err) {
  try {
    diag("storage", `${kind} ${logLabel(key)}: ${err?.name || ""}`);
    const now = Date.now();
    if (now - _lastStorageEvent < 2000) return;
    _lastStorageEvent = now;
    window.dispatchEvent(new CustomEvent("sb-storage-error", { detail: { kind, key } }));
  } catch {}
}

/** Raw stored string for a logical key (null when missing), for corruption checks. */
export function rawStored(key) {
  try {
    return localStorage.getItem(PREFIX + profileKey(key));
  } catch {
    return null;
  }
}

export const STORAGE_PREFIX = "streambert_";
const PREFIX = STORAGE_PREFIX;

export const storage = {
  get(key) {
    try {
      let raw = localStorage.getItem(PREFIX + profileKey(key));
      // Legacy AllManga → HiAnime migration (settings saved by older versions)
      if (!raw && key === "hianimeDubMode") {
        raw = localStorage.getItem(PREFIX + "allmangaDubMode");
      }
      let value = null;
      if (raw) {
        try {
          value = JSON.parse(raw);
        } catch (e) {
          reportStorageProblem("corrupt", key, e);
          return null;
        }
      }
      if (key === "playerSource" && value === "allmanga") return "hianime";
      return value;
    } catch {
      return null;
    }
  },
  /** Save a value. Returns false (and reports it) when the write failed. */
  set(key, value) {
    try {
      const json = JSON.stringify(value);
      localStorage.setItem(PREFIX + profileKey(key), json);
      if (isNativeMirrored(key)) localStorage.setItem(PREFIX + key, json);
      return true;
    } catch (e) {
      reportStorageProblem("save failed", key, e);
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(PREFIX + profileKey(key));
      if (isNativeMirrored(key)) localStorage.removeItem(PREFIX + key);
    } catch {}
  },
  // Remove all streambert_ keys (used by reset)
  clearAll() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(PREFIX))
        .forEach((k) => localStorage.removeItem(k));
    } catch {}
  },
};

// Centralised storage key registry
export const STORAGE_KEYS = {
  API_KEY: "apikey",
  UPDATE_SOURCE: "updateSource",
  PLAYER_SOURCE: "playerSource",
  HIANIME_DUB_MODE: "hianimeDubMode",
  // iOS: set once the viewer answered the "Sub or Dub?" prompt
  ANIME_DUB_CHOSEN: "animeDubChosen",
  WATCH_PROGRESS: "progress",
  WATCHED: "watched",
  HISTORY: "history",
  SAVED: "saved",
  SAVED_ORDER: "savedOrder",
  LOCAL_FILES: "localFiles",
  DOWNLOAD_PATH: "downloadPath",
  DOWNLOADER_FOLDER: "downloaderFolder",
  START_PAGE: "startPage",
  AGE_LIMIT: "ageLimit",
  RATING_COUNTRY: "ratingCountry",
  WATCHED_THRESHOLD: "watchedThreshold",
  HOME_ROW_ORDER: "homeRowOrder",
  HOME_ROW_VISIBLE: "homeRowVisible",
  HOME_VIEW_MODE: "homeViewMode",
  AUTO_CHECK_UPDATES: "autoCheckUpdates",
  INVIDIOUS_BASE: "invidiousBase",
  // Subtitle settings
  SUBTITLE_ENABLED: "subtitleDownload",
  SUBTITLE_LANG: "subtitleLang",
  // NOTE: SUBDL_API_KEY, WYZIE_API_KEY and API_KEY are stored encrypted via secureStorage
  SUBDL_API_KEY: "subdlApiKey",
  WYZIE_API_KEY: "wyzieApiKey",
  // Appearance & behaviour
  ACCENT_COLOR: "accentColor",
  ACCENT_IN_PLAYER: "accentInPlayer",
  THEME: "theme",
  CUSTOM_THEME_VARS: "customThemeVars",
  FONT_SIZE: "fontSize",
  COMPACT_MODE: "compactMode",
  REDUCE_ANIMATIONS: "reduceAnimations",
  LIBRARY_SORT: "librarySort",
  HISTORY_ENABLED: "historyEnabled",
  // Notification preferences
  NOTIFY_DOWNLOAD_COMPLETE: "notifyDownloadComplete",
  NOTIFY_NEW_EPISODE: "notifyNewEpisode",
  // TMDB metadata lang (BCP-47 locale, e.g. "de-DE")
  TMDB_LANG: "tmdbLang",
  // Intro skip (anime only, HiAnime source)
  // Values: "off" | "auto" | "manual"
  INTRO_SKIP_MODE: "introSkipMode",
  // Autoplay next preferences
  AUTOPLAY_NEXT_ENABLED: "autoplayNextEnabled",
  AUTOPLAY_NEXT_DURATION: "autoplayNextDuration",
  AUTOPLAY_NEXT_LAYOUT: "autoplayNextLayout",
  // Download page UI preferences
  DL_SORT_BY: "dlSortBy",
  DL_SORT_DIR: "dlSortDir",
  DL_SHOW_UNTRACKED: "dlShowUntracked",
  // Cache for new-episode startup check
  EPISODE_RELEASE_CACHE: "episodeReleaseCache",
  // Per-episode fallback source when the default (typically HiAnime) lacks
  // the title. Shape: { [epKey]: sourceId }.
  SOURCE_FAILOVER_CACHE: "sourceFailoverCache",
  // Discord Rich Presence
  DISCORD_RPC_ENABLED: "discordRpcEnabled",
  DISCORD_RPC_SHOW_COVER: "discordRpcShowCover",
  DISCORD_RPC_SHOW_TIMESTAMP: "discordRpcShowTimestamp",
  DISCORD_RPC_SHOW_BUTTON: "discordRpcShowButton",
  // Controller / gamepad navigation
  GAMEPAD_ENABLED: "gamepadEnabled",
  // Native iOS player, per profile
  PLAYER_QUALITY: "playerQuality",
  PLAYER_SUBS_ON: "playerSubsOn",
  PLAYER_SUB_SCALE: "playerSubScale",
  // iOS: false once the viewer picked a server by hand (Auto otherwise)
  SERVER_AUTO_PICK: "serverAutoPick",
};

// ── Profiles ──────────────────────────────────────────────────────────────────
// Per-person keys live under the active profile's namespace (iOS profiles).
// App-wide keys (TMDB token, servers, caches, appearance) stay global.

/** Per-person logical keys, stored once per profile. */
export const PROFILE_SCOPED_KEYS = new Set([
  STORAGE_KEYS.HISTORY,
  STORAGE_KEYS.WATCH_PROGRESS,
  STORAGE_KEYS.WATCHED,
  STORAGE_KEYS.SAVED,
  STORAGE_KEYS.SAVED_ORDER,
  STORAGE_KEYS.LIBRARY_SORT,
  STORAGE_KEYS.HISTORY_ENABLED,
  STORAGE_KEYS.HIANIME_DUB_MODE,
  STORAGE_KEYS.ANIME_DUB_CHOSEN,
  STORAGE_KEYS.SUBTITLE_ENABLED,
  STORAGE_KEYS.SUBTITLE_LANG,
  STORAGE_KEYS.INTRO_SKIP_MODE,
  STORAGE_KEYS.AUTOPLAY_NEXT_ENABLED,
  STORAGE_KEYS.AUTOPLAY_NEXT_DURATION,
  STORAGE_KEYS.AUTOPLAY_NEXT_LAYOUT,
  STORAGE_KEYS.WATCHED_THRESHOLD,
  STORAGE_KEYS.PLAYER_QUALITY,
  STORAGE_KEYS.PLAYER_SUBS_ON,
  STORAGE_KEYS.PLAYER_SUB_SCALE,
  // Server choice (Auto, or the server picked by hand) is per person.
  STORAGE_KEYS.PLAYER_SOURCE,
  STORAGE_KEYS.SERVER_AUTO_PICK,
  "serverPin",
  "searchHistory",
]);

/**
 * Per-person key prefixes: playback position ("dlTime_<progressKey>"),
 * runtime ("sbDur_") and last episode per series ("sbLastEp_"), see
 * platform/ios/resume.js.
 */
export const PROFILE_SCOPED_PREFIXES = ["dlTime_", "sbDur_", "sbLastEp_"];

/**
 * Per-person keys the native player glue reads straight from localStorage
 * under their global name (platform/ios/webview.js). Writes also refresh that
 * global copy, which always mirrors the active profile.
 */
export const NATIVE_MIRRORED_KEYS = new Set([STORAGE_KEYS.SUBTITLE_LANG, STORAGE_KEYS.PLAYER_SOURCE]);

/** Whether a logical key holds per-person data. */
export const isProfileScoped = (key) =>
  PROFILE_SCOPED_KEYS.has(key) ||
  PROFILE_SCOPED_PREFIXES.some((prefix) => key.startsWith(prefix));

const isNativeMirrored = (key) =>
  getActiveProfileId() !== null && NATIVE_MIRRORED_KEYS.has(key);

/**
 * Resolve a logical key to the key it is stored under: per-person keys get
 * the active profile's namespace, everything else is returned unchanged.
 * Every per-person read and write goes through here (via `storage`).
 * @param {string} key logical key, e.g. "history" or "dlTime_movie_550"
 * @returns {string}
 */
export function profileKey(key) {
  const id = getActiveProfileId();
  return id !== null && isProfileScoped(key) ? scopedKey(id, key) : key;
}

export const getApiKey = () => storage.get(STORAGE_KEYS.API_KEY);

// ── Source failover cache ────────────────────────────────────────────────────
// HiAnime doesn't always have every episode; rather than nag the user every
// time, remember the working alternate source per (tmdbId, season, ep, dub).
// Max 200 entries
const FAILOVER_CACHE_MAX = 200;

export const getFailoverSource = (epKey) => {
  const cache = storage.get(STORAGE_KEYS.SOURCE_FAILOVER_CACHE) || {};
  return cache[epKey]?.sourceId || null;
};

export const setFailoverSource = (epKey, sourceId) => {
  const cache = storage.get(STORAGE_KEYS.SOURCE_FAILOVER_CACHE) || {};
  // Evict oldest entries when at capacity (insertion order via Object.keys)
  const keys = Object.keys(cache);
  if (keys.length >= FAILOVER_CACHE_MAX) {
    const evict = keys.slice(0, keys.length - FAILOVER_CACHE_MAX + 1);
    evict.forEach((k) => delete cache[k]);
  }
  cache[epKey] = { sourceId, ts: Date.now() };
  storage.set(STORAGE_KEYS.SOURCE_FAILOVER_CACHE, cache);
};

export const clearFailoverSource = (epKey) => {
  const cache = storage.get(STORAGE_KEYS.SOURCE_FAILOVER_CACHE) || {};
  if (cache[epKey] !== undefined) {
    delete cache[epKey];
    storage.set(STORAGE_KEYS.SOURCE_FAILOVER_CACHE, cache);
  }
};

// ── Shared helpers ────────────────────────────────────────────────────────────

/** True when running inside Electron (contextBridge exposed). */
export const isElectron = typeof window !== "undefined" && !!window.electron;

/** Format a byte count into a human-readable string. */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "…";
  if (bytes === -1) return null; // unavailable
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

// ── Secure storage for sensitive keys ────────────────────────────────────────
// Uses Electron safeStorage (OS keychain / DPAPI / libsecret).
// All methods are async. Non-Electron environments silently fall back to no-op.
//
// Sensitive keys managed here (NOT stored in localStorage):
//   "apikey"      - TMDB API key
//   "subdlApiKey" - SubDL API key
//   "wyzieApiKey" - Wyzie API key

// Checked on each call, not at module load, so the iOS shim (which installs
// window.electron) can never be missed by import order.
const _isSecureAvailable = () =>
  typeof window !== "undefined" && !!window.electron?.secureGet;

export const secureStorage = {
  /** Read an encrypted value. Returns null if not set. */
  async get(key) {
    if (!_isSecureAvailable()) return null;
    return window.electron.secureGet(key);
  },

  /** Write an encrypted value. Pass null/empty to delete. */
  async set(key, value) {
    if (!_isSecureAvailable()) return;
    return window.electron.secureSet(key, value ?? "");
  },
};

/**
 * Clears all app caches, Electron browser cache, AniList, EpisodeGroup,
 * AniSkip, and dlDur_ keys. Single source of truth used by Settings
 * "Clear Cache" button and post-update cache clearing in App.jsx.
 */
export async function clearAppCaches() {
  if (isElectron) {
    try {
      await window.electron.clearAppCache();
    } catch {}
  }
  localStorage.removeItem("streambert_anilistCache");
  localStorage.removeItem("streambert_episodeGroupCache");
  localStorage.removeItem("streambert_aniskipCache");
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("dlDur_")) localStorage.removeItem(key);
  }
}
