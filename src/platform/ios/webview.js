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
import { serverKey } from "../../utils/servers/catalog";
import { createFallback } from "../../utils/servers/fallback";
import { probeAndRank } from "../../utils/servers/ranking";
import { probeUrl } from "../../utils/servers/probe";
import { isAutoPick, isAnipmPinned, recordLookup, serverStats } from "./autoServer";
import { autoOrder, prefetchRanking } from "./autoRank";
import { formatClock, getResumeSeconds, MIN_RESUME_SECONDS } from "./resume";
import { anipmCandidates, ANIPM_ID } from "./anipm";
import { movyCandidates, MOVY_ID } from "./movy";
import { cinejoyCandidates, cachedCinejoy, prefetchCinejoy, CINEJOY_ID } from "./cinejoy";
import { playDirect } from "../web/directPlayer";
import { parseServerKey } from "../../utils/servers/catalog";
import { diag } from "../../utils/diag";

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
  const list = nativeServerList(!!ctx.isAnime);
  if (!ctx.isAnime) return list;
  // ani.pm leads the native menu for anime (Sub and Dub entries).
  return [
    { id: `${ANIPM_ID}:sub`, label: "ani.pm · Sub" },
    { id: `${ANIPM_ID}:dub`, label: "ani.pm · Dub" },
    ...list,
  ];
}

/**
 * Id of the playing server as the native menu knows it: anime-route servers
 * carry the audio mode ("vidnest:dub"), everything else is the plain id.
 */
