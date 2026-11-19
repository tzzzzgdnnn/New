// <webview> stand-in for iOS: the desktop app renders Electron <webview> tags;
// in WKWebView we fill each one with a sandboxed <iframe> inside the element's
// own box (no native view stacked over the web view). Sandbox without
// allow-popups / allow-top-navigation blocks popups and top-frame redirects.
import { mirrorsFor } from "./servers";
import { PLAYER_SOURCES, sourcesForContent } from "../../utils/api";

// Tell the native player what is playing (title, type, episode) and which
// servers it may offer in its own server switcher.
function postContext(url) {
  const h = window.webkit?.messageHandlers?.sbContext;
  if (!h || !url || url === "about:blank") return;
  let current = null;
  try {
    const raw = localStorage.getItem("streambert_playerSource");
    current = raw ? JSON.parse(raw) : null;
  } catch {}
  try {
    h.postMessage({
      url,
      current,
      ctx: window.__sbCtx || {},
      servers: sourcesForContent(!!(window.__sbCtx || {}).isAnime).filter((s) => !s.async).map((s) => ({
        id: s.id,
        label: s.label,
      })),
    });
  } catch {}
}

// Subtitle settings the native player needs: the Wyzie key (Keychain) and
// the preferred subtitle language from Settings.
async function subtitleContext() {
  let wyzieKey = null;
  try {
    wyzieKey = (await window.electron?.secureGet?.("wyzieApiKey")) || null;
  } catch {}
  let subLang = "en";
  try {
    const raw = localStorage.getItem("streambert_subtitleLang");
    if (raw) subLang = JSON.parse(raw) || "en";
  } catch {}
  return { wyzieKey, subLang };
}

const LOAD_TIMEOUT_MS = 8000;
const MAX_CANDIDATES = 5;

// ── Native playback ──────────────────────────────────────────────────────
// Every play goes to the native player: native loads the embed in a hidden
// web view, captures the stream and opens StreambertPlayer. Candidates are
// the chosen server first, then other enabled servers for the same title.
const pending = new Map(); // token -> callback(result)
window.__sbNativeResult = (r) => {
  const cb = r && pending.get(r.token);
  if (cb) {
    pending.delete(r.token);
    cb(r);
  }
};
let _onNativeClosed = null;
window.__sbNativeClosed = () => _onNativeClosed && _onNativeClosed();

