// Custom servers: what the hidden page does to get a stream going, injected
// into every frame (top page and nested iframes) of the hidden web view on
// iPhone (StreamSniffer in StreambertPlayer.swift carries an exact copy, kept
// in sync by scripts/test-custom-discover.mjs) and into the headless browser
// of the site corpus run (scripts/corpus-custom-sites.mjs).
//
// Every 700 ms, for the whole try (not just the first seconds):
//  1. keeps <video>/<audio> muted and calls play();
//  2. presses the player's play button: a learned label first (the site's
//     recipe, window.__sbTap), then known player classes, then buttons whose
//     text says Play / Watch / Start playback, then a big centred overlay;
//  3. when nothing streamed after a few presses, presses the page's server /
//     source / mirror buttons one by one ("Server 1", "Vidplay", …);
//     With window.__sbTapOnly (one of the site's servers, picked in Super
//     Player) only that server's button is pressed, never the others;
//  4. reports the site's server list ({kind:'servers', labels}), what it pressed ({kind:'tap', label}) so the site's recipe can
//     keep it, and a human check it sees ({kind:'wall', wall}), which it never
//     presses: those are for a person (Cloudflare Turnstile, hCaptcha,
//     reCAPTCHA).
// window.open stays a no-op, so a press never opens an ad tab.
//
// `post(obj)` must be defined by the host before this runs; `window.__sbGot`
// is set by the host's sniffer once a stream was seen in this frame.

