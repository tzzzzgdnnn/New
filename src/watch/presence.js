// Live counter: how many people have the app open right now, and how many are
// watching something, across iPhone, Android and web. Sends a small heartbeat
// (random device id + "is a video playing") to the watch server; gets counts.
const BEAT_MS = 30_000;
const ID_KEY = "sbPresenceId";
const WATCH_WINDOW_MS = 20_000;

let lastPlayAt = 0;
const markPlaying = () => (lastPlayAt = Date.now());

function deviceId() {
  try {
    let id = localStorage.getItem(ID_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^A-Za-z0-9_-]/g, "");
      localStorage.setItem(ID_KEY, id);
    }
    return id;
  } catch {
    return "anon" + Math.random().toString(36).slice(2, 12);
  }
}

const platform = () =>
  window.webkit?.messageHandlers?.sbResolve ? "ios" : /Android/i.test(navigator.userAgent) ? "android" : "web";

const watchingNow = () => {
  if (Date.now() - lastPlayAt < WATCH_WINDOW_MS) return true;
  return [...document.querySelectorAll("video")].some((v) => !v.paused && !v.ended && v.readyState > 2);
};

/** Start the heartbeat. `onCounts({online, watching, byPlatform})` on each reply. */
export function startPresence(base, onCounts) {
  const id = deviceId();
  const url = `${base}/presence`;
  let timer = 0, stopped = false;
  window.addEventListener("sb-native-progress", markPlaying);
  window.addEventListener("__sbWatchState", markPlaying);
  const beat = async () => {
    if (stopped) return;
    clearTimeout(timer);
    if (document.visibilityState !== "hidden") {
      try {
        const r = await fetch(url, { method: "POST", body: JSON.stringify({ id, watching: watchingNow(), platform: platform() }) });
        if (r.ok) onCounts?.(await r.json());
      } catch {}
    }
    timer = setTimeout(beat, BEAT_MS);
  };
  const onVis = () => {
    if (document.visibilityState === "visible") beat();
    else navigator.sendBeacon?.(url, JSON.stringify({ id, leaving: true }));
  };
  document.addEventListener("visibilitychange", onVis);
  beat();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("sb-native-progress", markPlaying);
    window.removeEventListener("__sbWatchState", markPlaying);
  };
}
