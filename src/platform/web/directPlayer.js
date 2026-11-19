// Web app: plays Cinejoy's stream straight in a <video> with hls.js (no embed
// page, so no ads and a much faster start). Some hosts wrap TS segments in a
// fake image header; the loader cuts to the TS sync byte.
import Hls from "hls.js";

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

const IS_IPHONE = /iPhone|iPod/.test(navigator.userAgent);
const BTN_CSS = "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:6;padding:14px 26px;border-radius:26px;border:0;background:rgba(229,9,20,.94);color:#fff;font-size:17px;font-weight:700;display:none";

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

// Phones: the player always fills the whole screen (a stage over the app),
// with no tap needed, on every phone and browser. Apple's / the browser's own
// full screen is tried on top of it when the browser allows it.
const IS_PHONE =
  /iPhone|iPod|Android.*Mobile|Mobile.*Firefox/i.test(navigator.userAgent) ||
  (matchMedia?.("(pointer: coarse)")?.matches && Math.min(screen.width, screen.height) < 600);
let stage = null;
function getStage() {
  if (stage?.isConnected) return stage;
  stage = document.createElement("div");
  stage.id = "sb-stage";
  stage.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;height:100dvh;z-index:2147483000;background:#000;display:none;overscroll-behavior:none;touch-action:manipulation";
  document.body.appendChild(stage);
  return stage;
}
const stageShown = () => !!stage && stage.style.display !== "none";
function showStage(on) {
  const st = getStage();
  st.style.display = on ? "block" : "none";
  document.documentElement.style.overflow = on ? "hidden" : "";
  if (on) { try { screen.orientation?.lock?.("landscape")?.catch?.(() => {}); } catch {} }
}

/**
 * Play `src` inside `box`. Calls onFail() if nothing plays within `timeoutMs`
 * or on a fatal error. Returns a stop() function.
 *
 * The <video> stays in the box between episodes and is reused: the browser
 * already let it play from a tap, so the next episode starts on its own with
 * sound, and full screen carries over.
 */
