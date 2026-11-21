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
import { anipmCandidates, ANIPM_ID, cachedAnipm, prefetchAnipm, anipmWebReady, anipmLangOk } from "./anipm";
import { showNoDubNote } from "../../utils/dubNote";
import { movyCandidates, MOVY_ID } from "./movy";
import { cinejoyCandidates, cachedCinejoy, forgetCinejoy, prefetchCinejoy, CINEJOY_ID } from "./cinejoy";
import { sevenMoviesCandidates, SEVENMOVIES_IDS } from "./sevenmovies";
import { flixerCandidates, FLIXER_ID } from "./flixer";
import { riveCandidates, RIVE_IDS } from "./rivestream";
import { playDirect, forceFullscreen, holdPrewarm, primeDirectVideo } from "../web/directPlayer";
import { parseServerKey } from "../../utils/servers/catalog";
import { diag } from "../../utils/diag";
import { customCandidates, withCustom, pickedCustomId, isCustomPlaceholder } from "./customServers";

const LOAD_TIMEOUT_MS = 8000;
// Web app in a browser (not the Android app, which has native HTTP like iPhone).
const BROWSER_ONLY = !!(import.meta.env?.VITE_WEB && !import.meta.env?.VITE_ANDROID);
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

// Web app: the browser's own player reports where you are, the same way the
// iPhone's native player does, so Continue Watching and Resume work on web
// (before, web saved nothing and every movie restarted from the top).
function webProgress(ctx) {
  const key = ctx?.progressKey;
  let last = { t: 0, d: 0 }, sentAt = 0;
  const send = () => {
    if (!key || !(last.d > 0) || !(last.t > 0)) return;
    window.dispatchEvent(new CustomEvent("sb-native-progress", { detail: { key, time: last.t, duration: last.d } }));
    sentAt = Date.now();
  };
  const onHide = () => send();
  const onVis = () => document.visibilityState === "hidden" && send();
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", onVis);
  return {
    startAt: key ? getResumeSeconds(key) : 0,
    onTime(t, d) {
      if (!(t >= 0) || !(d > 0) || !isFinite(d)) return;
      last = { t, d };
      if (Date.now() - sentAt >= 5000) send();
    },
    flush() {
      send();
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVis);
    },
  };
}

const dubModeOf = (ctx) => (ctx.dubMode === "dub" ? "dub" : "sub");
const isBlank = (url) => !url || url === "about:blank";
const nativeAvailable = () => !!window.webkit?.messageHandlers?.sbResolve;

