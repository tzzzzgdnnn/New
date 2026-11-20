// Watch Together adapter for the web app's direct player (an HTML5 <video>,
// see src/platform/web/directPlayer.js). Embed players (iframes) can't be
// driven from the page, so a party plays on the direct stream.
// Contract: see the header of ../engine.js.
//
// Only an explicit Pause from this viewer is sent to the room as a pause:
// buffering, the tab going to the background or the chat keyboard opening
// never are (the engine catches this phone back up on its own).

// The party player: the page's direct-stream <video> on screen, never the
// hidden warm-up copy (directPlayer's prewarm), which would otherwise be
// driven and reported as "this title is open" before anyone pressed play.
const findVideo = () => {
  for (const v of document.querySelectorAll("video.sb-direct-video")) {
    if (v.isConnected && !v.closest("[data-sb-warm]")) return v;
  }
  return null;
};

/**
 * play() that never leaves a party phone stuck: a browser that refuses to
 * start with sound (iPhone Safari / a fresh desktop tab, no tap on this
 * video yet) starts it muted instead, so it still plays in sync, and
 * `onMuted` offers a "Tap for sound" button.
 */
export function playSafe(v, onMuted) {
  let p;
  try {
    p = v.play();
  } catch {
    p = null;
  }
  if (!p || typeof p.catch !== "function") return Promise.resolve();
  return p.catch((e) => {
    if (e?.name !== "NotAllowedError" || v.muted) return;
    v.muted = true;
    onMuted?.();
    return Promise.resolve(v.play()).catch(() => {});
  });
}

