// Site adder: the script the hidden web view (WKWebView on iPhone, a
// headless browser in the dev e2e test) runs at document start in every
// frame of a page it renders. It reports, through one channel:
//   { kind: "frame" }  what a frame holds: links, forms, inline scripts,
//                      iframes, server/mirror buttons, password fields
//   { kind: "api" }    JSON / text the page fetched (the site's own API)
//   { kind: "media" }  stream links the page requested or set on a <video>
//   { kind: "drm" }    the page asked for DRM (EME): such sites are refused
// With cfg.play it presses the player's play button so the stream request
// happens; with cfg.search it types the query into the site's search box.
// Ads: none of this opens pop-ups (window.open is a no-op); the app's own
// ad filter and domain lock stay in charge.

/** The collector, configured. `post` is the JS expression that sends one message. */
export function collectorScript({ play = false, search = null } = {}, post = "window.webkit.messageHandlers.sbCollect.postMessage") {
  const cfg = JSON.stringify({ play: !!play, search: search || null });
  return `(function () {
  if (window.__sbCollector) return;
  window.__sbCollector = true;
  var CFG = ${cfg};
  var send = function (m) { try { (${post})(m); } catch (e) {} };
  var top = window.top === window;
  try { window.open = function () { return null; }; } catch (e) {}
  var seen = {};
  function abs(u) { try { return new URL(String(u), location.href).href; } catch (e) { return null; } }
  function media(u, how) {
    try {
      if (!u) return; u = abs(u); if (!u || !/^https?:/i.test(u) || seen['m' + u]) return;
      var l = u.toLowerCase();
      if (!/\\.(m3u8|mp4|mpd|webm|m4v)(\\?|#|$)|mpegurl|\\/m3u8\\b/.test(l) && how !== 'manifest') return;
      if (/\\.(ts|m4s|jpg|png|vtt|srt)(\\?|#|$)/.test(l)) return;
      seen['m' + u] = 1;
      send({ kind: 'media', url: u, page: location.href, how: how || 'request' });
    } catch (e) {}
  }
  function api(u, method, status, ct, body, reqBody) {
    try {
      if (typeof body !== 'string' || !body) return;
      ct = String(ct || '').toLowerCase();
      var head = body.slice(0, 7);
      if (head === '#EXTM3U') { media(u, 'manifest'); return; }
      if (!/json|javascript|text\\/plain|text\\/html/.test(ct) && !/^\\s*[\\[{]/.test(body)) return;
      if (/text\\/html/.test(ct) && !/^\\s*[\\[{]/.test(body)) return;
      var a = abs(u); if (!a || seen['a' + a + (reqBody || '')]) return;
      seen['a' + a + (reqBody || '')] = 1;
      send({ kind: 'api', url: a, method: method || 'GET', status: status || 0, ct: ct, body: body.slice(0, 200000), reqBody: reqBody ? String(reqBody).slice(0, 2000) : null, page: location.href });
    } catch (e) {}
  }
  var of = window.fetch;
  if (of) window.fetch = function (i, init) {
    var u = typeof i === 'string' ? i : (i && i.url);
    var m = (init && init.method) || (i && i.method) || 'GET';
    var b = init && typeof init.body === 'string' ? init.body : null;
    media(u);
    var p = of.apply(this, arguments);
    try {
      p.then(function (r) {
        try {
          var ct = r.headers.get('content-type') || '';
          if (/mpegurl/i.test(ct)) { media(r.url || u, 'manifest'); return; }
          if (/image|video|audio|octet|font|css/i.test(ct)) return;
          r.clone().text().then(function (t) { api(r.url || u, m, r.status, ct, t, b); }).catch(function () {});
        } catch (e) {}
      }).catch(function () {});
    } catch (e) {}
    return p;
  };
  var xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__sb = { m: m, u: u }; media(u); return xo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    var x = this, info = x.__sb || {};
    try {
      x.addEventListener('load', function () {
        try {
          var ct = x.getResponseHeader('content-type') || '';
          if (/mpegurl/i.test(ct)) { media(x.responseURL || info.u, 'manifest'); return; }
          var t = (x.responseType === '' || x.responseType === 'text') ? x.responseText
            : (x.responseType === 'json' && x.response) ? JSON.stringify(x.response) : null;
          api(x.responseURL || info.u, info.m, x.status, ct, t, typeof body === 'string' ? body : null);
        } catch (e) {}
      });
    } catch (e) {}
    return xs.apply(this, arguments);
  };
  try {
    var d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (d && d.set) Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: true, get: d.get, set: function (v) { media(v, 'element'); return d.set.call(this, v); } });
  } catch (e) {}
  try {
    var _H;
    Object.defineProperty(window, 'Hls', { configurable: true, get: function () { return _H; }, set: function (v) {
      _H = v;
      try { var ls = v && v.prototype && v.prototype.loadSource; if (ls && !ls.__sb) { v.prototype.loadSource = function (u) { media(u, 'manifest'); return ls.apply(this, arguments); }; v.prototype.loadSource.__sb = 1; } } catch (e) {}
    } });
  } catch (e) {}
  try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { media(e.name); }); }).observe({ type: 'resource', buffered: true }); } catch (e) {}
  // DRM (EME): reported, never worked around.
  function drm(what) { send({ kind: 'drm', what: what, page: location.href }); }
  try {
    if (navigator.requestMediaKeySystemAccess) {
      var rk = navigator.requestMediaKeySystemAccess.bind(navigator);
      navigator.requestMediaKeySystemAccess = function (ks) { drm(String(ks)); return rk.apply(null, arguments); };
    }
    if (window.WebKitMediaKeys) {
      var WK = window.WebKitMediaKeys;
      window.WebKitMediaKeys = function (ks) { drm(String(ks)); return new WK(ks); };
      window.WebKitMediaKeys.isTypeSupported = WK.isTypeSupported;
    }
    var sk = HTMLMediaElement.prototype.setMediaKeys;
    if (sk) HTMLMediaElement.prototype.setMediaKeys = function () { drm('setMediaKeys'); return sk.apply(this, arguments); };
    var wsk = HTMLMediaElement.prototype.webkitSetMediaKeys;
    if (wsk) HTMLMediaElement.prototype.webkitSetMediaKeys = function () { drm('webkitSetMediaKeys'); return wsk.apply(this, arguments); };
  } catch (e) {}
  function text(el) { return String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim().slice(0, 120); }
  function snap() {
    try {
      var links = [], mirrors = [], forms = [], iframes = [], scripts = [], n = 0;
      document.querySelectorAll('a[href]').forEach(function (a) {
        if (links.length > 1500) return;
        var img = a.querySelector('img');
        links.push({ href: a.href, text: text(a) || a.getAttribute('title') || (img && (img.alt || img.title)) || '' });
      });
      document.querySelectorAll('[data-src],[data-link],[data-video],[data-embed],[data-url],[data-iframe],[data-server],[data-hash],[data-source],[data-file],option[value]').forEach(function (el) {
        if (mirrors.length > 60 || el.tagName === 'IMG' || el.tagName === 'SCRIPT') return;
        var v = null, ks = ['data-embed','data-link','data-video','data-iframe','data-url','data-src','data-source','data-file','data-server','data-hash','value'];
        for (var i = 0; i < ks.length && !v; i++) { var x = el.getAttribute(ks[i]); if (x && x.length > 6) v = x; }
        if (v) mirrors.push({ label: text(el).slice(0, 40), value: v, attr: el.tagName.toLowerCase() });
      });
      document.querySelectorAll('form').forEach(function (f) {
        var inputs = [];
        f.querySelectorAll('input,select,textarea').forEach(function (i) { inputs.push({ name: i.name || '', type: (i.type || '').toLowerCase(), placeholder: i.placeholder || '', value: i.type === 'hidden' ? i.value : '' }); });
        forms.push({ action: f.action || location.href, method: (f.getAttribute('method') || 'get').toLowerCase(), inputs: inputs });
      });
      document.querySelectorAll('iframe').forEach(function (f) { var s = f.getAttribute('src') || f.getAttribute('data-src'); if (s) iframes.push(abs(s)); });
      document.querySelectorAll('script').forEach(function (s) {
        if (n > 600000) return;
        if (s.src) { scripts.push('/*src:' + s.src + '*/'); return; }
        var t = s.textContent || ''; n += t.length; scripts.push(t);
      });
      var html = document.documentElement ? document.documentElement.outerHTML : '';
      send({ kind: 'frame', top: top, url: location.href, title: document.title || '', html: html.slice(0, top ? 800000 : 300000),
        links: links, mirrors: mirrors, forms: forms, iframes: iframes, scripts: scripts.join('\\n;\\n').slice(0, 800000),
        password: !!document.querySelector('input[type=password]'),
        videos: Array.prototype.map.call(document.querySelectorAll('video'), function (v) { return v.currentSrc || v.src || ''; }) });
    } catch (e) {}
  }
  window.__sbSnap = snap;
  function nudge() {
    var tries = 0, iv = setInterval(function () {
      tries++;
      try {
        document.querySelectorAll('video,audio').forEach(function (v) {
          v.muted = true; v.volume = 0;
          if (v.currentSrc) media(v.currentSrc, 'element');
          if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        });
        if (tries % 2 === 0) {
          var b = document.querySelector('.vjs-big-play-button,.jw-icon-display,.jw-display-icon-container,.plyr__control--overlaid,'
            + 'button[aria-label*="play" i],[class*="play-button" i],[class*="playbtn" i],[class*="btn-play" i],'
            + '[id*="play" i]:not(video),.play,.play-icon,.art-control-play,.vds-play-button,media-play-button');
          if (b && b.offsetParent !== null) b.click();
        }
      } catch (e) {}
      if (tries > 20) clearInterval(iv);
    }, 600);
  }
  function typeSearch() {
    try {
      var q = CFG.search, el = null;
      var sel = ['input[type=search]','input[name=s]','input[name=q]','input[name=query]','input[name=keyword]','input[name=search]','input[name=k]','input[name=term]','input[placeholder*="search" i]','input[aria-label*="search" i]'];
      for (var i = 0; i < sel.length && !el; i++) el = document.querySelector(sel[i]);
      if (!el) { send({ kind: 'search', ok: false }); return; }
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, q);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'e' }));
      send({ kind: 'search', ok: true, name: el.name || '' });
      setTimeout(function () {
        try {
          el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }));
          var f = el.form;
          if (f) { if (f.requestSubmit) f.requestSubmit(); else f.submit(); }
        } catch (e) {}
      }, 1200);
    } catch (e) {}
  }
  function ready() {
    snap();
    setTimeout(snap, 1500);
    setTimeout(snap, 4000);
    if (CFG.play) nudge();
    var typed = false; try { typed = sessionStorage.getItem('__sbTyped') === '1'; sessionStorage.setItem('__sbTyped', '1'); } catch (e) {}
    if (CFG.search && top && !typed) setTimeout(typeSearch, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();`;
}
