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
  warmHost.setAttribute("data-sb-warm", ""); // the Watch Party adapter never drives a hidden warm-up player
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

// #19: an embed server page (iframe) on screen holds the warm-up off. A hidden
// player buffering while an embed streams was a second video decode + network
// stream at once, enough memory for iOS to kill the Safari / home-screen tab.
const embedHolds = new Set();
/** An embed on screen (`on`) drops the warm-up player and blocks new ones until released. */
export function holdPrewarm(owner, on) {
  if (on) {
    embedHolds.add(owner);
    dropWarm();
  } else embedHolds.delete(owner);
}
export const prewarmHeld = () => embedHolds.size > 0;
/** Test hook: the hidden warm-up <video>, if any. */
export const warmVideo = () => warm?.video || null;

/** Load `src` into a hidden player now, so playDirect(src) starts at once. */
export function prewarmDirect(src, { startAt = 0, nativeOnly = false } = {}) {
  if (SbPlayer) return; // Android: the built-in player starts fast on its own
  if (embedHolds.size) return; // an embed is playing: never buffer a second stream
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
    video.__sbHls = hls; // Watch Party: restart a loader stuck after a seek
  } else {
    video.addEventListener("error", () => (w.dead = true));
    if (startAt > 0) video.addEventListener("loadedmetadata", () => (video.currentTime = startAt), { once: true });
    video.src = src;
    video.load();
  }
  warm = w;
}

/**
 * iPhone web app: called inside the Play tap when the stream is still being
 * looked up. Puts the player's <video> in the box now and starts it (no
 * source yet) inside the tap, so iOS lets the stream play, and open Apple's
 * own full-screen player, the moment it is found, with no second tap.
 */