/** Server list for the native server menu, built from the latest context. */
function serverListFor(ctx) {
  const list = nativeServerList(!!ctx.isAnime, ctx.type === "tv" ? "tv" : "movie");
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
function rankedCandidates(url, ctx, { signal, exclude = [], budgetMs } = {}) {
  const list = buildCandidateList(url, ctx).filter((c) => !exclude.includes(c.id));
  return probeAndRank(list, { stats: serverStats, probe: probeUrl, pinned: pinnedFor(ctx), signal, budgetMs });
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
/** Direct-stream servers (Movy, Cinejoy, 7Movies, Flixer, Rivestream) for a movie or episode, all looked up at once. */
export async function directCandidates(ctx, opts = {}) {
  const [m, c, s, f, r] = await Promise.all([
    movyCandidates(ctx, opts).catch(() => []),
    cinejoyCandidates(ctx, opts).catch(() => []),
    sevenMoviesCandidates(ctx, opts).catch(() => []),
    BROWSER_ONLY ? [] : flixerCandidates(ctx, opts).catch(() => []),
    BROWSER_ONLY ? [] : riveCandidates(ctx, opts).catch(() => []),
  ]);
  return [...m, ...c, ...s, ...f, ...r];
}
const DIRECT_IDS = new Set([MOVY_ID, CINEJOY_ID, FLIXER_ID, ...RIVE_IDS]);

export function withMovy(ranked, movy) {
  if (!movy?.length) return ranked;
  const ids = new Set(movy.map((c) => c.id));
  const rest = ranked.filter((c) => !ids.has(c.id) && !DIRECT_IDS.has(c.id) && !SEVENMOVIES_IDS.includes(c.id));
  // A direct server picked by hand (Cinejoy, 7Movies Orion / Evion, Flixer): its stream plays first.
  const pickedDirect = readStored("playerSource");
  if (!isAutoPick() && (DIRECT_IDS.has(pickedDirect) || SEVENMOVIES_IDS.includes(pickedDirect))) {
    const cj = movy.filter((c) => c.id === pickedDirect);
    if (cj.length) return [...cj, ...movy.filter((c) => c.id !== pickedDirect), ...rest].slice(0, MAX_CANDIDATES + movy.length);
  }
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
    if (!u || !/^https?:/.test(u) || /\.invalid\//.test(u) || seen.has(u) || list.length >= MAX_CANDIDATES) return;
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
  // Web app, embed servers: many embed players post their position to the
  // page (currentTime / duration, sometimes inside a JSON string). Save it
  // like any other progress so the movie resumes instead of restarting.
  let embedProg = null;
  let startWatch = null; // see armStartWatch below
  // #19: everything this player registers outside its own element (window
  // listeners, timers, the prewarm hold) is undone by teardown() when the
  // <webview> leaves the page. Before, every title opened left a window
  // "message" listener behind holding the whole player (iframe, closures).
  const cleanups = [];
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };
  // Every iframe navigation goes through here: a real embed page on screen
  // holds the hidden warm-up player off (no second stream while it plays).
  const setFrame = (u) => {
    iframe.src = u;
    holdPrewarm(wv, !isBlank(u));
  };
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  };
  cleanups.push(() => { timers.forEach(clearTimeout); timers.clear(); });
  listen(window, "message", (e) => {
    if (e.source !== iframe.contentWindow) return;
    let d = e.data;
    if (typeof d === "string") { try { d = JSON.parse(d); } catch { return; } }
    // Web: the embed says whether it has the title. Vidfast posts
    // {event:"status", data:404} for a title it doesn't have (and then shows its
    // own error page): never shown, the next server takes over at once.
    if (d?.event === "status" && Number(d.data) >= 400) return embedFailed(`not on this server (${d.data})`);
    if ((d?.event === "status" && Number(d.data) >= 200 && Number(d.data) < 300) ||
        d?.type === "PLAYER_EVENT" ||
        (d?.type === "MEDIA_DATA" && d.data && Object.keys(d.data).length)) revealEmbed();
    // Embed players that post PLAYER_EVENT (Cinezo's player.cinezo.live,
    // Vidfast): a play / timeupdate past 0 s means it is running, even
    // before a duration is known, so the no-start watch never skips it (#26).
    if (d?.type === "PLAYER_EVENT" && /^(play|playing|timeupdate)$/.test(d.data?.event || "") && Number(d.data?.currentTime) > 0) {
      startWatch?.started();
      window.__sbEmbedPlayingAt = Date.now();
    }
    // vidrift says outright when it can't play: next server.
    if (d?.type === "vidrift:wont-play") { diag("player", `vidrift won't play: ${d.reason || ""}`); return embedFailed("it refused to play here"); }
    const x = d?.data && typeof d.data === "object" ? d.data : d;
    const t = Number(x?.currentTime ?? x?.time ?? x?.position);
    const dur = Number(x?.duration);
    if (!(t > 0) || !(dur > 60) || !isFinite(dur) || t > dur + 5) return;
    revealEmbed();
    startWatch?.started();
    window.__sbEmbedPlayingAt = Date.now(); // the PWA updater waits while an embed plays
    const ctx = currentCtx();
    if (!ctx.progressKey) return;
    if (!embedProg || embedProg.key !== ctx.progressKey) { embedProg?.p.flush(); embedProg = { key: ctx.progressKey, p: webProgress(ctx) }; }
    embedProg.p.onTime(t, dur);
  });
  // Ad blocking: no allow-popups / allow-top-navigation, so embeds can't open
  // pop-ups, new tabs, or redirect the app. Servers that refuse a sandbox are
  // dropped from the web build (NEEDS_UNSANDBOXED in api.js).
  // Pop-up / ad blocking: the sandbox has no allow-popups, allow-top-navigation
  // or allow-modals, so an embed can't open ad tabs, pop-ups or redirect the
  // app. (The main web path is the ad-free direct stream; embeds are backups.)
  const SANDBOX = "allow-scripts allow-same-origin allow-forms"; // ("allow-presentation" is not a valid flag in WebKit)
  iframe.setAttribute("sandbox", SANDBOX);
  // Servers that check for a sandbox and refuse to play inside one ("Remove
  // sandboxing to enable playback"): no sandbox for them. Left to the
  // browser's own guards there: its pop-up blocker (no pop-up without a tap)
  // and its frame-busting rule (a cross-origin frame can't redirect the app
  // without a tap). A tap on such a player can still open an ad tab.
  // vidfast: "Please Disable Sandbox" in any sandbox, plays unsandboxed (checked in WebKit).
  const SANDBOX_REFUSERS = /(^|\.)(vidrift\.(in|to|net|cc|xyz|com)|vidrift|vidfast\.(vc|pro|to|net|co|me|io|xyz)|vidfast)$/i;
  const sandboxFor = (u) => {
    let host = "";
    try { host = new URL(u).hostname; } catch {}
    if (SANDBOX_REFUSERS.test(host)) iframe.removeAttribute("sandbox");
    else if (iframe.getAttribute("sandbox") !== SANDBOX) iframe.setAttribute("sandbox", SANDBOX);
  };
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

  // Web app: a third-party embed page is never shown until it says it has the
  // title (a ready message: status 200, its media data, a player event or a
  // position). Until then our own "Finding the stream…" card covers it; an
  // error / 404 / "disable sandbox" page that never says so is never seen:
  // after EMBED_READY_MS, or on an error message, the next server takes over
  // (Auto) or our own "not available" card shows.
  const GATE = BROWSER_ONLY;
  const EMBED_READY_MS = 25000;
  let embedReady = !GATE;
  let readyTimer = null;
  cleanups.push(() => clearTimeout(readyTimer));
  const gateEmbed = () => {
    if (!GATE) return;
    embedReady = false;
    clearTimeout(readyTimer);
    // Covered by our own card (on top of it), not hidden: a hidden frame is
    // treated as off screen by WebKit and players wait to start.
    showCard("Finding the stream…", false);
    readyTimer = setTimeout(() => embedFailed("it didn't load"), EMBED_READY_MS);
  };
  const revealEmbed = () => {
    if (embedReady || isBlank(iframe.src)) return;
    embedReady = true;
    clearTimeout(readyTimer);
    hideCard();
  };
  const embedFailed = (why) => {
    if (isBlank(iframe.src)) return;
    clearTimeout(readyTimer);
    startWatch?.cancel();
    stopWeb();
    diag("player", `embed failed (${why}): ${String(iframe.src).slice(0, 60)}`);
    fire("did-fail-load");
    const auto = BROWSER_ONLY && isAutoPick() && !inParty();
    if (auto) nextServer(why); // reads the failed page's address first
    setFrame("about:blank");
    if (!auto) showCard("Not available on this server. Pick another server.", false);
  };

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
    setFrame("about:blank");
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
      later(() => (note.style.display = "none"), 5000);
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
      const haveDirect = ctx.isAnime ? !!cachedAnipm(ctx) : !!cachedCinejoy(ctx);
      // Start on the fastest server: untested providers are probed at once,
      // within a short budget, while the Keychain read finishes.
      const tRank = Date.now();
      const [subCtx, ranked, anipm, movy, custom] = await Promise.all([
        subCtxReady,
        // A direct stream already in hand plays first, so the embed probes
        // (only backups then) get a tiny budget instead of holding Play up.
        rankedCandidates(url, ctx, { signal: probing.signal, budgetMs: haveDirect ? 150 : undefined }),
        ctx.isAnime ? anipmCandidates(ctx) : [],
        ctx.isAnime ? [] : directCandidates(ctx),
        customCandidates(ctx).catch((e) => {
          diag("player", `custom servers: ${e?.message || e}`);
          return [];
        }),
      ]);
      if (nativeToken !== token) return;
      const candidates = withCustom(withMovy(withAnipm(playerOrder(ranked, ctx), anipm), movy), custom, pickedCustomId());
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
    }, window.__sbCtx?.tmdbId ? 0 : 60);
  };

  cardBtn.addEventListener("click", () => {
    const u = wv.getAttribute("src");
    if (!isBlank(u)) playNative(u);
  });

  // Web app: Cinejoy's stream plays in-page (no embed, no ads, fast start).
  // Falls back to the embed server if Cinejoy has nothing or it won't play.
  let stopDirect = null;
  let directFor = null;
  // Nothing ad-free has this one: say so (never an ad/captcha embed).
  const noStream = () => {
    setFrame("about:blank");
    showCard("Not available on the web yet. Try again later or use the app.", false);
  };
  const embedFor = (url) => {
    // Stale "Cinejoy" pick on an anime: the first real anime server instead.
    const a = /cinejoy\.invalid\/anime\/([^/?#]+)\/([^/?#]+)\/?([a-z]*)/.exec(url);
    if (a) {
      const s = PLAYER_SOURCES.find((x) => x.animeUrl && !/\.invalid\//.test(x.movieUrl?.("1") || ""));
      return s ? s.animeUrl(a[1], a[2], a[3] || "sub") : url;
    }
    const m = /[a-z0-9-]+\.invalid\/(movie|tv)\/([^/?#]+)(?:\/(\d+)\/(\d+))?/.exec(url);
    if (!m) return url;
    const next = PLAYER_SOURCES.find((s) => !/\.invalid\//.test(s.movieUrl?.("1") || "") && !s.async && (m[1] === "movie" ? s.movieUrl : s.tvUrl));
    if (!next) return url;
    return m[1] === "movie" ? next.movieUrl(m[2]) : next.tvUrl(m[2], m[3] || 1, m[4] || 1);
  };
  // Web app, anime: ani.pm's stream (API through our relay) in Apple's own
  // player. Dub never silently plays Sub. Falls back to the embed server.
  const tryWebAnipm = (url, ctx) => {
    if (!anipmWebReady || !ctx.anilistId) return false;
    const wanted = ctx.dubMode === "sub" ? "sub" : "dub";
    directFor = url;
    setFrame("about:blank");
    fire("dom-ready");
    const fallback = () => {
      if (directFor !== url) return;
      hideCard();
      loadUrl(url, { webOnly: true });
    };
    const start = (r) => {
      hideCard();
      log("playing", `ani.pm (${r.lang})`);
      if (r.lang !== wanted) showNoDubNote();
      fire("did-finish-load");
      const prog = webProgress(ctx);
      const stop = playDirect(wv, r.source, {
        startAt: ctx.startAt || prog.startAt,
        onTime: prog.onTime,
        nativeOnly: true,
        referer: "https://ani.pm/",
        onFail: (why) => {
          if (directFor !== url) return;
          diag("player", `web ani.pm failed: ${why}`);
          stopDirect = null;
          fallback();
        },
      });
      stopDirect = () => { prog.flush(); stop?.(); };
    };
    const hit = cachedAnipm(ctx);
    if (hit && anipmLangOk(hit, wanted)) {
      start(hit);
      return true;
    }
    showCard("Finding the stream…", false);
    Promise.race([prefetchAnipm(ctx), new Promise((r) => setTimeout(() => r(null), 9000))])
      .then((r) => {
        if (directFor !== url) return;
        if (!r?.ok || !anipmLangOk(r, wanted)) throw new Error("no stream");
        start(r);
      })
      .catch(fallback);
    return true;
  };
  const inParty = () => !!window.__sbWatchParty;
  // Same key before and after the page fills in the episode (null -> 1 on Play).
  const titleKeyOf = (c) => (c?.type === "tv" ? `tv:${c?.tmdbId}:${c?.season ?? 1}:${c?.episode ?? 1}` : `${c?.type}:${c?.tmdbId}`);
  const directMissed = new Set(); // titles Cinejoy had no playable stream for (web)
  const partyTries = new Map(); // title url -> direct retries in this party
  const partyNoSync = (embedUrl) => {
    const ctx = currentCtx();
    const keyOf = (c) => `${c?.type}:${c?.tmdbId || c?.anilistId}:${c?.season || ""}:${c?.episode || ""}`;
    const key = keyOf(ctx);
    const n = (partyTries.get(key) || 0) + 1;
    partyTries.set(key, n);
    setFrame("about:blank");
    diag("player", `party: embed ${String(embedUrl).slice(0, 60)} can't sync (try ${n})`);
    if (n > 2) {
      showCard("No synced stream for this title right now. Pick something else for the party.", false);
      return;
    }
    showCard("This server can't sync with the party. Switching…", false);
    if (ctx) forgetCinejoy(ctx);
    const synced = ctx?.isAnime
      ? `https://cinejoy.invalid/anime/${ctx.anilistId || ctx.tmdbId}/${ctx.episode || 1}/${ctx.dubMode === "sub" ? "sub" : "dub"}`
      : ctx?.type === "movie"
        ? `https://cinejoy.invalid/movie/${ctx.tmdbId}`
        : `https://cinejoy.invalid/tv/${ctx?.tmdbId}/${ctx?.season || 1}/${ctx?.episode || 1}`;
    setTimeout(() => {
      if (!inParty() || keyOf(currentCtx()) !== key) return; // left the party / the title changed
      if (!tryWebDirect(synced)) showCard("No synced stream for this title right now. Pick something else for the party.", false);
    }, 1200);
  };
  // Android app: the iPhone's direct servers (Movy, Cinejoy, 7Movies Orion /
  // Evion, Flixer, Rivestream) through native HTTP, played in the app's own
  // player one after another; the embed servers only when none plays.
  const tryAndroidDirect = (url, ctx) => {
    const picked = readStored("playerSource");
    const pickedDirect = DIRECT_IDS.has(picked) || SEVENMOVIES_IDS.includes(picked);
    if (picked && !pickedDirect && !isAutoPick() && !/\.invalid\//.test(url) && !inParty()) return false;
    directFor = url;
    setFrame("about:blank");
    fire("dom-ready");
    showCard("Finding the stream…", false);
    const toEmbed = () => {
      if (directFor !== url) return;
      hideCard();
      loadUrl(embedFor(url), { webOnly: true });
    };
    Promise.race([directCandidates(ctx), new Promise((r) => setTimeout(() => r([]), 9000))])
      .then((found) => {
        if (directFor !== url) return;
        const list = withMovy([], found || []);
        diag("player", `android direct: ${list.map((c) => c.id).join(", ") || "none"}`);
        const next = (i) => {
          if (directFor !== url) return;
          const c = list[i];
          if (!c) return toEmbed();
          hideCard();
          log("playing", `${c.label} (direct)`);
          fire("did-finish-load");
          const prog = webProgress(ctx);
          const stop = playDirect(wv, c.url.replace(/#sb-direct$/, ""), {
            startAt: ctx.startAt || prog.startAt,
            onTime: prog.onTime,
            referer: c.referer || "",
            onFail: (why) => {
              if (directFor !== url) return;
              diag("player", `android direct ${c.id} failed: ${why}`);
              stopDirect = null;
              if (c.id === CINEJOY_ID) forgetCinejoy(ctx);
              next(i + 1);
            },
          });
          stopDirect = () => { prog.flush(); stop?.(); };
        };
        next(0);
      })
      .catch(toEmbed);
    return true;
  };
  const tryWebDirect = (url) => {
    const ctx = currentCtx();
    // Android anime: ani.pm first, like the iPhone app (unless an embed was picked by hand).
    if (import.meta.env.VITE_ANDROID && ctx?.isAnime) {
      const picked = readStored("playerSource");
      if ((!picked || isAutoPick() || isAnipmPinned?.() || /\.invalid\//.test(url) || inParty()) && tryWebAnipm(url, ctx)) return true;
    }
    if (import.meta.env.VITE_ANDROID && ctx?.tmdbId && !ctx.isAnime) return tryAndroidDirect(url, ctx);
    if (ctx?.isAnime) {
      // Anime: vidrift (embed) is Auto's first choice when watching alone;
      // in a Watch Party only a direct stream (ani.pm) can be kept in sync.
      if (inParty() && tryWebAnipm(url, ctx)) return true;
      if (!inParty() && !/cinejoy\.invalid\//.test(url)) return false;
      if (/cinejoy\.invalid\//.test(url)) { loadUrl(embedFor(url), { webOnly: true }); return true; }
      return false;
    }
    if (!ctx || !ctx.tmdbId) return false;
    const picked = readStored("playerSource");
    // In a party everyone plays the synced direct stream, whatever server this phone picked.
    if (picked && picked !== CINEJOY_ID && !isAutoPick() && !/cinejoy\.invalid/.test(url) && !inParty()) return false;
    // Web Auto: Cinejoy's direct stream first, in our player (Apple's own
    // full-screen player on iPhone); an embed only when it has no stream.
    const key = titleKeyOf(ctx);
    if (BROWSER_ONLY && directMissed.has(key) && !/cinejoy\.invalid/.test(url)) return false;
    directFor = url;
    setFrame("about:blank");
    fire("dom-ready");
    // No direct stream: the embed (the page's own server), or in Auto with
    // Cinejoy itself picked, the next server; never Cinejoy again for this title.
    const noDirect = () => {
      if (directFor !== url) return;
      directMissed.add(key);
      hideCard();
      // The player unlocked for the stream (primeDirectVideo) isn't needed.
      wv.querySelectorAll(":scope > video.sb-direct-video").forEach((v) => !v.getAttribute("src") && !v.__sbHls && v.remove());
      if (BROWSER_ONLY && /cinejoy\.invalid/.test(url) && isAutoPick() && !inParty()) return nextServer("no direct stream");
      loadUrl(embedFor(url), { webOnly: true });
    };
    const start = (src) => {
      hideCard();
      log("playing", "Cinejoy (direct)");
      fire("did-finish-load");
      // Called synchronously from the Play tap when the stream is already
      // known, so iPhone opens its own full-screen player right away.
      const prog = webProgress(ctx);
      const stop = playDirect(wv, src, {
        startAt: ctx.startAt || prog.startAt,
        onTime: prog.onTime,
        onFail: (why) => {
          if (directFor !== url) return;
          diag("player", `web direct failed: ${why}`);
          stopDirect = null;
          forgetCinejoy(ctx);
          noDirect();
        },
      });
      stopDirect = () => { prog.flush(); stop?.(); };
    };
    const hit = cachedCinejoy(ctx);
    if (hit) {
      start(hit.source);
      return true;
    }
    // iPhone: unlock a player inside this tap, so the stream can open Apple's
    // own full-screen player as soon as it is found (no second tap).
    primeDirectVideo(wv);
    showCard("Finding the stream…", false);
    Promise.race([prefetchCinejoy(ctx), new Promise((r) => setTimeout(() => r(null), 8000))])
      .then((r) => {
        if (directFor !== url) return;
        if (!r?.ok) throw new Error("no stream");
        start(r.source);
      })
      .catch(noDirect);
    return true;
  };

  // The page's server failed: say why and move to the next server.
  const failedServers = new Map(); // title key -> Set of servers that failed
  const autoSwitches = new Map(); // title key -> automatic switches made (hard cap, #19)
  const lastAutoPick = new Map(); // title key -> server the last automatic switch went to
  const nextServer = (why) => {
    const ctx = currentCtx();
    const key = titleKeyOf(ctx);
    const current = menuId(readStored("playerSource"), ctx);
    const failed = failedServers.get(key) || new Set();
    if (directMissed.has(key)) failed.add(CINEJOY_ID);
    // Never the Auto placeholder itself: the server that really failed is the
    // stored pick, the one the last automatic switch went to, or the one shown.
    if (current && current !== "auto") failed.add(current);
    if (lastAutoPick.has(key)) failed.add(lastAutoPick.get(key));
    // The embed actually on screen (e.g. Cinejoy's fallback page) failed too.
    try {
      const host = new URL(iframe.src).host;
      const shown = PLAYER_SOURCES.find((p) => { try { return new URL(p.movieUrl?.("1") || "").host === host; } catch { return false; } });
      if (shown) failed.add(menuId(shown.id, ctx));
    } catch {}
    failedServers.set(key, failed);
    const list = serverListFor(ctx).filter((s) => PLAYER_SOURCES.some((p) => p.id === parseServerKey(s.id).sourceId));
    const switches = autoSwitches.get(key) || 0;
    // Bounded: at most one automatic switch per listed server for a title, so
    // a failure that can't be pinned on a server can never loop (reload after
    // reload of embed pages).
    const next = switches < list.length ? list.find((s) => !failed.has(s.id)) : null;
    const label = list.find((s) => s.id === current)?.label || "This server";
    diag("player", `auto: ${label} failed (${why}); next: ${next ? next.label : "none"}`);
    if (!next) {
      showCard(`${label} couldn't play this (${why}). No other server worked — pick one in Server or try again later.`, false);
      return;
    }
    autoSwitches.set(key, switches + 1);
    lastAutoPick.set(key, next.id);
    showCard(`${label} couldn't play this (${why}). Trying ${next.label}…`, false);
    later(() => GATE || hideCard(), 4000); // web: the next embed's own card takes over
    const ev = new CustomEvent("sb-select-server", { detail: next.id });
    ev.sbAuto = true; // an automatic switch: the viewer's own choice stays as it was
    window.dispatchEvent(ev);
  };
  // Web app, Auto: a server that refused or never started hands over to the next one.
  const webAutoNext = (why) => { if (BROWSER_ONLY && isAutoPick() && !inParty()) nextServer(why); };

  // Android app: auto-open the player like the iPhone app. MainActivity sees
  // every request an embed server makes; the moment one asks for a video
  // stream (.m3u8 / .mp4) it tells us, and we play that stream in our own
  // full-screen player (no embed page, no ads). If it won't play, the embed
  // simply keeps going.
  if (import.meta.env.VITE_ANDROID) {
    // Per embed page: streams it requested (first is played; the others are
    // spares if it fails) and how many failed. After MAX_TRIES failures, or no
    // spare within SPARE_WAIT_MS, the next server is tried automatically and
    // the reason is shown, never a black screen.
    const MAX_TRIES = 3;
    const SPARE_WAIT_MS = 3000;
    let sniff = { embed: null, queue: [], tried: new Set(), fails: 0, playing: false, waitTimer: null };
    const resetSniff = (embed) => {
      clearTimeout(sniff.waitTimer);
      sniff = { embed, queue: [], tried: new Set(), fails: 0, playing: false, waitTimer: null };
    };
    const playSniffed = (s) => {
      const ctx = currentCtx();
      const embed = sniff.embed;
      sniff.playing = true;
      sniff.tried.add(s.url);
      log("playing", "auto-opened stream");
      diag("player", `android sniffed stream: ${s.url.slice(0, 120)} (try ${sniff.fails + 1})`);
      let blanked = false;
      const prog = webProgress(ctx);
      const stop = playDirect(wv, s.url, {
        startAt: ctx.startAt || prog.startAt,
        // The embed page itself as the fallback Referer/Origin.
        referer: embed,
        headers: s.headers || {},
        onTime: (pos, dur) => {
          // Our player is running: drop the embed page (stops its audio/ads).
          if (!blanked && pos > 0) { blanked = true; setFrame("about:blank"); }
          prog.onTime(pos, dur);
        },
        onFail: (why) => {
          stopDirect = null;
          if (sniff.embed !== embed) return;
          sniff.playing = false;
          sniff.fails += 1;
          diag("player", `android player failed (${why}) on ${s.url.slice(0, 120)}`);
          if (blanked) loadUrl(embed, { webOnly: true });
          const spare = sniff.queue.shift();
          if (spare && sniff.fails < MAX_TRIES) return playSniffed(spare);
          if (sniff.fails >= MAX_TRIES) return nextServer(why);
          // Give the page a moment to request another stream.
          sniff.waitTimer = setTimeout(() => {
            if (sniff.embed !== embed || sniff.playing) return;
            const later = sniff.queue.shift();
            if (later) playSniffed(later);
            else nextServer(why);
          }, SPARE_WAIT_MS);
        },
      });
      stopDirect = () => { prog.flush(); stop?.(); };
    };
    listen(window, "sb-android-stream", (e) => {
      const u = String(e?.detail?.url || "");
      if (!u || !wv.isConnected || directFor) return;
      const embed = iframe.getAttribute("src") || "";
      if (!embed || isBlank(embed)) return;
      if (sniff.embed !== embed) resetSniff(embed);
      if (sniff.tried.has(u) || sniff.queue.some((q) => q.url === u)) return;
      const s = { url: u, headers: e?.detail?.headers || {} };
      if (stopDirect || sniff.playing) {
        if (sniff.queue.length < 5) sniff.queue.push(s); // a spare for when this one fails
        return;
      }
      clearTimeout(sniff.waitTimer);
      playSniffed(s);
    });
  }

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
      setFrame("about:blank");
      return;
    }
    // Android app: direct streams open the built-in full-screen player, so
    // only the embed fallback puts the web view itself full screen.
    if (import.meta.env.VITE_WEB && !/iPhone|iPod/.test(navigator.userAgent) && (import.meta.env.VITE_ANDROID ? webOnly : !webOnly)) forceFullscreen(wv);
    if (import.meta.env.VITE_WEB && !webOnly && tryWebDirect(url)) return;
    // Watch Party on the web: an embed server (a cross-origin page in an
    // iframe) can't be paused, seeked or read by the party, so the phones
    // would drift apart. Never play one in a party; retry the synced direct
    // stream instead (everyone in the party then plays the same source).
    if (import.meta.env.VITE_WEB && !import.meta.env.VITE_ANDROID && inParty()) {
      partyNoSync(url);
      return;
    }
    // A custom site never loads in the visible web view: its ads and pop-ups
    // are only blocked in the native stream finder.
    if (isCustomPlaceholder(url)) {
      setFrame("about:blank");
      showCard("No stream found on this server. Pick another server.", false);
      return;
    }
    // No load event in time: the next mirror takes over, else the page hears
    // did-fail-load and fails over to another server.
    webFallback = createFallback([url, ...mirrorsFor(url)], {
      // Web: a slow player page (Cinezo's is heavy) is given the whole ready
      // window; its ready message, not the load event, decides (EMBED_READY_MS).
      stallMs: GATE ? EMBED_READY_MS : LOAD_TIMEOUT_MS,
      play: (u) => {
        sandboxFor(u);
        gateEmbed();
        setFrame(u);
        postContext(u);
      },
      onExhausted: () => (GATE ? embedFailed("it didn't load") : (fire("did-fail-load"), webAutoNext("it didn't load"))),
    });
    webFallback.start();
  };

  // An embed server that loads but never starts (refuses to play in our
  // frame, a dead stream, an error page): after START_WATCH_MS with no sign
  // of playback (no position from the player) and no tap on it, the page's
  // normal server failover moves on to the next server. Never more than
  // MAX_SILENT_SKIPS servers in a row without the viewer touching anything,
  // so a player that simply waits for a tap is not skipped forever.
  const START_WATCH_MS = 8000;
  const MAX_SILENT_SKIPS = BROWSER_ONLY ? 5 : 2;
  const TAPPED_WAIT_MS = 15000; // vidrift: from a tap to its first progress report (sent from 5 s in)
  let silentSkips = 0;
  let skipsFor = "";
  const armStartWatch = () => {
    startWatch?.cancel();
    const ctx = currentCtx();
    const key = `${ctx?.type}:${ctx?.tmdbId || ctx?.anilistId}:${ctx?.season || ""}:${ctx?.episode || ""}`;
    if (key !== skipsFor) { skipsFor = key; silentSkips = 0; }
    if (silentSkips >= MAX_SILENT_SKIPS) return;
    const src = iframe.src;
    let done = false;
    const cancel = () => {
      done = true;
      clearTimeout(t);
      window.removeEventListener("blur", onBlur);
      wv.removeEventListener("pointerdown", onTap, true);
    };
    // A tap inside a cross-origin frame shows up as this window losing focus.
    const onBlur = () => setTimeout(() => !done && document.activeElement === iframe && onTap(), 0);
    // vidrift reports its position (vidrift:progress) once playing; it can
    // also refuse on the first tap (its pop-up check). So for vidrift a tap
    // gives it TAPPED_WAIT_MS to start rather than ending the watch.
    const reportsProgress = /(^|\.)vidrift\./i.test((() => { try { return new URL(src).hostname; } catch { return ""; } })());
    const onTap = () => {
      silentSkips = 0;
      if (!reportsProgress) return cancel();
      clearTimeout(t);
      t = setTimeout(expire, TAPPED_WAIT_MS);
    };
    window.addEventListener("blur", onBlur);
    wv.addEventListener("pointerdown", onTap, true);
    const expire = () => {
      if (done || iframe.src !== src || isBlank(src)) return cancel();
      // Web: the player said it has the title and is on screen, waiting for a
      // tap (iPhone blocks autoplay with sound): keep it (#26).
      if (GATE && embedReady) return cancel();
      cancel();
      silentSkips += 1;
      diag("player", `embed did not start in ${START_WATCH_MS} ms: next server (${String(src).slice(0, 60)})`);
      fire("did-fail-load");
      if (BROWSER_ONLY && isAutoPick() && !inParty()) webAutoNext("it didn't start");
      else {
        showCard("This server didn't start. Pick another server.", false);
        later(hideCard, 2500);
      }
    };
    let t = setTimeout(expire, START_WATCH_MS);
    startWatch = { cancel, started: () => { cancel(); silentSkips = 0; } };
  };

  iframe.addEventListener("load", () => {
    if (isBlank(iframe.src)) return;
    stopWeb();
    fire("dom-ready");
    fire("did-finish-load");
    if (import.meta.env.VITE_WEB) armStartWatch();
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
  const target = {
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
  };
  targets.add(target);

  const srcObserver = new MutationObserver(() => loadUrl(wv.getAttribute("src")));
  srcObserver.observe(wv, { attributes: true, attributeFilter: ["src"] });

  // #19: the <webview> left the page (title closed, server UA swap remounts
  // it): stop everything it started, so nothing keeps the old player, its
  // embed page or its stream alive. Safe to call twice.
  wv.__sbTeardown = () => {
    if (!wv.__sbUpgraded) return;
    wv.__sbUpgraded = false;
    delete wv.__sbTeardown;
    srcObserver.disconnect();
    targets.delete(target);
    clearTimeout(selectTimer);
    startWatch?.cancel();
    startWatch = null;
    stopWeb();
    webFallback = null;
    try { stopDirect?.(); } catch {}
    stopDirect = null;
    directFor = null;
    probes?.abort();
    if (nativeToken) pending.delete(nativeToken);
    nativeToken = null;
    nativeFor = null;
    embedProg?.p.flush();
    embedProg = null;
    while (cleanups.length) { try { cleanups.pop()(); } catch {} }
    // Unload the embed page now (its video, timers and ads), then drop it.
    try { iframe.src = "about:blank"; } catch {}
    holdPrewarm(wv, false);
    iframe.remove();
    card.remove();
    note.remove();
  };
  loadUrl(wv.getAttribute("src"));
}

/** Webviews in `root` (itself or below) that were upgraded. */
const upgradedIn = (root) => {
  if (root?.nodeType !== 1) return [];
  const all = root.tagName === "WEBVIEW" ? [root] : [];
  root.querySelectorAll?.("webview").forEach((w) => all.push(w));
  return all.filter((w) => w.__sbUpgraded);
};
/** Tear down every upgraded webview in `root` that is no longer in the page. */
export function releaseDetached(root) {
  for (const wv of upgradedIn(root)) if (!wv.isConnected) wv.__sbTeardown?.();
}

export function installWebviewPolyfill() {
  const scan = (root) => {
    if (root.nodeType !== 1) return;
    if (root.tagName === "WEBVIEW") upgrade(root);
    root.querySelectorAll?.("webview").forEach(upgrade);
  };
  // Removed webviews are released on the next tick, unless they were only
  // moved (back in the page by then).
  const removed = new Set();
  let releaseTimer = null;
  const queueRelease = (node) => {
    for (const wv of upgradedIn(node)) removed.add(wv);
    if (!removed.size || releaseTimer) return;
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      const list = [...removed];
      removed.clear();
      for (const wv of list) if (!wv.isConnected) wv.__sbTeardown?.();
    }, 0);
  };
  new MutationObserver((muts) =>
    muts.forEach((m) => {
      m.removedNodes.forEach(queueRelease);
      m.addedNodes.forEach(scan);
    }),
  ).observe(
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
