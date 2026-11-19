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

/**
 * Play `src` inside `box`. Calls onFail() if nothing plays within `timeoutMs`
 * or on a fatal error. Returns a stop() function.
 */
export function playDirect(box, src, { startAt = 0, onFail, onTime, timeoutMs = 12000, nativeOnly = false } = {}) {
  const video = document.createElement("video");
  video.className = "sb-direct-video";
  video.controls = true;
  // iPhone: no playsinline, so play() opens Apple's own full-screen player.
  const isIPhone = /iPhone|iPod/.test(navigator.userAgent);
  const nativeHls = !!video.canPlayType("application/vnd.apple.mpegurl");
  video.playsInline = !isIPhone;
  if (!isIPhone) video.setAttribute("playsinline", "");
  // iPhone: Apple's full-screen player only opens from a tap, so we wait for one.
  video.autoplay = !isIPhone;
  video.preload = "auto";
  // Required for ManagedMediaSource (hls.js on iPhone, iOS 17.1+).
  video.disableRemotePlayback = true;
  try { video.playbackRate = Number(localStorage.getItem("sbWebRate")) || 1; } catch {}
  video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;background:#000;object-fit:contain;z-index:3";
  box.appendChild(video);
  let done = false;
  let hls = null;
  const fail = (why) => {
    if (done) return;
    stop();
    onFail?.(why);
  };
  const timer = setTimeout(() => !(video.currentTime > 0) && fail("timeout"), timeoutMs);
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
    video.play().catch(() => {});
  };
  if (nativeHls && (isIPhone || nativeOnly)) {
    // Safari's own HLS (Apple's player, like the app): fastest start. If it
    // can't read this host's segments, hls.js takes over.
    video.src = src;
    video.addEventListener("error", () => {
      if (done || hls) return;
      if (Hls.isSupported() && !nativeOnly) { video.removeAttribute("src"); video.load(); startHls(); }
      else fail("video error");
    });
  } else if (Hls.isSupported()) {
    startHls();
  } else {
    video.src = src;
    video.addEventListener("error", () => fail("video error"));
  }
  if (startAt > 0) video.addEventListener("loadedmetadata", () => (video.currentTime = startAt), { once: true });
  // iPhone: open Apple's own full-screen player as soon as the stream plays.
  const goFull = () => {
    try {
      if (isIPhone && video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else (video.requestFullscreen || video.webkitRequestFullscreen)?.call(video)?.catch?.(() => {});
    } catch {}
  };
  // play() right now, inside the Play tap when the stream was already known,
  // so iPhone opens its own full-screen player; else on canplay; if the
  // browser still blocks it, one tap on the button.
  if (!isIPhone) video.play().catch(() => {});
  video.addEventListener("canplay", () => {
    if (isIPhone) return;
    if (!video.paused) return;
    video.play().then(() => !isIPhone && goFull()).catch(() => {
      // Autoplay blocked: one tap starts it, full screen.
      fullBtn.textContent = "▶  Play";
      fullBtn.style.display = "";
    });
  }, { once: true });
  const fullBtn = document.createElement("button");
  fullBtn.textContent = "⛶  Full screen";
  fullBtn.style.cssText = "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:4;padding:12px 22px;border-radius:24px;border:0;background:rgba(229,9,20,.92);color:#fff;font-size:16px;font-weight:600;display:none";
  fullBtn.onclick = () => {
    fullBtn.style.display = "none";
    // Inside the tap: play, then Apple's player (iPhone needs both in the gesture).
    const p = video.play();
    goFull();
    p?.catch?.(() => { fullBtn.textContent = "▶  Play"; fullBtn.style.display = ""; });
  };
  if (isIPhone) {
    fullBtn.textContent = "▶  Play";
    fullBtn.style.cssText += ";font-size:20px;padding:16px 34px";
    fullBtn.style.display = "";
    clearTimeout(timer);
  }
  box.appendChild(fullBtn);
  // iPhone: if it started inline (no tap left to use), try Apple's full-screen
  // player at once, and keep a big Full screen button up until it's on.
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
  video.addEventListener("timeupdate", () => onTime?.(video.currentTime, video.duration));
  function stop() {
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