export function primeDirectVideo(box) {
  if (SbPlayer || !isIPhoneUA() || window.__sbWatchParty) return;
  let video = box.querySelector(":scope > video.sb-direct-video");
  if (!video) {
    video = makeVideo();
    video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;background:#000;z-index:3;visibility:hidden";
    box.appendChild(video);
  }
  video.__sbPrimed = navigator.userActivation ? navigator.userActivation.isActive : true;
  try { video.play()?.catch?.(() => {}); } catch {}
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

const IS_IPHONE = /iPhone|iPod/.test(navigator.userAgent);
const BTN_CSS = "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:6;padding:14px 26px;border-radius:26px;border:0;background:rgba(229,9,20,.94);color:#fff;font-size:17px;font-weight:700;display:none;visibility:visible";

// The page's player box when the browser can put an element in full screen
// (Android, iPad, desktop): the box keeps our buttons and the Up Next card
// on screen, and stays full screen from one episode to the next.
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
function enterBoxFullscreen(box) {
  if (fsElement()) return Promise.resolve(true);
  const req = box.requestFullscreen || box.webkitRequestFullscreen;
  if (!req) return Promise.resolve(false);
  try {
    const p = req.call(box, { navigationUI: "hide" });
    const lock = () => { try { screen.orientation?.lock?.("landscape")?.catch?.(() => {}); } catch {} };
    if (p?.then) return p.then(() => (lock(), true), () => false);
    lock();
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}
const canBoxFullscreen = (box) => !IS_IPHONE && !!(box.requestFullscreen || box.webkitRequestFullscreen);

/**
 * Play `src` inside `box`. Calls onFail() if nothing plays within `timeoutMs`
 * or on a fatal error. Returns a stop() function.
 *
 * The <video> stays in the box between episodes and is reused: the browser
 * already let it play from a tap, so the next episode starts on its own with
 * sound, and full screen carries over.
 */
export function playDirect(box, src, { startAt = 0, onFail, onTime, timeoutMs = 12000, nativeOnly = false, referer = "", headers = null } = {}) {
  // Android app: always the built-in player, also in a Watch Party (it sends the
  // stream's Referer / Origin headers, which the WebView's <video> can't, so
  // many hosts refused the in-page player: the broken-video icon at 0:00).
  // The party drives it through adapters/android.js.
  if (SbPlayer) return playAndroid(box, src, { startAt, onFail, onTime, referer, headers });
  // Web Watch Party: the party player is this <video>, inline beside the chat
  // (iPhone Safari too: Apple's full-screen player would hide the chat), and
  // the party (src/watch/adapters/web.js) starts / pauses it, never this file.
  const party = !!window.__sbWatchParty;
  // The party picks the start frame for everyone (the engine seeks there), not this phone's resume point.
  if (party) startAt = 0;
  const ac = new AbortController();
  const on = (el, ev, fn, opts = {}) => el.addEventListener(ev, fn, { ...opts, signal: ac.signal });
  let video = box.querySelector(":scope > video.sb-direct-video");
  const reused = !!video;
  // A stream warmed up on the title page (prewarmDirect) starts at once.
  const w = reused ? null : takeWarm(src, nativeOnly);
  if (!video) {
    video = w ? w.video : document.createElement("video");
    video.className = "sb-direct-video";
    box.appendChild(video);
  }
  clearTimeout(video.__sbExitTimer);
  video.controls = true;
  // iPhone: no playsinline, so play() opens Apple's own full-screen player.
  const nativeHls = !!video.canPlayType("application/vnd.apple.mpegurl");
  video.playsInline = party || !IS_IPHONE;
  if (IS_IPHONE && !party) video.removeAttribute("playsinline");
  else video.setAttribute("playsinline", "");
  if (party) video.setAttribute("webkit-playsinline", "");
  video.autoplay = !party;
  video.preload = "auto";
  // Required for ManagedMediaSource (hls.js on iPhone, iOS 17.1+).
  video.disableRemotePlayback = true;
  // visibility: the page may still hide its embed web view (the box) while it
  // "loads"; the direct video and its controls are the player and always show.
  video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;background:#000;object-fit:contain;z-index:3;visibility:visible";
  try { video.playbackRate = Number(localStorage.getItem("sbWebRate")) || 1; } catch {}
  for (const el of box.querySelectorAll(":scope > .sb-direct-ui")) el.remove();
  let done = false;
  let hls = w?.hls || null;
  const fail = (why) => {
    if (done) return;
    stop();
    onFail?.(why);
  };
  // Party: held paused on the start frame until everyone is buffered, so
  // "loaded" (metadata in) is what counts, not "moving".
  const timer = setTimeout(() => (party ? video.readyState < 1 : IS_IPHONE ? video.readyState < 1 && !(video.currentTime > 0) : !(video.currentTime > 0)) && fail("timeout"), timeoutMs);

  // Big centre button: Play (when the browser wants a tap) or Full screen.
  const bigBtn = document.createElement("button");
  bigBtn.className = "sb-direct-ui";
  bigBtn.style.cssText = BTN_CSS;
  box.appendChild(bigBtn);
  const showBtn = (label) => {
    if (done) return;
    bigBtn.textContent = label;
    bigBtn.style.display = "";
  };

  // Full screen, forced on every phone:
  // iPhone: Apple's own player (webkitEnterFullscreen; needs metadata, so it
  // is tried on the tap, again once metadata is in, and again when playing).
  // Everything else: the player box in full screen, turned to landscape.
  const isFull = () => (IS_IPHONE ? !!video.webkitDisplayingFullscreen : !!fsElement());
  const goFull = () => {
    if (party || done || isFull()) return;
    try {
      if (IS_IPHONE) {
        if (video.webkitEnterFullscreen && video.readyState >= 1) video.webkitEnterFullscreen();
      } else if (canBoxFullscreen(box)) {
        enterBoxFullscreen(box);
      } else if (video.webkitEnterFullscreen && video.readyState >= 1) {
        video.webkitEnterFullscreen();
      }
    } catch {}
  };

  const startHls = () => {
    hls = new Hls({
      loader: UnwrapLoader,
      enableWorker: true,
      startLevel: -1,
      capLevelToPlayerSize: true,
      maxBufferLength: 30,
      backBufferLength: 30,
      startFragPrefetch: true,
      fragLoadingMaxRetry: 4,
    });
    hls.on(Hls.Events.ERROR, (_, d) => d.fatal && fail(d.details));
    hls.loadSource(src);
    hls.attachMedia(video);
    video.__sbHls = hls; // Watch Party: restart a loader stuck after a seek
  };
  // hls.js first wherever it runs (iPhone too, via ManagedMediaSource): Cinejoy's
  // segments are TS wrapped in a fake PNG header that Safari's own HLS can't play.
  if (w?.hls) {
    w.hls.off(Hls.Events.ERROR, w.onErr);
    w.hls.on(Hls.Events.ERROR, (_, d) => d.fatal && fail(d.details));
  } else if (w) {
    on(video, "error", () => !done && fail("video error"));
  } else if (useHlsJs(video, nativeOnly)) {
    startHls();
  } else {
    // Safari's own HLS (Apple's player, like the app).
    video.src = src;
    on(video, "error", () => !done && !hls && fail("video error"));
  }
  if (w) {
    if (startAt > 0 && video.readyState >= 1 && Math.abs(video.currentTime - startAt) > 5) video.currentTime = startAt;
  } else if (startAt > 0) on(video, "loadedmetadata", () => (video.currentTime = startAt), { once: true });

  // iPhone: Apple's own player only opens from a tap made once the video has
  // loaded, so (unless Apple's player is already up from the last episode)
  // it waits on one big Play button; that tap opens Apple's player and plays.
  // Inside the Play tap (or on a player unlocked in that tap) it plays right
  // away: no playsinline, so iOS opens Apple's own full-screen player.
  const inTap = IS_IPHONE && (video.__sbPrimed || !!navigator.userActivation?.isActive);
  video.__sbPrimed = false;
  const iphoneWait = !party && IS_IPHONE && !video.webkitDisplayingFullscreen && !inTap;
  if (iphoneWait) {
    video.autoplay = false;
    showBtn("▶  Play");
    if (video.readyState < 1) {
      bigBtn.textContent = "Loading…";
      on(video, "loadedmetadata", () => showBtn("▶  Play"), { once: true });
    }
  }
  // Any play on iPhone (the inline controls too) goes to Apple's player.
  if (IS_IPHONE && !party) on(video, "play", () => { if (!video.webkitDisplayingFullscreen && video.readyState >= 1) try { video.webkitEnterFullscreen(); } catch {} });
  // Elsewhere: start now and go full screen in the same tap.
  if (!IS_IPHONE && (!canBoxFullscreen(box) || !fsElement())) goFull();
  const tapPlay = iphoneWait || party ? null : video.play();
  tapPlay?.catch?.(() => {
    if (done || !video.paused) return;
    showBtn("▶  Play");
    clearTimeout(timer);
  });
  if (!iphoneWait) on(video, "loadedmetadata", goFull, { once: true });
  on(video, "canplay", () => {
    if (party || (iphoneWait && video.paused)) return;
    if (!video.paused) return goFull();
    video.play().then(goFull).catch(() => showBtn("▶  Play"));
  }, { once: true });
  // Still not full screen once it plays (the browser wanted a fresh tap):
  // one more try, then a big Full screen button until it is.
  on(video, "playing", () => {
    bigBtn.style.display = "none";
    goFull();
    if (!party) setTimeout(() => !done && !isFull() && !video.paused && showBtn("⛶  Full screen"), 600);
  });
  bigBtn.onclick = () => {
    // iPhone before the video has loaded: Apple's player can't open yet.
    if (IS_IPHONE && video.readyState < 1) {
      bigBtn.textContent = "Loading…";
      on(video, "loadedmetadata", () => showBtn("▶  Play"), { once: true });
      return;
    }
    bigBtn.style.display = "none";
    // Inside the tap: play and full screen together (iPhone needs both here).
    const p = video.play();
    goFull();
    p?.catch?.(() => showBtn("▶  Play"));
  };
  on(video, "webkitbeginfullscreen", () => (bigBtn.style.display = "none"));
  // Apple's player closed (Done / swipe down): back on the title page,
  // paused where it stopped, with one clean Resume button (never the inline
  // web player running in the page).
  on(video, "webkitendfullscreen", () => {
    if (party || done || video.ended) return;
    try { video.pause(); } catch {}
    onTime?.(video.currentTime, video.duration);
    showBtn("▶  Resume");
    window.dispatchEvent(new CustomEvent("sb-web-player-closed", { detail: { time: video.currentTime } }));
  });
  on(document, "fullscreenchange", () => {
    if (fsElement()) bigBtn.style.display = "none";
    else if (!party && !done && !video.paused) showBtn("⛶  Full screen");
  });

  // ── Up Next: at the end of an episode, the next one plays by itself ──
  // (Settings > Playback autoplay and countdown; the page sets __sbWebUpNext.)
  let upNextCard = null;
  let upNextTimer = null;
  const clearUpNext = () => {
    clearInterval(upNextTimer);
    upNextTimer = null;
    upNextCard?.remove();
    upNextCard = null;
  };
  const playNext = () => {
    clearUpNext();
    window.dispatchEvent(new CustomEvent("sb-up-next-play"));
  };
  const offerNext = () => {
    const info = window.__sbWebUpNext;
    if (done || !info || upNextCard) return;
    let left = Math.max(0, Math.round(Number(info.countdown ?? 10)));
    // Apple's full-screen player covers the page, so nothing could be shown
    // there: the next episode just starts, staying in full screen.
    if (left === 0 || (IS_IPHONE && video.webkitDisplayingFullscreen)) return playNext();
    upNextCard = document.createElement("div");
    upNextCard.className = "sb-direct-ui";
    upNextCard.style.cssText = "visibility:visible;position:absolute;right:16px;bottom:64px;z-index:7;max-width:280px;background:rgba(20,20,22,.94);color:#fff;border-radius:14px;padding:12px;font:14px -apple-system,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5)";
    const thumb = info.thumb ? `<img src="${info.thumb}" style="width:100%;border-radius:8px;margin-bottom:8px;display:block" alt="">` : "";
    upNextCard.innerHTML = `${thumb}<div style="opacity:.7;font-size:12px">${info.subtitle || "Up Next"}</div><div style="font-weight:700;margin:2px 0 10px"></div><div style="display:flex;gap:8px"><button data-a="play" style="flex:1;padding:9px;border:0;border-radius:8px;background:#e50914;color:#fff;font-weight:700"></button><button data-a="cancel" style="padding:9px 12px;border:0;border-radius:8px;background:#3a3a3e;color:#fff">Cancel</button></div>`;
    upNextCard.children[thumb ? 2 : 1].textContent = info.title || "Next episode";
    const playBtn = upNextCard.querySelector('[data-a="play"]');
    const label = () => (playBtn.textContent = `▶  Play in ${left}`);
    label();
    playBtn.onclick = playNext;
    upNextCard.querySelector('[data-a="cancel"]').onclick = clearUpNext;
    box.appendChild(upNextCard);
    upNextTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) playNext();
      else label();
    }, 1000);
  };
  on(video, "ended", offerNext);
  // Seeking back after the card appeared: put it away.
  on(video, "seeking", () => upNextCard && !video.ended && clearUpNext());

  // Double-tap left/right: back/forward 10 s (like the app's player).
  let lastTap = 0;
  on(video, "touchend", (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      const r = video.getBoundingClientRect();
      const x = e.changedTouches[0].clientX - r.left;
      video.currentTime = Math.max(0, video.currentTime + (x < r.width / 2 ? -10 : 10));
      e.preventDefault();
    }
    lastTap = now;
  });
  on(video, "ratechange", () => { try { localStorage.setItem("sbWebRate", String(video.playbackRate)); } catch {} });
  on(video, "timeupdate", () => onTime?.(video.currentTime, video.duration));
  void reused;

  function stop() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearUpNext();
    ac.abort();
    try { hls?.destroy(); } catch {}
    hls = null;
    video.__sbHls = null;
    video.pause();
    video.removeAttribute("src");
    try { video.load(); } catch {}
    bigBtn.remove();
    // Kept in the box for the next episode. If nothing reuses it soon (the
    // player was closed), leave full screen and take it away.
    const v = video;
    v.__sbExitTimer = setTimeout(() => {
      if (v.src) return;
      try { if (v.webkitDisplayingFullscreen) v.webkitExitFullscreen(); } catch {}
      try { if (fsElement() === box) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); } catch {}
      v.remove();
    }, 15000);
  }
  return stop;
}