const withParams = (src, url) => {
  try {
    const u = new URL(url);
    Object.entries(src.params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  } catch {
    return url;
  }
};

function buildCandidates(url) {
  const ctx = window.__sbCtx || {};
  let current = null;
  try {
    current = JSON.parse(localStorage.getItem("streambert_playerSource") || "null");
  } catch {}
  const cur = PLAYER_SOURCES.find((s) => s.id === current);
  const list = [{ id: cur?.id || "current", label: cur?.label || "Server", url }];
  for (const m of mirrorsFor(url)) list.push({ id: cur?.id || "current", label: cur?.label || "Server", url: m });
  const id = ctx.tmdbId;
  if (id) {
    for (const s of sourcesForContent(!!ctx.isAnime)) {
      if (list.length >= MAX_CANDIDATES) break;
      if (s.id === cur?.id || s.async || s.idType) continue;
      let u = null;
      try {
        if (ctx.type === "tv") {
          if (s.movieOnly || !s.tvUrl) continue;
          u = s.tvUrl(id, ctx.tmdbSeason ?? ctx.season ?? 1, ctx.tmdbEpisode ?? ctx.episode ?? 1);
        } else {
          u = s.movieUrl(id);
        }
      } catch {}
      if (u && /^https?:/.test(u)) list.push({ id: s.id, label: s.label, url: withParams(s, u) });
    }
  }
  return list;
}

const nativeAvailable = () => !!window.webkit?.messageHandlers?.sbResolve;

function upgrade(wv) {
  if (wv.__sbUpgraded) return;
  wv.__sbUpgraded = true;
  const iframe = document.createElement("iframe");
  iframe.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-forms allow-presentation",
  );
  iframe.setAttribute(
    "allow",
    "autoplay; fullscreen; picture-in-picture; encrypted-media",
  );
  iframe.setAttribute("allowfullscreen", "");
  iframe.setAttribute("playsinline", "");
  iframe.setAttribute("referrerpolicy", "origin");
  iframe.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;border:0;background:#000";
  wv.appendChild(iframe);

  let timer = null;
  let candidates = [];
  const fire = (name) => wv.dispatchEvent(new Event(name));

  // Placeholder shown in the web player box while/after native playback.
  const card = document.createElement("div");
  card.className = "sb-native-card";
  card.style.cssText =
    "position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#000;color:#d4d4d4;font:500 14px -apple-system,system-ui,sans-serif;text-align:center;padding:16px";
  const cardText = document.createElement("div");
  const cardBtn = document.createElement("button");
  cardBtn.textContent = "▶  Play";
  cardBtn.style.cssText =
    "min-height:44px;min-width:120px;padding:0 22px;border:0;border-radius:22px;background:#e50914;color:#fff;font:600 16px -apple-system,system-ui,sans-serif";
  card.append(cardText, cardBtn);
  wv.appendChild(card);
  const note = document.createElement("div");
  note.textContent = "Native player unavailable for this source";
  note.style.cssText =
    "position:absolute;left:8px;bottom:8px;padding:4px 10px;border-radius:12px;background:rgba(0,0,0,.7);color:#d4d4d4;font:500 12px -apple-system,system-ui,sans-serif;pointer-events:none;display:none";
  wv.appendChild(note);
  const showCard = (text, btn) => {
    cardText.textContent = text;
    cardBtn.style.display = btn ? "" : "none";
    card.style.display = "flex";
  };
  const hideCard = () => (card.style.display = "none");

  let nativeFor = null;
  const playNative = (url) => {
    const token = Math.random().toString(36).slice(2);
    nativeFor = url;
    iframe.src = "about:blank";
    showCard("Opening the native player…", false);
    note.style.display = "none";
    fire("dom-ready");
    fire("did-finish-load");
    pending.set(token, (r) => {
      if (nativeFor !== url) return;
      if (r.ok) {
        showCard("Playing in the native player", true);
      } else {
        // Every server failed natively: visible web player + small note.
        hideCard();
        nativeFor = null;
        loadUrl(url, false, true);
        note.style.display = "";
        setTimeout(() => (note.style.display = "none"), 5000);
      }
    });
    _onNativeClosed = () => {
      if (nativeFor === url) showCard("Playback closed", true);
    };
    // Let the page publish its context (title, ids) first.
    setTimeout(async () => {
      postContext(url);
      const subCtx = await subtitleContext();
      try {
        window.webkit.messageHandlers.sbResolve.postMessage({
          token,
          candidates: buildCandidates(url),
          ctx: { ...(window.__sbCtx || {}), ...subCtx },
          servers: sourcesForContent(!!(window.__sbCtx || {}).isAnime).filter((s) => !s.async).map((s) => ({ id: s.id, label: s.label })),
        });
      } catch {
        pending.delete(token);
        hideCard();
        loadUrl(url, false, true);
      }
    }, 60);
  };
  cardBtn.addEventListener("click", () => {
    const u = wv.getAttribute("src");
    if (u && u !== "about:blank") playNative(u);
  });

  const loadUrl = (url, isRetry, webOnly) => {
    if (!isRetry && !webOnly && url && url !== "about:blank" && nativeAvailable()) {
      clearTimeout(timer);
      playNative(url);
      return;
    }
    if (!url || url === "about:blank") {
      nativeFor = null;
      hideCard();
    }
    clearTimeout(timer);
    if (!isRetry) candidates = mirrorsFor(url);
    iframe.src = url || "about:blank";
    if (!url || url === "about:blank") return;
    postContext(url);
    timer = setTimeout(() => {
      // no load event in time -> next mirror, else report failure
      const next = candidates.shift();
      if (next) loadUrl(next, true);
      else fire("did-fail-load");
    }, LOAD_TIMEOUT_MS);
  };

  iframe.addEventListener("load", () => {
    if (!iframe.src || iframe.src === "about:blank") return;
    clearTimeout(timer);
    fire("dom-ready");
    fire("did-finish-load");
  });

  Object.defineProperty(wv, "src", {
    configurable: true,
    get: () => wv.getAttribute("src") || "",
    set: (v) => wv.setAttribute("src", v),
  });
  wv.executeJavaScript = (code) => {
    // Works only for same-origin frames; cross-origin embeds reject (callers catch).
    try {
      const w = iframe.contentWindow;
      return Promise.resolve(w.eval(code));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  wv.getWebContentsId = () => 0;
  wv.insertCSS = () => Promise.resolve();
  wv.getURL = () => iframe.src;
  wv.reload = () => loadUrl(wv.getAttribute("src"));

  new MutationObserver(() => loadUrl(wv.getAttribute("src"))).observe(wv, {
    attributes: true,
    attributeFilter: ["src"],
  });
  loadUrl(wv.getAttribute("src"));
}

export function installWebviewPolyfill() {
  const scan = (root) => {
    if (root.nodeType !== 1) return;
    if (root.tagName === "WEBVIEW") upgrade(root);
    root.querySelectorAll?.("webview").forEach(upgrade);
  };
  new MutationObserver((muts) =>
    muts.forEach((m) => m.addedNodes.forEach(scan)),
  ).observe(document.documentElement, { childList: true, subtree: true });
  scan(document.documentElement);
}
