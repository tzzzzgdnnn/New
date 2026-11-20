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

/**
 * Play `src` inside `box`. Calls onFail() if nothing plays within `timeoutMs`
 * or on a fatal error. Returns a stop() function.
 *
 * The <video> stays in the box between episodes and is reused: the browser
 * already let it play from a tap, so the next episode starts on its own with
 * sound, and full screen carries over.
 */
export function playDirect(box, src, { startAt = 0, onFail, onTime, timeoutMs = 12000, nativeOnly = false } = {}) {
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
  if (!video) {
    video = document.createElement("video");
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

  // iPhone: Apple's own player only opens from a tap made once the video has
  // loaded, so (unless Apple's player is already up from the last episode)
  // it waits on one big Play button; that tap opens Apple's player and plays.
  const iphoneWait = !party && IS_IPHONE && !video.webkitDisplayingFullscreen;
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
  on(video, "webkitendfullscreen", () => !party && !done && !video.ended && showBtn("⛶  Full screen"));
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
