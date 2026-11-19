// iOS (Capacitor) replacement for the Electron preload API (window.electron).
// Streaming + core app only: downloads, Discord RPC, auto-update, window
// controls and file-system helpers are safe no-ops on iOS.
import { version as APP_VERSION } from "../../../package.json";
import "./ios.css";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";

const noop = () => {};
const resolved = (v) => () => Promise.resolve(v);
const listeners = new Map(); // channel -> Set<cb>
const on = (ch) => (cb) => {
  if (!listeners.has(ch)) listeners.set(ch, new Set());
  listeners.get(ch).add(cb);
  return cb;
};
const off = (ch) => (h) => listeners.get(ch)?.delete(h);
export const emit = (ch, data) =>
  listeners.get(ch)?.forEach((cb) => {
    try {
      cb(data);
    } catch {}
  });

// Safari-equivalent UA (WKWebView's default lacks Version/ and Safari/).
const ua = navigator.userAgent;
const safariUa = /Safari\//.test(ua)
  ? ua
  : ua.replace(/(Mobile\/\S+)/, "Version/18.0 $1 Safari/604.1");

const SECURE_PREFIX = "streambert_secure_";

window.electron = {
  cleanUserAgent: safariUa,
  isIOS: true,

  onM3u8Found: on("m3u8-found"),
  offM3u8Found: off("m3u8-found"),
  onSubtitleFound: on("subtitle-found"),
  offSubtitleFound: off("subtitle-found"),
  onDownloadProgress: on("download-progress"),
  offDownloadProgress: off("download-progress"),

  // Downloads: not supported on iOS
  checkDownloader: resolved({ ok: false, error: "Downloads are not available on iOS" }),
  runDownload: resolved({ ok: false, error: "Downloads are not available on iOS" }),
  getDownloads: resolved([]),
  deleteDownload: resolved({ ok: true }),
  showInFolder: resolved(undefined),
  fileExists: resolved(false),
  scanDirectory: resolved([]),
  pickFolder: resolved(null),
  openPath: resolved(undefined),
  getInstallPath: resolved(""),
  openPathAtTime: resolved(undefined),
  pruneSubtitlePaths: resolved({ ok: true, subtitlePaths: [] }),
  getVideoDuration: resolved({ ok: false }),

  openExternal: (url) => {
    try {
      window.open(String(url), "_blank");
    } catch {}
    return Promise.resolve();
  },
  openStreamExternal: ({ url } = {}) => {
    if (!/^https?:/i.test(url || "")) return Promise.resolve({ ok: false, error: "Invalid stream URL" });
    window.open("vlc-x-callback://x-callback-url/stream?url=" + encodeURIComponent(url), "_blank");
    return Promise.resolve({ ok: true });
  },

  onConfirmClose: on("confirm-close"),
  offConfirmClose: off("confirm-close"),
  respondClose: noop,

  // HiAnime needs the desktop main-process resolver (CORS + Referer). TODO iOS.
  resolveHiAnime: resolved({ ok: false, error: "HiAnime is not available on iOS yet" }),
  setPlayerVideo: resolved({ playerUrl: "about:blank" }),
  onHiAnimeProgress: () => noop,
  debugHiAnime: resolved({ error: "disabled" }),

  getAppVersion: resolved(APP_VERSION),

  onWebviewEnterFullscreen: on("webview-enter-fullscreen"),
  offWebviewEnterFullscreen: off("webview-enter-fullscreen"),
  onWebviewLeaveFullscreen: on("webview-leave-fullscreen"),
  offWebviewLeaveFullscreen: off("webview-leave-fullscreen"),

  onBlockedUpdate: on("blocked-stats-update"),
  offBlockedUpdate: off("blocked-stats-update"),
  getBlockStats: resolved({ total: 0, domains: {} }),

  showNotification: resolved(undefined),
  quitApp: resolved(undefined),
  playerStopped: noop,

  getCacheSize: resolved(-1),
  getDownloadsSize: resolved(-1),
  clearAppCache: resolved({ ok: true }),
  queryVideoProgress: resolved(null),
  clearWatchData: resolved({ ok: true }),
  deleteAllDownloads: resolved({ ok: true }),
  resetApp: () => {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith("streambert_"))
        .forEach((k) => localStorage.removeItem(k));
    } catch {}
    location.reload();
    return Promise.resolve({ ok: true });
  },

  // Subtitle search lives in the desktop main process (CORS). TODO iOS.
  searchSubtitles: resolved({ ok: false, error: "Subtitle search is not available on iOS yet" }),
  getSubtitleUrl: resolved({ ok: false, error: "Not available on iOS" }),
  downloadSubtitlesForFile: resolved({ ok: false, error: "Not available on iOS" }),
  deleteSubtitleFile: resolved({ ok: true }),
  wyzieOpenRedeem: () => window.electron.openExternal("https://sub.wyzie.io/redeem"),
  wyzieValidateKey: resolved({ ok: false, error: "Not available on iOS" }),

  // Secure store: iOS Keychain (via @aparajita/capacitor-secure-storage).
  // Falls back to localStorage (persistent WKWebView data store) if the
  // Keychain is unavailable, e.g. some unsigned/sideloaded installs.
  secureGet: async (key) => {
    let local = null;
    try {
      local = localStorage.getItem(SECURE_PREFIX + key);
    } catch {}
    try {
      const v = await SecureStorage.getItem(key);
      if (v != null && v !== "") return v;
      if (local) {
        // migrate a fallback copy into the Keychain
        await SecureStorage.setItem(key, local);
        localStorage.removeItem(SECURE_PREFIX + key);
      }
    } catch {}
    return local;
  },
  secureSet: async (key, value) => {
    try {
      if (value) await SecureStorage.setItem(key, value);
      else await SecureStorage.removeItem(key);
      localStorage.removeItem(SECURE_PREFIX + key);
      return { ok: true };
    } catch {}
    try {
      if (value) localStorage.setItem(SECURE_PREFIX + key, value);
      else localStorage.removeItem(SECURE_PREFIX + key);
    } catch {}
    return { ok: true };
  },

  openPipWindow: resolved({ ok: false, reason: "unsupported" }),
  closePipWindow: resolved(undefined),
  getPipWebContentsId: resolved(null),
  onPipOpened: on("pip-window-opened"),
  offPipOpened: off("pip-window-opened"),
  onPipClosed: on("pip-window-closed"),
  offPipClosed: off("pip-window-closed"),

  windowMinimize: resolved(undefined),
  windowToggleMaximize: resolved(undefined),
  windowClose: resolved(undefined),
  windowIsMaximized: resolved(false),
  getPlatform: resolved("ios"),
  onWindowMaximize: on("window-maximized"),
  offWindowMaximize: off("window-maximized"),
  setZoomFactor: noop,

  detectUpdateFormat: resolved(null),
  downloadAndInstallUpdate: resolved({ ok: false, error: "Updates come from new IPA builds on iOS" }),
  cancelUpdate: resolved(undefined),
  onUpdateProgress: on("update-progress"),
  offUpdateProgress: off("update-progress"),

  getScheduledBackupSettings: resolved({ enabled: false }),
  setScheduledBackupSettings: resolved({ ok: true }),
  performScheduledBackup: resolved({ ok: false }),
  onScheduledBackupRequested: on("scheduled-backup-requested"),
  offScheduledBackupRequested: off("scheduled-backup-requested"),

  fetchReleaseImage: resolved(null),
  discordRpcSetEnabled: resolved(undefined),
  discordRpcUpdateActivity: resolved(undefined),
};

// No auto-update checks on iOS (the desktop updater can't install an IPA).
try {
  if (localStorage.getItem("streambert_autoCheckUpdates") === null)
    localStorage.setItem("streambert_autoCheckUpdates", "0");
} catch {}

// Notch / Dynamic Island: let CSS use env(safe-area-inset-*)
const vp = document.querySelector('meta[name="viewport"]');
if (vp && !/viewport-fit/.test(vp.content))
  vp.content += ", viewport-fit=cover, user-scalable=no";
document.documentElement.classList.add("sb-ios");
document.title = "Super Player";