export function playDirect(pageBox, src, { startAt = 0, onFail, onTime, timeoutMs = 12000, nativeOnly = false } = {}) {
  const ac = new AbortController();
  const on = (el, ev, fn, opts = {}) => el.addEventListener(ev, fn, { ...opts, signal: ac.signal });
  // Phones play on the full-screen stage; desktop/tablet in the page's box.
  let box = IS_PHONE ? getStage() : pageBox;
  if (IS_PHONE) {
    // Whatever was left inline (minimized) moves back onto the stage.
    const left = pageBox.querySelector(":scope > video.sb-direct-video");
    if (left && !box.contains(left)) box.appendChild(left);
    showStage(true);
  }
  let video = box.querySelector(":scope > video.sb-direct-video");
  const reused = !!video;
  if (!video) {
    video = document.createElement("video");
    video.className = "sb-direct-video";
    box.appendChild(video);
  }
  clearTimeout(video.__sbExitTimer);
  video.controls = true;
  // iPhone: no playsinline, so play() opens Apple's own full-screen player.
  const nativeHls = !!video.canPlayType("application/vnd.apple.mpegurl");
  video.playsInline = !IS_IPHONE;
  if (IS_IPHONE) video.removeAttribute("playsinline");
  else video.setAttribute("playsinline", "");
  video.autoplay = true;
  video.preload = "auto";
  // Required for ManagedMediaSource (hls.js on iPhone, iOS 17.1+).
  video.disableRemotePlayback = true;
  video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;background:#000;object-fit:contain;z-index:3";
  try { video.playbackRate = Number(localStorage.getItem("sbWebRate")) || 1; } catch {}
  for (const el of box.querySelectorAll(":scope > .sb-direct-ui")) el.remove();
  let done = false;
  let hls = null;
  const fail = (why) => {
    if (done) return;
    stop();
    onFail?.(why);
  };
  const timer = setTimeout(() => !(video.currentTime > 0) && fail("timeout"), timeoutMs);

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
  const nativeFull = () => (IS_IPHONE ? !!video.webkitDisplayingFullscreen : !!fsElement());
  const isFull = () => nativeFull() || (IS_PHONE && stageShown() && box === stage);
  // ✕ on the stage: shrink back into the page (keeps playing); Full screen
  // brings it back.
  let closeBtn = null;
  let upNextCard = null;
  const moveTo = (target) => {
    const wasPlaying = !video.paused;
    for (const el of [video, bigBtn, upNextCard, closeBtn]) if (el) target.appendChild(el);
    box = target;
    if (wasPlaying) video.play().catch(() => {});
  };
  const goFull = () => {
    if (done) return;
    if (IS_PHONE && box !== stage) { moveTo(getStage()); }
    if (IS_PHONE) { showStage(true); if (closeBtn) closeBtn.style.display = ""; }
    if (nativeFull()) return;
    try {
      if (IS_IPHONE) {
        if (video.webkitEnterFullscreen && video.readyState >= 1) video.webkitEnterFullscreen();
      } else if (canBoxFullscreen(box)) {
        enterBoxFullscreen(box).catch?.(() => {});
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
  };
  // hls.js first wherever it runs (iPhone too, via ManagedMediaSource): Cinejoy's
  // segments are TS wrapped in a fake PNG header that Safari's own HLS can't play.
  if (Hls.isSupported() && !nativeOnly) {
    startHls();
  } else {
    video.src = src;
    on(video, "error", () => !done && !hls && fail("video error"));
  }
  if (startAt > 0) on(video, "loadedmetadata", () => (video.currentTime = startAt), { once: true });

  // Start now (inside the Play tap when the stream was already known) and go
  // full screen in the same tap.
  if (IS_PHONE) {
    closeBtn = document.createElement("button");
    closeBtn.className = "sb-direct-ui";
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Exit full screen");
    closeBtn.style.cssText = "position:absolute;top:calc(env(safe-area-inset-top) + 10px);left:calc(env(safe-area-inset-left) + 12px);z-index:8;width:40px;height:40px;border-radius:20px;border:0;background:rgba(0,0,0,.55);color:#fff;font-size:20px";
    closeBtn.onclick = () => {
      closeBtn.style.display = "none";
      moveTo(pageBox);
      showStage(false);
      try { screen.orientation?.unlock?.(); } catch {}
      showBtn("⛶  Full screen");
    };
    box.appendChild(closeBtn);
  }
  if (!canBoxFullscreen(box) || !fsElement()) goFull();
  const tapPlay = video.play();
  tapPlay?.catch?.(() => {
    if (done || !video.paused) return;
    showBtn("▶  Play");
    clearTimeout(timer);
  });
  on(video, "loadedmetadata", goFull, { once: true });
  on(video, "canplay", () => {
    if (!video.paused) return goFull();
    video.play().then(goFull).catch(() => showBtn("▶  Play"));
  }, { once: true });
  // Still not full screen once it plays (the browser wanted a fresh tap):
  // one more try, then a big Full screen button until it is.
  on(video, "playing", () => {
    bigBtn.style.display = "none";
    goFull();
    setTimeout(() => !done && !isFull() && !video.paused && showBtn("⛶  Full screen"), 600);
  });
  bigBtn.onclick = () => {
    bigBtn.style.display = "none";
    // Inside the tap: play and full screen together (iPhone needs both here).
    const p = video.play();
    goFull();
    p?.catch?.(() => showBtn("▶  Play"));
  };
  on(video, "webkitbeginfullscreen", () => (bigBtn.style.display = "none"));
  on(video, "webkitendfullscreen", () => !done && !video.ended && showBtn("⛶  Full screen"));
  on(document, "fullscreenchange", () => {
    if (fsElement()) bigBtn.style.display = "none";
    else if (!done && !video.paused) showBtn("⛶  Full screen");
  });

  // ── Up Next: at the end of an episode, the next one plays by itself ──
  // (Settings > Playback autoplay and countdown; the page sets __sbWebUpNext.)
  let upNextTimer = null;
  const clearUpNext = () => {
    clearInterval(upNextTimer);
    upNextTimer = null;
    upNextCard?.remove();
    upNextCard = null;
  };
  const playNext = () => {
    clearUpNext();
    window.__sbNextAt = Date.now();
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
    upNextCard.style.cssText = "position:absolute;right:16px;bottom:64px;z-index:7;max-width:280px;background:rgba(20,20,22,.94);color:#fff;border-radius:14px;padding:12px;font:14px -apple-system,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5)";
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
    video.pause();
    video.removeAttribute("src");
    try { video.load(); } catch {}
    bigBtn.remove();
    closeBtn?.remove();
    if (IS_PHONE && box === stage) {
      // Going to the next episode: stay on the black stage with a spinner
      // line; anything else (player closed): back to the app right away.
      if (Date.now() - (window.__sbNextAt || 0) < 3000) {
        const note = document.createElement("div");
        note.className = "sb-direct-ui";
        note.textContent = "Loading next episode…";
        note.style.cssText = "position:absolute;left:0;right:0;top:50%;text-align:center;color:#fff;opacity:.8;font:16px -apple-system,system-ui,sans-serif";
        stage.appendChild(note);
        const st = stage;
        setTimeout(() => { if (!st.querySelector("video.sb-direct-video")?.src) { note.remove(); showStage(false); } }, 15000);
      } else {
        showStage(false);
      }
    }
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
