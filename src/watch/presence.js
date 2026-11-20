// Live counter: how many people have the app open right now across iPhone,
// Android and web, and how many people have used it in total (counted by
// the watch server's Presence object, see watch-together/worker.js).
//
// A person is a profile: each profile on a device (up to 5, no accounts)
// keeps its own server-issued token (localStorage, mirrored to the Keychain
// on iPhone so app updates and reinstalls keep it), so one profile counts
// once however many tabs, reopens or updates, and a profile that is never
// opened is never counted. Each tab adds its
// own tab id; closing a tab tells the server at once, and anything silent for
// 75 s drops off by itself.
import { secureStorage } from "../utils/storage.js";

export const BEAT_MS = 30_000;
const TOKEN_KEY = "sbPresenceToken";
const TAB_KEY = "sbPresenceTab";
const WATCH_WINDOW_MS = 20_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}\.[0-9a-z]{6,12}\.[A-Za-z0-9_-]{22}$/;

let lastPlayAt = 0;
const markPlaying = () => (lastPlayAt = Date.now());

const randomId = () =>
  (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);

/** This tab's id (a reload keeps it; a second tab gets its own). */
function tabId() {
  try {
    let id = sessionStorage.getItem(TAB_KEY);
    if (!id) {
      id = randomId();
      sessionStorage.setItem(TAB_KEY, id);
    }
    return id;
  } catch {
    return randomId();
  }
}

async function loadToken(key) {
  try {
    const t = localStorage.getItem(key);
    if (TOKEN_RE.test(t || "")) return t;
  } catch {}
  try {
    const t = await secureStorage.get(key);
    if (TOKEN_RE.test(t || "")) {
      localStorage.setItem(key, t);
      return t;
    }
  } catch {}
  return null;
}

function saveToken(key, t) {
  try {
    localStorage.setItem(key, t);
  } catch {}
  secureStorage.set(key, t)?.catch?.(() => {});
}

const platform = () =>
  window.webkit?.messageHandlers?.sbResolve ? "ios" : window.Capacitor?.getPlatform?.() === "android" || /Android/i.test(navigator.userAgent) ? "android" : "web";

const watchingNow = () => {
  if (Date.now() - lastPlayAt < WATCH_WINDOW_MS) return true;
  return [...document.querySelectorAll("video")].some((v) => !v.paused && !v.ended && v.readyState > 2);
};

/** Token storage key of a profile (the device itself when there are no profiles: desktop). */
export const tokenKey = (profileId) => `${TOKEN_KEY}:${String(profileId || "device").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "device"}`;

/** Start the heartbeat for the active profile. `onCounts({online, watching, total, byPlatform})` on each reply. */
export function startPresence(base, onCounts, profileId = null) {
  const key = tokenKey(profileId);
  const url = `${base}/presence`;
  const tab = tabId();
  let token = null;
  let timer = 0;
  let stopped = false;
  let inFlight = false;
  window.addEventListener("sb-native-progress", markPlaying);
  window.addEventListener("__sbWatchState", markPlaying);
  const ready = loadToken(key).then((t) => (token = t));
  const beat = async () => {
    if (stopped || inFlight) return;
    clearTimeout(timer);
    inFlight = true;
    try {
      await ready;
      if (document.visibilityState !== "hidden") {
        const r = await fetch(url, { method: "POST", body: JSON.stringify({ token, tab, watching: watchingNow(), platform: platform() }) });
        const d = await r.json().catch(() => null);
        if (d?.token && TOKEN_RE.test(d.token) && d.token !== token) {
          token = d.token;
          saveToken(key, token);
        }
        if (d && Number.isFinite(d.online)) onCounts?.(d);
      }
    } catch {
    } finally {
      inFlight = false;
    }
    if (!stopped) timer = setTimeout(beat, BEAT_MS);
  };
  const leave = () => {
    if (token) navigator.sendBeacon?.(url, JSON.stringify({ token, tab, leaving: true }));
  };
  const onVis = () => (document.visibilityState === "visible" ? beat() : leave());
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pagehide", leave);
  beat();
  return () => {
    stopped = true;
    clearTimeout(timer);
    leave();
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("pagehide", leave);
    window.removeEventListener("sb-native-progress", markPlaying);
    window.removeEventListener("__sbWatchState", markPlaying);
  };
}