function menuId(sourceId, ctx) {
  const animeRoute = ctx.isAnime && PLAYER_SOURCES.find((s) => s.id === sourceId)?.animeUrl;
  return sourceId ? serverKey(sourceId, animeRoute ? dubModeOf(ctx) : null) : sourceId;
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
// Last server that actually played each title (per Sub/Dub mode): tried
// first next time, since it is known to work for exactly this title.
const LAST_GOOD_KEY = "sb_lastGoodServer";
const LAST_GOOD_MAX = 200;
const titleKey = (ctx) =>
  ctx?.tmdbId ? `${ctx.type || "movie"}:${ctx.tmdbId}${ctx.isAnime ? `:${dubModeOf(ctx)}` : ""}` : null;

function readLastGood() {
  try {
    return JSON.parse(localStorage.getItem(LAST_GOOD_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function rememberLastGood(ctx, serverId) {
  const key = titleKey(ctx);
  if (!key || !serverId) return;
  try {
    const map = readLastGood();
    delete map[key];
    map[key] = serverId;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - LAST_GOOD_MAX))) delete map[k];
    localStorage.setItem(LAST_GOOD_KEY, JSON.stringify(map));
  } catch {}
}

// Server that leads the list: the viewer's own pick, or in Auto the last
// server that played this title; everything else is ranked by speed.
function pinnedFor(ctx) {
  return isAutoPick() ? readLastGood()[titleKey(ctx)] : menuId(readStored("playerSource"), ctx);
}

/**
 * Candidates for `ctx`, best first: providers with no fresh stats are probed
 * now (in parallel, short budget). Ids in `exclude` are left out.
 */
function rankedCandidates(url, ctx, { signal, exclude = [] } = {}) {
  const list = buildCandidateList(url, ctx).filter((c) => !exclude.includes(c.id));
  return probeAndRank(list, { stats: serverStats, probe: probeUrl, pinned: pinnedFor(ctx), signal });
}

/**
 * ani.pm is the main anime server: its candidates lead, unless the viewer
 * picked another server by hand (then that one stays first).
 */
export function withAnipm(ranked, anipm) {
  if (!anipm?.length) return ranked;
  const rest = ranked.filter((c) => parseServerKey(c.id).sourceId !== ANIPM_ID);
  if (!isAutoPick() && !isAnipmPinned() && rest.length && readStored("playerSource")) {
    return [rest[0], ...anipm, ...rest.slice(1)].slice(0, MAX_CANDIDATES + anipm.length);
  }
  return [...anipm, ...rest].slice(0, MAX_CANDIDATES + anipm.length);
}

/**
 * Movy's direct stream leads for movies and series (it is the stream itself,
 * no page to load), unless the viewer picked another server by hand.
 */
/** Direct-stream servers (Movy, Cinejoy) for a movie or episode, both looked up at once. */
export async function directCandidates(ctx) {
  const [m, c] = await Promise.all([movyCandidates(ctx).catch(() => []), cinejoyCandidates(ctx).catch(() => [])]);
  return [...m, ...c];
}

export function withMovy(ranked, movy) {
  if (!movy?.length) return ranked;
  const ids = new Set(movy.map((c) => c.id));
  const rest = ranked.filter((c) => !ids.has(c.id) && c.id !== MOVY_ID && c.id !== CINEJOY_ID);
  if (!isAutoPick() && rest.length && readStored("playerSource")) {
    return [rest[0], ...movy, ...rest.slice(1)].slice(0, MAX_CANDIDATES + movy.length);
  }
  return [...movy, ...rest].slice(0, MAX_CANDIDATES + movy.length);
}

function buildCandidateList(url, ctx) {
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
      return s.animeUrl(ctx.anilistId, ctx.anilistEpisode ?? ctx.episode ?? 1, mode);
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

/**
 * Player Auto order: in Auto, servers measured on this network (speed, then
 * ping) lead, the last server that played this title first; a server picked
 * by hand keeps the probe order with that server first. ani.pm is put in
 * front afterwards (withAnipm). Player only: downloads never use this.
 */
export function playerOrder(ranked, ctx) {
  if (!isAutoPick()) return ranked;
  return autoOrder(ranked, { pinned: readLastGood()[titleKey(ctx)] || null });
}

/**
 * Title page opened: measure its play servers now (parallel, ~2 s, cached
 * per session/network), so Play starts on the fastest one without waiting.
 */
export function prefetchTitle(ctx) {
  if (!ctx?.tmdbId) return Promise.resolve(null);
  const list = buildCandidateList(null, ctx);
  const key = `${titleKey(ctx)}:${ctx.season ?? ""}:${ctx.episode ?? ""}`;
  return prefetchRanking(list, { key }).catch(() => null);
}

/**
 * The page's context with `override` (e.g. another episode) on top, taken
 * once per download so a retry later finds servers for the same title.
 */
export const downloadContext = (override = {}) => ({ ...currentCtx(), ...override });

/**
 * Servers for downloading one title/episode (a downloadContext), best first:
 * the same list Play would try. `opts.exclude` leaves out servers already tried.
 */
export const downloadCandidates = (ctx, opts) => rankedCandidates(null, ctx, opts);

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
  // Ad blocking: no allow-popups / allow-top-navigation, so embeds can't open
  // pop-ups, new tabs, or redirect the app. Servers that refuse a sandbox are
  // dropped from the web build (NEEDS_UNSANDBOXED in api.js).
  // No sandbox: players detect it and refuse to play ("disable sandbox").
  iframe.removeAttribute("sandbox");
  iframe.setAttribute("referrerpolicy", "origin");
  iframe.setAttribute("allow", "autoplay; fullscreen; picture-in-picture; encrypted-media");
  iframe.setAttribute("allowfullscreen", "");
  iframe.setAttribute("playsinline", "");
  iframe.setAttribute("referrerpolicy", "origin");
  iframe.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;background:#000";
  wv.appendChild(iframe);

  let webFallback = null; // the iframe's server + mirrors, one at a time
  const stopWeb = () => webFallback?.stop();
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
  let probes = null; // aborts the server probes of a play that was replaced

  const playNative = (url) => {
    // A newer play replaces the previous request; drop its callback.
    if (nativeToken) pending.delete(nativeToken);
    probes?.abort();
    const probing = (probes = new AbortController());
    let sent = null; // { candidates, at } once handed to the native player
    const token = Math.random().toString(36).slice(2);
    nativeToken = token;
    lastNativeAt = Date.now();
    nativeFor = url;
    stopWeb();
    iframe.src = "about:blank";
    cardBtn.textContent = "▶  Play";
    showCard("Opening the native player…", false);
    note.style.display = "none";
    fire("dom-ready");
    fire("did-finish-load");
    pending.set(token, (r) => {
      if (nativeFor !== url || nativeToken !== token) return;
      if (sent) recordLookup(r, sent.candidates, Date.now() - sent.at);
      if (sent) diag("player", `play: ${r.ok ? `stream from ${r.server}` : "no stream"} ${Date.now() - sent.at} ms after send`);
      if (r.ok) {
        log("playing", r.server);
        rememberLastGood(currentCtx(), r.server);
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
    // Keychain read runs while the page gets a tick to publish its context
    // (title, ids, Sub/Dub).
    const subCtxReady = subtitleContext();
    setTimeout(async () => {
      if (nativeToken !== token) return;
      postContext(url);
      const ctx = currentCtx();
      // Start on the fastest server: untested providers are probed at once,
      // within a short budget, while the Keychain read finishes.
      const tRank = Date.now();
      const [subCtx, ranked, anipm, movy] = await Promise.all([
        subCtxReady,
        rankedCandidates(url, ctx, { signal: probing.signal }),
        ctx.isAnime ? anipmCandidates(ctx) : [],
        ctx.isAnime ? [] : directCandidates(ctx),
      ]);
      if (nativeToken !== token) return;
      const candidates = withMovy(withAnipm(playerOrder(ranked, ctx), anipm), movy);
      diag(
        "player",
        `play: candidates in ${Date.now() - tRank} ms (tap→send ${Date.now() - lastNativeAt} ms): ` +
          candidates.slice(0, 4).map((c) => c.id).join(", "),
      );
      const startAt = getResumeSeconds(ctx.progressKey);
      log("resolve", candidates.map((c) => `${c.id} ${c.url}`));
      sent = { candidates, at: Date.now() };
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

  // Web app: Cinejoy's stream plays in-page (no embed, no ads, fast start).
  // Falls back to the embed server if Cinejoy has nothing or it won't play.
  let stopDirect = null;
  let directFor = null;
  // Cinejoy has nothing for this title: the next server's page for it.
  const embedFor = (url) => {
    const m = /cinejoy\.invalid\/(movie|tv)\/([^/?#]+)(?:\/(\d+)\/(\d+))?/.exec(url);
    if (!m) return url;
    const next = PLAYER_SOURCES.find((s) => !/\.invalid\//.test(s.movieUrl?.("1") || "") && !s.async && (m[1] === "movie" ? s.movieUrl : s.tvUrl));
    if (!next) return url;
    return m[1] === "movie" ? next.movieUrl(m[2]) : next.tvUrl(m[2], m[3] || 1, m[4] || 1);
  };
  const tryWebDirect = (url) => {
    const ctx = currentCtx();
    if (!ctx || ctx.isAnime || !ctx.tmdbId) return false;
    const picked = readStored("playerSource");
    if (picked && picked !== CINEJOY_ID && !isAutoPick() && !/cinejoy\.invalid/.test(url)) return false;
    directFor = url;
    iframe.src = "about:blank";
    fire("dom-ready");
    const start = (src) => {
      hideCard();
      log("playing", "Cinejoy (direct)");
      fire("did-finish-load");
      // Called synchronously from the Play tap when the stream is already
      // known, so iPhone opens its own full-screen player right away.
      stopDirect = playDirect(wv, src, {
        startAt: ctx.startAt || 0,
        onFail: (why) => {
          if (directFor !== url) return;
          diag("player", `web direct failed: ${why}`);
          stopDirect = null;
          loadUrl(embedFor(url), { webOnly: true });
        },
      });
    };
    const hit = cachedCinejoy(ctx);
    if (hit) {
      start(hit.source);
      return true;
    }
    showCard("Finding the stream…", false);
    Promise.race([prefetchCinejoy(ctx), new Promise((r) => setTimeout(() => r(null), 8000))])
      .then((r) => {
        if (directFor !== url) return;
        if (!r?.ok) throw new Error("no stream");
        start(r.source);
      })
      .catch(() => {
        if (directFor === url) { hideCard(); loadUrl(embedFor(url), { webOnly: true }); }
      });
    return true;
  };

  const loadUrl = (url, { webOnly = false } = {}) => {
    stopWeb();
    stopDirect?.();
    stopDirect = null;
    if (!webOnly) directFor = null;
    if (!webOnly && !isBlank(url) && nativeAvailable()) {
      playNative(url);
      return;
    }
    if (isBlank(url)) {
      nativeFor = null;
      hideCard();
      iframe.src = "about:blank";
      return;
    }
    if (import.meta.env.VITE_WEB && !webOnly && tryWebDirect(url)) return;
    // No load event in time: the next mirror takes over, else the page hears
    // did-fail-load and fails over to another server.
    webFallback = createFallback([url, ...mirrorsFor(url)], {
      stallMs: LOAD_TIMEOUT_MS,
      play: (u) => {
        iframe.src = u;
        postContext(u);
      },
      onExhausted: () => fire("did-fail-load"),
    });
    webFallback.start();
  };

  iframe.addEventListener("load", () => {
    if (isBlank(iframe.src)) return;
    stopWeb();
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

/** Audio of the title on screen, for the download picker's subtitle default. */
export const currentAudioMode = () => {
  const c = currentCtx();
  return { isAnime: !!c.isAnime, dub: dubModeOf(c) === "dub" };
};