export const NUDGE_JS = String.raw`
(function () {
  if (window.__sbNudge) return;
  window.__sbNudge = true;
  try { window.open = function () { return null; }; } catch (e) {}
  var PLAY_SEL = '.vjs-big-play-button,.jw-icon-display,.jw-display-icon-container,.plyr__control--overlaid,'
    + '.art-control-play,.vds-play-button,media-play-button,.fp-play,.mejs__overlay-play,.dplayer-mobile-play,'
    + '.play-button,.playbtn,.btn-play,.play-btn,.big-play,.play-icon,.icon-play,#play,#playButton,#player-button,'
    + 'button[aria-label*="play" i],[role=button][aria-label*="play" i],[class*="play-button" i],[class*="playbtn" i],'
    + '[class*="btn-play" i],[class*="play_button" i],[class*="PlayButton"],[data-testid*="play" i],[title="Play" i]';
  var PLAY_TEXT = /^\s*(▶|►|⏵)?\s*(play( now| movie| episode| video)?|watch( now| movie| episode| online| free)?|start( watching| playback| streaming)?|start .{0,24}playback|click (here )?to (play|watch)|tap to (play|watch)|resume|stream now|load (the )?player)\s*[!.]?\s*$/i;
  var SERVER_TEXT = /^\s*(server|source|mirror|provider|player|link|host)\s*#?\s*\d{0,2}\b|^\s*(vid|up|stream|dood|filemoon|mixdrop|voe|mp4|hls|embed|super|vip|hd|4k|auto|main|backup|alpha|beta|nova|orion|evion|citadel|fast|flix)[a-z0-9 ._-]{0,18}$/i;
  var BAD_TEXT = /download|subscribe|sign ?in|log ?in|register|premium|vpn|install|app|close|share|report|trailer|discord|telegram|donate|cookie|accept|login|next|prev|season|episode \d+ of|more/i;
  var WALL_SRC = /challenges\.cloudflare\.com\/(cdn-cgi\/challenge-platform|turnstile)|hcaptcha\.com\/(captcha|checksiteconfig)|google\.com\/recaptcha|recaptcha\.net\/recaptcha/i;
  var top = window.top === window;
  var tries = 0, presses = 0, serverIdx = 0, sentWall = false, pressed = {}, sentServers = '';
  var only = !!window.__sbTapOnly;
  function post(o) { try { if (typeof window.__sbPost === 'function') window.__sbPost(o); } catch (e) {} }
  function visible(el) {
    try {
      if (!el || !el.getBoundingClientRect) return false;
      var r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || 1) > 0.05;
    } catch (e) { return false; }
  }
  function label(el) {
    var t = '';
    try { t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) {}
    if (!t || t.length > 40) t = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-name') || '') || t;
    return String(t || '').slice(0, 40);
  }
  function press(el, why) {
    try {
      var l = label(el) || why;
      var r = el.getBoundingClientRect();
      var o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      try { el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mousedown', o)); el.dispatchEvent(new MouseEvent('mouseup', o)); } catch (e) {}
      el.click();
      presses++;
      post({ kind: 'tap', label: l, why: why, page: location.href });
      return true;
    } catch (e) { return false; }
  }
  function clickables() {
    var out = [];
    try {
      document.querySelectorAll('button,[role=button],a,div[onclick],span[onclick],li[onclick],[data-server],[data-id][class*="server" i],[class*="server" i] li,[class*="server" i] a,[class*="server" i] button,[class*="source" i] button,[class*="source" i] li').forEach(function (el) {
        if (out.indexOf(el) < 0 && visible(el)) out.push(el);
      });
    } catch (e) {}
    return out;
  }
  function wall() {
    if (sentWall) return true;
    try {
      var f = document.querySelectorAll('iframe[src]');
      for (var i = 0; i < f.length; i++) {
        if (WALL_SRC.test(f[i].src) && visible(f[i])) {
          sentWall = true;
          var s = f[i].src;
          post({ kind: 'wall', wall: /hcaptcha/i.test(s) ? 'hCaptcha' : /recaptcha/i.test(s) ? 'reCAPTCHA' : 'Cloudflare Turnstile', page: location.href });
          return true;
        }
      }
      if (top && /just a moment|attention required|verify you are human|checking your browser/i.test(document.title || '')) {
        sentWall = true; post({ kind: 'wall', wall: 'Cloudflare', page: location.href }); return true;
      }
    } catch (e) {}
    return false;
  }
  function step() {
    tries++;
    try {
      document.querySelectorAll('video,audio').forEach(function (v) {
        v.muted = true; v.volume = 0;
        if (v.paused && !v.ended) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
      });
    } catch (e) {}
    var els = tries % 2 === 0 || tries === 4 ? clickables() : null;
    // The site's own server list, reported once it settles (and again if it changes).
    if (tries >= 4 && tries % 4 === 0 && els) {
      var names = [];
      els.forEach(function (el) { var s = label(el); if (s && SERVER_TEXT.test(s) && !BAD_TEXT.test(s) && names.indexOf(s) < 0) names.push(s); });
      var sig = names.slice(0, 12).join('|');
      if (names.length && sig !== sentServers) { sentServers = sig; post({ kind: 'servers', labels: names.slice(0, 12), page: location.href }); }
    }
    if (window.__sbGot) return;
    if (wall()) return;
    if (tries % 2 !== 0 || !els) return;
    // 1. The recipe's own button.
    var hint = window.__sbTap;
    if (hint) {
      for (var i = 0; i < els.length; i++) {
        if (label(els[i]).toLowerCase() === String(hint).toLowerCase() && (pressed[label(els[i])] || 0) < 3) {
          pressed[label(els[i])] = (pressed[label(els[i])] || 0) + 1;
          if (press(els[i], 'recipe')) return;
        }
      }
    }
    // 2. Known player buttons.
    try {
      var known = document.querySelectorAll(PLAY_SEL);
      for (var k = 0; k < known.length; k++) {
        var key = 'sel' + k;
        if (visible(known[k]) && (pressed[key] || 0) < 3 && known[k].tagName !== 'VIDEO') {
          pressed[key] = (pressed[key] || 0) + 1;
          if (press(known[k], 'player')) return;
        }
      }
    } catch (e) {}
    // 3. Buttons that say Play / Watch / Start playback.
    for (var j = 0; j < els.length; j++) {
      var t = label(els[j]);
      if (t && PLAY_TEXT.test(t) && !BAD_TEXT.test(t) && (pressed['t' + t] || 0) < 2) {
        pressed['t' + t] = (pressed['t' + t] || 0) + 1;
        if (press(els[j], 'play-text')) return;
      }
    }
    // 4. Server / source buttons, one each time, after the play presses had their chance.
    if (tries >= 6 && !only) {
      var servers = els.filter(function (el) { var s = label(el); return s && SERVER_TEXT.test(s) && !BAD_TEXT.test(s) && !(el.tagName === 'A' && /^https?:/.test(el.getAttribute('href') || '') && el.host !== location.host); });
      if (servers.length && tries % 6 === 0) {
        var el = servers[serverIdx % servers.length];
        serverIdx++;
        if (serverIdx <= servers.length * 2 && press(el, 'server')) return;
      }
    }
    // 5. A big centred overlay (poster with a play glyph), once in a while.
    if (tries % 8 === 4 && tries <= 40) {
      try {
        var w = innerWidth, h = innerHeight;
        var c = document.elementFromPoint(w / 2, h / 2);
        if (c && c.tagName !== 'IFRAME' && c.tagName !== 'VIDEO' && c !== document.body && c !== document.documentElement) {
          var r = c.getBoundingClientRect();
          if (r.width > w * 0.3 && r.height > h * 0.15) press(c, 'center');
        }
      } catch (e) {}
    }
  }
  setInterval(step, 700);
})();
`;

/** The labels of human checks the nudge reports and never presses. */
export const HUMAN_CHECKS = Object.freeze(["Cloudflare Turnstile", "Cloudflare", "hCaptcha", "reCAPTCHA"]);
