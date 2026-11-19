// <webview> stand-in for iOS. The desktop app renders Electron <webview> tags;
// in WKWebView each one gets a sandboxed <iframe> inside the element's own box
// (no native view stacked over the web view). The sandbox has no
// allow-popups / allow-top-navigation, which blocks popups and redirects.
//
// When the native bridge is available, every play is handed to the native
// player instead: it loads the embeds in a hidden web view, captures the
// stream and plays it in StreambertPlayer. The iframe is only the fallback.
import { mirrorsFor } from "./servers";
import { PLAYER_SOURCES, sourcesForContent, nativeServerList } from "../../utils/api";
import { formatClock, getResumeSeconds, MIN_RESUME_SECONDS } from "./resume";

const LOAD_TIMEOUT_MS = 8000;
const MAX_CANDIDATES = 10;
const SELECT_RETRY_MS = 700;
const SELECT_RETRIES = 4;

const log = (...args) => console.log("[native]", ...args);

/** Read a JSON value the app stored with storage.set (streambert_ prefix). */
function readStored(key, fallback = null) {
  try {
    const raw = localStorage.getItem("streambert_" + key);
    return raw ? (JSON.parse(raw) ?? fallback) : fallback;
  } catch {
    return fallback;
  }
}

const currentCtx = () => window.__sbCtx || {};
const dubModeOf = (ctx) => (ctx.dubMode === "dub" ? "dub" : "sub");
const isBlank = (url) => !url || url === "about:blank";
const nativeAvailable = () => !!window.webkit?.messageHandlers?.sbResolve;

/** Server list for the native server menu, built from the latest context. */
function serverListFor(ctx) {
  return nativeServerList(!!ctx.isAnime, dubModeOf(ctx));
}

/**
 * Id of the playing server as the native menu knows it: anime servers carry
 * the audio mode ("vidnest:dub"), everything else is the plain id.
 */
function menuId(sourceId, ctx) {
  return ctx.isAnime && sourceId ? `${sourceId}:${dubModeOf(ctx)}` : sourceId;
}

// Tell the native player what is playing (title, type, episode) and which
// servers it may offer in its own server switcher.
function postContext(url) {
  const h = window.webkit?.messageHandlers?.sbContext;
  if (!h || isBlank(url)) return;
  const ctx = currentCtx();
  try {
    h.postMessage({
      url,
      current: menuId(readStored("playerSource"), ctx),
      ctx,
      servers: serverListFor(ctx),
    });
  } catch (e) {
    console.warn("[native] sbContext failed", e);
  }
}

// Subtitle settings the native player needs: the Wyzie key (Keychain) and
// the preferred subtitle language from Settings.
async function subtitleContext() {
  let wyzieKey = null;
  try {
    wyzieKey = (await window.electron?.secureGet?.("wyzieApiKey")) || null;
  } catch (e) {
    console.warn("[native] could not read the Wyzie key", e);
  }
  return { wyzieKey, subLang: readStored("subtitleLang", "en") || "en" };
}

