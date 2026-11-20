// Web app: plays a direct HLS stream (Cinejoy, ani.pm) straight in a <video>
// with hls.js (no embed page, so no ads and a much faster start). Some hosts
// wrap TS segments in a fake image header; the loader cuts to the TS sync byte.
//
// Instant start: while a title page is open, prewarmDirect() loads the stream
// into a hidden player (playlist + first seconds of video). Play then just
// moves that player on screen and calls play() inside the tap, so iPhone and
// Android start at once, with no playlist or first-segment wait.
import Hls from "hls.js";
import { registerPlugin } from "@capacitor/core";

// Android app: the built-in player (PlayerActivity, ExoPlayer), like the
// iPhone app's native player. Undefined in every other build.
const SbPlayer = import.meta.env.VITE_ANDROID ? registerPlugin("SbPlayer") : null;

function playAndroid(box, src, { startAt = 0, onFail, onTime, referer = "", headers = null }) {
  let done = false;
  // Events carry the session they belong to (offline downloads use the same player).
  const session = `stream:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const mine = (e) => !e?.session || e.session === session;
  const subs = [];
  let lastPos = startAt;
  const cleanup = () => {
    done = true;
    subs.forEach((h) => h?.remove?.());
  };
  // Back on the title page: a button to jump back into the player.
  const btn = document.createElement("button");
  btn.textContent = "▶  Play";
  btn.style.cssText =
    "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:4;padding:16px 34px;border-radius:28px;border:0;background:rgba(229,9,20,.92);color:#fff;font-size:20px;font-weight:600";
  const open = (at) => SbPlayer.play({ url: src, startAt: at, referer, headers: headers || {}, session }).catch(() => { cleanup(); btn.remove(); onFail?.("plugin"); });
  btn.onclick = () => {
    if (done) return;
    btn.textContent = "Resume";
    open(lastPos);
  };
  const black = document.createElement("div");
  black.style.cssText = "position:absolute;inset:0;background:#000;z-index:3";
  box.appendChild(black);
  box.appendChild(btn);
  Promise.all([
    SbPlayer.addListener("progress", (e) => { if (!done && mine(e) && e.pos > 0) { lastPos = e.pos; onTime?.(e.pos, e.dur); } }),
    SbPlayer.addListener("closed", (e) => { if (done || !mine(e)) return; if (e.pos > 0) { lastPos = e.pos; onTime?.(e.pos, e.dur); } btn.textContent = "▶  Resume"; }),
    SbPlayer.addListener("failed", (e) => {
      if (done || !mine(e)) return;
      cleanup();
      black.remove();
      btn.remove();
      onFail?.(e?.why || "native error");
    }),
  ]).then((hs) => {
    subs.push(...hs);
    if (done) return cleanup();
    open(startAt);
  });
  return () => {
    if (done) return;
    if (lastPos > 0) onTime?.(lastPos, 0);
    cleanup();
    black.remove();
    btn.remove();
    SbPlayer.stop().catch(() => {});
  };
}

function unwrap(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0x47) return buf;
  for (let i = 0; i < Math.min(b.length - 376, 4096); i++) {
    if (b[i] === 0x47 && b[i + 188] === 0x47 && b[i + 376] === 0x47) return buf.slice(i);
  }
  return buf;
}

class UnwrapLoader extends Hls.DefaultConfig.loader {
  load(context, config, callbacks) {
    const onSuccess = callbacks.onSuccess;
    callbacks = {
      ...callbacks,
      onSuccess: (res, stats, ctx, net) => {
        if (res.data instanceof ArrayBuffer) res.data = unwrap(res.data);
        onSuccess(res, stats, ctx, net);
      },
    };
    super.load(context, config, callbacks);
  }
}

const HLS_BASE = {
  loader: UnwrapLoader,
  enableWorker: true,
  // Lowest rung first: the picture shows in a fraction of a second, then ABR
  // climbs to the best quality the connection allows.
  startLevel: 0,
  testBandwidth: false,
  capLevelToPlayerSize: true,
  backBufferLength: 30,
  startFragPrefetch: true,
  fragLoadingMaxRetry: 4,
  manifestLoadingMaxRetry: 2,
};
const PLAY_BUFFER_S = 30;
const WARM_BUFFER_S = 8; // buffered ahead while waiting for Play (light on data)
const WARM_MAX_AGE_MS = 10 * 60_000; // stream tokens expire; rewarm after this

const isIPhoneUA = () => /iPhone|iPod/.test(navigator.userAgent);

function makeVideo() {
  const video = document.createElement("video");
  video.className = "sb-direct-video";
  video.controls = true;
  // iPhone: no playsinline, so play() opens Apple's own full-screen player.
  const isIPhone = isIPhoneUA();
  video.playsInline = !isIPhone;
  if (!isIPhone) video.setAttribute("playsinline", "");
  video.preload = "auto";
  // Required for ManagedMediaSource (hls.js on iPhone, iOS 17.1+).
  video.disableRemotePlayback = true;
  return video;
}

// hls.js wherever it runs, unless the caller asks for Safari's own HLS and the
// browser has it. Android and desktop Chrome have no reliable native HLS, so
// `nativeOnly` falls back to hls.js there instead of failing.
const useHlsJs = (video, nativeOnly) =>
  Hls.isSupported() && (!nativeOnly || !video.canPlayType("application/vnd.apple.mpegurl"));

// ── Warm-up pool (one stream at a time) ───────────────────────────────────
let warm = null; // { src, video, hls, onErr, at, dead, nativeOnly }
let warmHost = null;
function host() {
  if (warmHost?.isConnected) return warmHost;
  warmHost = document.createElement("div");
  warmHost.setAttribute("aria-hidden", "true");
  // Kept "visible" (tiny, transparent) so iPhone's ManagedMediaSource streams.
  warmHost.style.cssText =
    "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;overflow:hidden;z-index:-1";
  document.body.appendChild(warmHost);
  return warmHost;
}

function dropWarm() {
  if (!warm) return;
  const w = warm;
  warm = null;
  try { w.hls?.destroy(); } catch {}
  try {
    w.video.pause();
    w.video.removeAttribute("src");
    w.video.load();
  } catch {}
  w.video.remove();
}

/** Load `src` into a hidden player now, so playDirect(src) starts at once. */
export function prewarmDirect(src, { startAt = 0, nativeOnly = false } = {}) {
  if (SbPlayer) return; // Android: the built-in player starts fast on its own
  if (!src || typeof document === "undefined" || !document.body) return;
  if (warm && warm.src === src && !warm.dead && Date.now() - warm.at < WARM_MAX_AGE_MS) return;
  dropWarm();
  const video = makeVideo();
  video.muted = true; // silent while hidden; unmuted when it goes on screen
  host().appendChild(video);
  const w = { src, video, hls: null, at: Date.now(), dead: false, nativeOnly };
  if (useHlsJs(video, nativeOnly)) {
    const hls = new Hls({
      ...HLS_BASE,
      maxBufferLength: WARM_BUFFER_S,
      maxMaxBufferLength: WARM_BUFFER_S,
      startPosition: startAt > 0 ? startAt : -1,
    });
    w.onErr = (_, d) => d.fatal && (w.dead = true);
    hls.on(Hls.Events.ERROR, w.onErr);
    hls.loadSource(src);
    hls.attachMedia(video);
    w.hls = hls;
  } else {
    video.addEventListener("error", () => (w.dead = true));
    if (startAt > 0) video.addEventListener("loadedmetadata", () => (video.currentTime = startAt), { once: true });
    video.src = src;
    video.load();
  }
  warm = w;
}

/** Forget the warmed-up player (leaving a title page). */
export const cancelPrewarm = () => dropWarm();

function takeWarm(src, nativeOnly) {
  const w = warm;
  if (!w || w.src !== src) return null;
  if (w.dead || w.nativeOnly !== nativeOnly || Date.now() - w.at > WARM_MAX_AGE_MS) {
    dropWarm();
    return null;
  }
  warm = null;
  w.video.muted = false;
  if (w.hls) {
    w.hls.config.maxBufferLength = PLAY_BUFFER_S;
    w.hls.config.maxMaxBufferLength = 600;
  }
  return w;
}

/**
 * Put `el` full screen and turn the phone sideways (Android, desktop; iPhone
 * only full-screens a <video>, handled in playDirect). Call inside a tap.
 */
export function forceFullscreen(el) {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    const p = req?.call(el, { navigationUI: "hide" });
    Promise.resolve(p)
      .then(() => screen.orientation?.lock?.("landscape"))
      .catch(() => {});
  } catch {}
}

/**
 * Play `src` inside `box`. Calls onFail() if nothing plays within `timeoutMs`
 * or on a fatal error. onTime(position, duration) reports progress every few
 * seconds, on pause, at the end and on stop. Returns a stop() function.
 */
export function playDirect(box, src, { startAt = 0, onFail, onTime, timeoutMs = 12000, nativeOnly = false, referer = "", headers = null } = {}) {
  if (SbPlayer) return playAndroid(box, src, { startAt, onFail, onTime, referer, headers });
  const w = takeWarm(src, nativeOnly);
  const video = w ? w.video : makeVideo();
  const isIPhone = isIPhoneUA();
  video.autoplay = true;
  try { video.playbackRate = Number(localStorage.getItem("sbWebRate")) || 1; } catch {}
  video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;background:#000;object-fit:contain;z-index:3";
  // Moving a warmed-up player keeps its buffer and its MediaSource.
  box.appendChild(video);
  let done = false;
  let hls = w?.hls || null;
  const fail = (why) => {
    if (done) return;
    stop();
    onFail?.(why);
  };
  const timer = setTimeout(() => !(video.currentTime > 0) && fail("timeout"), timeoutMs);
  const seekIfOff = () => {
    if (startAt > 0 && video.readyState >= 1 && Math.abs(video.currentTime - startAt) > 5) video.currentTime = startAt;
  };
  if (w && hls) {
    hls.off(Hls.Events.ERROR, w.onErr);
    hls.on(Hls.Events.ERROR, (_, d) => d.fatal && fail(d.details));
    seekIfOff();
  } else if (w) {
    video.addEventListener("error", () => fail("video error"));
    seekIfOff();
  } else if (useHlsJs(video, nativeOnly)) {
    // hls.js first wherever it runs (iPhone too, via ManagedMediaSource): Cinejoy's
    // segments are TS wrapped in a fake PNG header that Safari's own HLS can't play.
    hls = new Hls({ ...HLS_BASE, maxBufferLength: PLAY_BUFFER_S, startPosition: startAt > 0 ? startAt : -1 });
    hls.on(Hls.Events.ERROR, (_, d) => d.fatal && fail(d.details));
    hls.loadSource(src);
    hls.attachMedia(video);
  } else {
    // Safari's own HLS (Apple's player, like the app).
    video.src = src;
    video.addEventListener("error", () => fail("video error"));
    if (startAt > 0) video.addEventListener("loadedmetadata", () => (video.currentTime = startAt), { once: true });
  }
  // iPhone: Apple's full-screen player (works in the tap once the player has
  // its first frames, which a warmed-up player already does).
  const goFull = () => {
    try {
      if (isIPhone && video.webkitEnterFullscreen) return video.webkitEnterFullscreen();
      forceFullscreen(box);
    } catch {}
  };
  const fullBtn = document.createElement("button");
  fullBtn.textContent = "⛶  Full screen";
  fullBtn.style.cssText =
    "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:4;padding:12px 22px;border-radius:24px;border:0;background:rgba(229,9,20,.92);color:#fff;font-size:16px;font-weight:600;display:none";
  fullBtn.onclick = () => {
    fullBtn.style.display = "none";
    // Inside the tap: play, then Apple's player (iPhone needs both in the gesture).
    const p = video.play();
    goFull();
    p?.catch?.(() => { fullBtn.textContent = "▶  Play"; fullBtn.style.display = ""; });
  };
  box.appendChild(fullBtn);
  // play() right now, inside the Play tap; iPhone also opens Apple's
  // full-screen player in the same tap.
  const tapPlay = video.play();
  goFull(); // every phone: straight into the full-screen player

  video.addEventListener("canplay", () => {
    if (!video.paused || done) return;
    video.play().then(() => goFull()).catch(() => {
      // Autoplay blocked: one tap starts it, full screen.
      fullBtn.textContent = "▶  Play";
      fullBtn.style.display = "";
    });
  }, { once: true });
  // Only if the browser refused to start without a fresh tap: one big Play button.
  tapPlay?.catch?.(() => {
    if (done || !video.paused) return;
    fullBtn.textContent = "▶  Play";
    if (isIPhone) fullBtn.style.cssText += ";font-size:20px;padding:16px 34px";
    fullBtn.style.display = "";
    clearTimeout(timer);
  });
  // iPhone: if it started inline (no tap left to use), keep a Full screen
  // button up until Apple's player is on.
  video.addEventListener("playing", () => {
    if (!isIPhone || video.webkitDisplayingFullscreen) return;
    setTimeout(() => {
      if (!done && !video.webkitDisplayingFullscreen) { fullBtn.textContent = "⛶  Full screen"; fullBtn.style.display = ""; }
    }, 400);
  });
  video.addEventListener("webkitbeginfullscreen", () => (fullBtn.style.display = "none"));
  // Back from full screen on iPhone: offer it again, keep playing inline.
  video.addEventListener("webkitendfullscreen", () => { fullBtn.textContent = "⛶  Full screen"; fullBtn.style.display = ""; });
  // Double-tap left/right: back/forward 10 s (like the app's player).
  let lastTap = 0;
  video.addEventListener("touchend", (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      const r = video.getBoundingClientRect();
      const x = e.changedTouches[0].clientX - r.left;
      video.currentTime = Math.max(0, video.currentTime + (x < r.width / 2 ? -10 : 10));
      e.preventDefault();
    }
    lastTap = now;
  });
  video.addEventListener("ratechange", () => { try { localStorage.setItem("sbWebRate", String(video.playbackRate)); } catch {} });
  // Progress: throttled, plus pause / end / stop, so Resume works on the web.
  let lastReport = 0;
  const report = (force) => {
    const now = Date.now();
    if (!force && now - lastReport < 5000) return;
    lastReport = now;
    if (video.currentTime > 0) onTime?.(video.currentTime, video.duration);
  };
  video.addEventListener("timeupdate", () => report(false));
  video.addEventListener("pause", () => report(true));
  video.addEventListener("ended", () => report(true));
  function stop() {
    if (done) return;
    report(true);
    done = true;
    clearTimeout(timer);
    try { hls?.destroy(); } catch {}
    video.pause();
    video.removeAttribute("src");
    video.remove();
    fullBtn.remove();
  }
  return stop;
}