export function createWebAdapter({ getKey, getVideo = findVideo } = {}) {
  let video = null;
  let applying = 0; // > 0 while the engine drives the player (its events aren't the viewer's taps)
  let startTimer = null;
  let seeking = false;
  let userTapAt = 0;

  const drive = (fn) => {
    applying++;
    try {
      fn();
    } finally {
      setTimeout(() => applying--, 250);
    }
  };

  // A real pointer / key press just before a play/pause/seek event is the viewer;
  // anything else (stalls, visibility, the engine) is not.
  const markTap = () => (userTapAt = Date.now());
  const isViewer = () => applying === 0 && Date.now() - userTapAt < 1500;

  const onPlay = () => {
    if (!isViewer()) return;
    // Hold locally until the room's synchronized start arrives.
    drive(() => video.pause());
    adapter.onIntent?.({ action: "play", pos: video.currentTime });
  };
  const onPause = () => {
    if (!isViewer() || video.ended) return;
    adapter.onIntent?.({ action: "pause", pos: video.currentTime });
  };
  const onSeeking = () => {
    seeking = true;
    if (isViewer()) adapter.onIntent?.({ action: "seek", pos: video.currentTime });
  };
  const onSeeked = () => (seeking = false);
  const onRate = () => {
    if (isViewer()) adapter.onIntent?.({ action: "rate", rate: video.playbackRate });
  };

  const attach = () => {
    const v = getVideo();
    if (v === video) return video;
    detach();
    video = v;
    if (!video) return null;
    for (const t of ["pointerdown", "keydown", "touchstart", "click"]) video.addEventListener(t, markTap, true);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("ratechange", onRate);
    // Party player: plays inline next to the chat; full screen is a toggle,
    // and coming out of full screen keeps the movie playing.
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.addEventListener("webkitendfullscreen", onExitFs);
    document.addEventListener("fullscreenchange", onExitFs);
    document.addEventListener("webkitfullscreenchange", onExitFs);
    return video;
  };

  // Muted autostart: one tap anywhere on the button brings the sound back
  // (inside a tap, so every browser allows it). Never pauses anything.
  let soundBtn = null;
  const offerSound = () => {
    const v = video;
    if (!v || soundBtn) return;
    const b = document.createElement("button");
    b.className = "sb-direct-ui wp-sound";
    b.textContent = "🔇  Tap for sound";
    b.style.cssText =
      "position:absolute;left:12px;bottom:56px;z-index:7;padding:10px 16px;border-radius:20px;border:0;background:rgba(229,9,20,.94);color:#fff;font:600 15px -apple-system,system-ui,sans-serif";
    b.onclick = (e) => {
      e.stopPropagation();
      v.muted = false;
      if (v.paused && adapter.roomPlaying?.()) drive(() => v.play().catch(() => {}));
      b.remove();
      soundBtn = null;
    };
    (v.parentElement || document.body).appendChild(b);
    soundBtn = b;
  };

  const onExitFs = () => {
    const v = video;
    if (!v || document.fullscreenElement || document.webkitFullscreenElement) return;
    // Some browsers (iPhone Safari) pause when full screen ends: carry on.
    setTimeout(() => {
      if (v.paused && adapter.roomPlaying?.()) drive(() => playSafe(v, offerSound));
    }, 50);
  };

  const detach = () => {
    if (!video) return;
    video.removeEventListener("webkitendfullscreen", onExitFs);
    document.removeEventListener("fullscreenchange", onExitFs);
    document.removeEventListener("webkitfullscreenchange", onExitFs);
    for (const t of ["pointerdown", "keydown", "touchstart", "click"]) video.removeEventListener(t, markTap, true);
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("seeking", onSeeking);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("ratechange", onRate);
    video = null;
  };

  const bufferedAhead = (v) => {
    const t = v.currentTime;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= t + 0.1 && v.buffered.end(i) > t) return v.buffered.end(i) - t;
    }
    return 0;
  };

  const adapter = {
    onIntent: null,
    read() {
      const v = attach();
      if (!v) return { key: null, ready: false, seeking: false, status: "paused", pos: 0, sampledAt: Date.now(), rate: 1 };
      const waiting = !v.paused && v.readyState < 3;
      return {
        key: getKey?.() ?? null,
        ready: v.readyState >= 3 || bufferedAhead(v) >= 2,
        seeking: seeking || v.seeking,
        status: v.paused ? "paused" : waiting ? "waiting" : "playing",
        pos: v.currentTime,
        sampledAt: Date.now(),
        rate: v.playbackRate || 1,
      };
    },
    pause(pos) {
      const v = attach();
      if (!v) return;
      clearTimeout(startTimer);
      drive(() => {
        v.pause();
        if (Number.isFinite(pos) && Math.abs(v.currentTime - pos) > 0.03) v.currentTime = pos;
      });
    },
    playAt(pos, atLocal, rate = 1) {
      const v = attach();
      if (!v) return;
      clearTimeout(startTimer);
      drive(() => {
        v.playbackRate = rate;
        const wait = atLocal - Date.now();
        if (wait > 0) {
          v.pause();
          v.currentTime = pos;
          startTimer = setTimeout(() => drive(() => playSafe(v, offerSound)), wait);
        } else {
          v.currentTime = pos + (-wait / 1000) * rate;
          playSafe(v, offerSound);
        }
      });
    },
    setRate(r) {
      const v = attach();
      if (v) drive(() => (v.playbackRate = r));
    },
    seekTo(pos) {
      const v = attach();
      if (v) drive(() => (v.currentTime = pos));
    },
    /** Full screen on / off for the party player (never pauses). */
    toggleFullscreen() {
      const v = attach();
      if (!v) return;
      const box = v.parentElement || v;
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      if (fs) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      else if (box.requestFullscreen || box.webkitRequestFullscreen) (box.requestFullscreen || box.webkitRequestFullscreen).call(box);
      else v.webkitEnterFullscreen?.(); // iPhone Safari: Apple's own full screen
    },
    /** Volume while someone is talking (voice ducking). */
    setDuck(level) {
      const v = attach();
      if (!v) return;
      if (adapter.baseVolume == null) adapter.baseVolume = v.volume;
      const base = adapter.baseVolume;
      const target = Math.max(0, Math.min(1, base * level));
      // Glide over ~250 ms. (iPhone Safari ignores page volume changes; the
      // iPhone app's native player ducks instead.)
      clearInterval(adapter.duckTimer);
      const from = v.volume;
      let i = 0;
      adapter.duckTimer = setInterval(() => {
        i += 1;
        v.volume = from + (target - from) * Math.min(1, i / 10);
        if (i >= 10) {
          clearInterval(adapter.duckTimer);
          if (level >= 1) adapter.baseVolume = null;
        }
      }, 25);
    },
    end() {
      clearTimeout(startTimer);
      soundBtn?.remove();
      soundBtn = null;
      detach();
    },
  };
  return adapter;
}