const withParams = (src, url) => {
  try {
    const u = new URL(url);
    Object.entries(src.params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  } catch {
    return url;
  }
};

/** TMDB-route URL of a source for the current title, or null. */
function tmdbUrl(src, ctx) {
  const id = ctx.tmdbId;
  if (!id) return null;
  try {
    if (ctx.type === "tv") {
      if (src.movieOnly || !src.tvUrl) return null;
      const season = ctx.tmdbSeason ?? ctx.season ?? 1;
      const episode = ctx.tmdbEpisode ?? ctx.episode ?? 1;
      return withParams(src, src.tvUrl(id, season, episode));
    }
    return withParams(src, src.movieUrl(id));
  } catch {
    return null;
  }
}

/**
 * Ordered list of embeds the native player tries: the page's current server
 * (and its mirrors) first, then the anime routes for the chosen Sub/Dub mode,
 * then every other server for this kind of content. Ids match the native
 * server menu so the playing server gets its checkmark.
 */
function buildCandidates(url) {
  const ctx = currentCtx();
  const isAnime = !!ctx.isAnime;
  const mode = dubModeOf(ctx);
  const suffix = mode === "dub" ? " · Dub" : " · Sub";
  const cur = PLAYER_SOURCES.find((s) => s.id === readStored("playerSource"));
  const list = [];
  const seen = new Set();
  const add = (src, u) => {
    if (!u || !/^https?:/.test(u) || seen.has(u) || list.length >= MAX_CANDIDATES) return;
    seen.add(u);
    const id = src ? menuId(src.id, ctx) : "current";
    const label = (src?.label || "Server") + (isAnime && src ? suffix : "");
    list.push({ id, label, url: u });
  };
  const sources = sourcesForContent(isAnime).filter((s) => !s.async && !s.idType);
  const animeRoute = (s) => {
    if (!isAnime || !s.animeUrl || !ctx.anilistId) return null;
    try {
      return s.animeUrl(ctx.anilistId, ctx.episode ?? 1, mode);
    } catch {
      return null;
    }
  };

  // Dub for anime: only the anime routes (AniList id + "dub") carry dubbed
  // audio. TMDB-route servers only have the subbed version, so they are
  // never tried in Dub mode, or Dub would silently play Sub.
  const dubOnly = isAnime && mode === "dub";
  const curIsAnimeRoute = !!(cur?.animeUrl && ctx.anilistId);

  if (dubOnly) {
    // The picked server first, only when it is an anime route.
    if (cur && curIsAnimeRoute) add(cur, animeRoute(cur));
    for (const s of sources) add(s, animeRoute(s));
    return list;
  }

  // 1. The server the viewer picked (the page already built its URL).
  if (!isBlank(url)) {
    add(cur, url);
    for (const m of mirrorsFor(url)) add(cur, m);
  }
  // 2. Anime routes (AniList id + chosen mode).
  for (const s of sources) add(s, animeRoute(s));
  // 3. Every other server by TMDB id.
  for (const s of sources) {
    if (!animeRoute(s)) add(s, tmdbUrl(s, ctx));
  }
  return list;
}

// ── Native playback bookkeeping ──────────────────────────────────────────
const pending = new Map(); // token -> callback(result)
window.__sbNativeResult = (r) => {
  const cb = r && pending.get(r.token);
  if (!cb) return;
  pending.delete(r.token);
  cb(r);
};
let onNativeClosed = null;
/** Native player closed by the viewer; `info.time` is where it stopped. */
window.__sbNativeClosed = (info) => onNativeClosed?.(info || {});
/** Position reports from the native player; App.jsx saves them. */
window.__sbNativeProgress = (report) =>
  window.dispatchEvent(new CustomEvent("sb-native-progress", { detail: report }));

// Window-level events served by every upgraded <webview> still in the page:
//  sb-select-server  a server was picked in the native player
//  sb-replay         the page's Play/Resume button was pressed again
const targets = new Set();
const forEachTarget = (fn) => {
  for (const t of [...targets]) {
    if (!t.wv.isConnected) targets.delete(t);
    else fn(t);
  }
};
window.addEventListener("sb-select-server", () => forEachTarget((t) => t.onSelect()));
window.addEventListener("sb-replay", () => forEachTarget((t) => t.onReplay()));

function upgrade(wv) {
  if (wv.__sbUpgraded) return;
  wv.__sbUpgraded = true;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-presentation");
  iframe.setAttribute("allow", "autoplay; fullscreen; picture-in-picture; encrypted-media");
  iframe.setAttribute("allowfullscreen", "");
  iframe.setAttribute("playsinline", "");
  iframe.setAttribute("referrerpolicy", "origin");
  iframe.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;background:#000";
  wv.appendChild(iframe);

  let timer = null;
  let mirrors = [];
  const fire = (name) => wv.dispatchEvent(new Event(name));

  // Placeholder shown in the web player box while/after native playback.
  const card = document.createElement("div");
  card.className = "sb-native-card";
  const cardText = document.createElement("div");
  const cardBtn = document.createElement("button");
  cardBtn.className = "sb-native-play";
  cardBtn.textContent = "▶  Play";
  card.append(cardText, cardBtn);
  wv.appendChild(card);
  const note = document.createElement("div");
  note.className = "sb-native-note";
  note.textContent = "Native player unavailable for this source";
  wv.appendChild(note);
  const showCard = (text, withButton) => {
    cardText.textContent = text;
    cardBtn.style.display = withButton ? "" : "none";
    card.style.display = "flex";
  };
  const hideCard = () => (card.style.display = "none");

  let nativeFor = null; // URL the native player is handling
  let nativeToken = null;
  let lastNativeAt = 0;

  const playNative = (url) => {
    // A newer play replaces the previous request; drop its callback.
    if (nativeToken) pending.delete(nativeToken);
    const token = Math.random().toString(36).slice(2);
    nativeToken = token;
    lastNativeAt = Date.now();
    nativeFor = url;
    clearTimeout(timer);
    iframe.src = "about:blank";
    cardBtn.textContent = "▶  Play";
    showCard("Opening the native player…", false);
    note.style.display = "none";
    fire("dom-ready");
    fire("did-finish-load");
    pending.set(token, (r) => {
      if (nativeFor !== url || nativeToken !== token) return;
      if (r.ok) {
        log("playing", r.server);
        showCard("Playing in the native player", true);
        return;
      }
      // Every server failed natively: visible web player + a short note.
      log("all servers failed, showing the web player");
      hideCard();
      nativeFor = null;
      loadUrl(url, { webOnly: true });
      note.style.display = "";
      setTimeout(() => (note.style.display = "none"), 5000);
    });
    onNativeClosed = ({ time }) => {
      if (nativeFor !== url) return;
      const t = Number(time) || 0;
      showCard(t >= MIN_RESUME_SECONDS ? `Resume from ${formatClock(t)}` : "Ready to play", true);
      cardBtn.textContent = t >= MIN_RESUME_SECONDS ? "▶  Resume" : "▶  Play";
    };
    // Give the page a tick to publish its context (title, ids, Sub/Dub).
    setTimeout(async () => {
      if (nativeToken !== token) return;
      postContext(url);
      const subCtx = await subtitleContext();
      if (nativeToken !== token) return;
      const ctx = currentCtx();
      const startAt = getResumeSeconds(ctx.progressKey);
      const candidates = buildCandidates(url);
      log("resolve", candidates.map((c) => `${c.id} ${c.url}`));
      try {
        window.webkit.messageHandlers.sbResolve.postMessage({
          token,
          candidates,
          ctx: { ...ctx, ...subCtx, startAt },
          current: candidates[0]?.id ?? null,
          servers: serverListFor(ctx),
        });
      } catch (e) {
        console.warn("[native] sbResolve failed, using the web player", e);
        pending.delete(token);
        hideCard();
        loadUrl(url, { webOnly: true });
      }
    }, 60);
  };

  cardBtn.addEventListener("click", () => {
    const u = wv.getAttribute("src");
    if (!isBlank(u)) playNative(u);
  });

  const loadUrl = (url, { isMirror = false, webOnly = false } = {}) => {
    clearTimeout(timer);
    if (!isMirror && !webOnly && !isBlank(url) && nativeAvailable()) {
      playNative(url);
      return;
    }
    if (isBlank(url)) {
      nativeFor = null;
      hideCard();
    }
    if (!isMirror) mirrors = mirrorsFor(url);
    iframe.src = url || "about:blank";
    if (isBlank(url)) return;
    postContext(url);
    timer = setTimeout(() => {
      // No load event in time: next mirror, else report the failure.
      const next = mirrors.shift();
      if (next) loadUrl(next, { isMirror: true });
      else fire("did-fail-load");
    }, LOAD_TIMEOUT_MS);
  };

  iframe.addEventListener("load", () => {
    if (isBlank(iframe.src)) return;
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
    // Same-origin frames only; cross-origin embeds reject (callers catch).
    try {
      return Promise.resolve(iframe.contentWindow.eval(code));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  wv.getWebContentsId = () => 0;
  wv.insertCSS = () => Promise.resolve();
  wv.getURL = () => iframe.src;
  wv.reload = () => loadUrl(wv.getAttribute("src"));

  // Server picked in the native player: the page swaps the URL, which reopens
  // the player through the src observer. When the URL does not change (same
  // server, or the page is still waiting on anime data) reopen it here, once.
  let selectTimer = null;
  targets.add({
    wv,
    onReplay: () => {
      const u = wv.getAttribute("src");
      if (!isBlank(u) && nativeAvailable()) playNative(u);
    },
    onSelect: () => {
      clearTimeout(selectTimer);
      const picked = Date.now();
      const retry = (left) => {
        selectTimer = setTimeout(() => {
          if (lastNativeAt >= picked || !wv.isConnected) return;
          const u = wv.getAttribute("src");
          if (!isBlank(u) && nativeAvailable()) playNative(u);
          else if (left > 0) retry(left - 1);
        }, SELECT_RETRY_MS);
      };
      retry(SELECT_RETRIES);
    },
  });

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
  new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach(scan))).observe(
    document.documentElement,
    { childList: true, subtree: true },
  );
  scan(document.documentElement);
}
