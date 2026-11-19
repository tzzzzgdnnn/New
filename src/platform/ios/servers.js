// servers.json loader: bundled copy -> cached remote copy -> fresh remote copy.
// Edit servers.json on the ios-app branch to fix a dead/moved server without
// rebuilding the app.
import bundled from "../../../servers.json";
import { PLAYER_SOURCES } from "../../utils/api";

export const SERVERS_BRANCH =
  (typeof localStorage !== "undefined" &&
    localStorage.getItem("streambert_serversBranch")) ||
  "main";
export const SERVERS_URL = `https://raw.githubusercontent.com/gdntzzzzz/New/${SERVERS_BRANCH}/servers.json`;
const CACHE_KEY = "streambert_serversCache";
const FETCH_TIMEOUT_MS = 2500;

const BUILTIN = PLAYER_SOURCES.slice();
// Web app only: Hexa shows a "Verification Required" captcha; Vidrift refuses
// to play sandboxed.
const WEB_BLOCKED = new Set(["hexa", "vidnest"]); // both show a captcha wall
let _mirrorMap = []; // [{ origin, mirrors: [origin...] }]

const fill = (tpl, v) =>
  tpl
    .replace(/\{tmdb\}/g, v.id)
    .replace(/\{imdb\}/g, v.id)
    .replace(/\{season\}/g, v.season ?? 1)
    .replace(/\{episode\}/g, v.ep ?? 1)
    .replace(/\{anilist\}/g, v.id)
    .replace(/\{lang\}/g, v.lang ?? "sub");
// Optional "anime" template ({anilist}, {episode}, {lang}): lists the server
// under both Sub and Dub for anime.
const animeRoute = (tpl) =>
  tpl ? { supportsAnime: true, animeUrl: (id, ep, lang) => fill(tpl, { id, ep, lang }) } : {};
const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

function valid(cfg) {
  return cfg && Array.isArray(cfg.servers);
}

export function applyServers(cfg) {
  if (!valid(cfg)) return false;
  const overrides = cfg.builtin || {};
  const builtins = BUILTIN.filter((s) => overrides[s.id]?.enabled !== false).map((s) => {
    const o = overrides[s.id];
    if (!o) return s;
    const c = { ...s };
    if (o.movie) c.movieUrl = (id) => fill(o.movie, { id });
    if (o.tv) c.tvUrl = (id, season, ep) => fill(o.tv, { id, season, ep });
    return Object.assign(c, animeRoute(o.anime));
  });
  const added = cfg.servers
    .filter((s) => s && s.enabled !== false && s.movie && s.id)
    .sort((a, b) => (b.verified === true) - (a.verified === true))
    .map((s) => ({
      id: s.id,
      label: s.name || s.id,
      tag: null,
      note: s.verified === false ? "unverified" : s.note || null,
      supportsProgress: false,
      userServer: true,
      params: {},
      movieUrl: (id) => fill(s.movie, { id }),
      ...(s.tv ? { tvUrl: (id, season, ep) => fill(s.tv, { id, season, ep }) } : { movieOnly: true }),
      ...animeRoute(s.anime),
    }));
  _mirrorMap = cfg.servers
    .filter((s) => s && s.movie && Array.isArray(s.mirrors) && s.mirrors.length)
    .map((s) => ({ origin: originOf(s.movie), mirrors: s.mirrors.map(originOf).filter(Boolean) }));
  // Mutate in place: every module imported PLAYER_SOURCES by reference.
  if (import.meta.env?.VITE_WEB) {
    // Web app: Cinejoy direct always first; servers that show a "verify you're
    // human" wall or refuse to run sandboxed never appear.
    // Cinejoy direct first (ad-free); embed servers back as fallbacks, minus
    // any that show a captcha wall. Vidrift first for anime.
    const ok = added.filter((s) => !WEB_BLOCKED.has(s.id));
    const direct = builtins.filter((s) => /\.invalid\//.test(s.movieUrl?.("1") || ""));
    const rest = builtins
      .filter((s) => !direct.includes(s) && !WEB_BLOCKED.has(s.id))
      .sort((a, b) => (b.id === "vidrift") - (a.id === "vidrift"));
    PLAYER_SOURCES.splice(0, PLAYER_SOURCES.length, ...direct, ...rest, ...ok);
  } else {
    // iPhone app: Cinejoy (direct stream) stays listed first.
    const direct = builtins.filter((s) => /\.invalid\//.test(s.movieUrl?.("1") || ""));
    PLAYER_SOURCES.splice(0, PLAYER_SOURCES.length, ...direct, ...added, ...builtins.filter((s) => !direct.includes(s)));
  }
  return true;
}

// Mirror URLs (same path, mirror origin) to try after `url` fails to load.
export function mirrorsFor(url) {
  const o = originOf(url);
  const hit = o && _mirrorMap.find((m) => m.origin === o);
  if (!hit) return [];
  const rest = url.slice(o.length);
  return hit.mirrors.map((m) => m + rest);
}

export async function loadServers() {
  let cfg = bundled;
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (valid(cached)) cfg = cached;
  } catch {}
  applyServers(cfg);
  // Refresh in the background with a short timeout: boot never waits on the
  // network, and a fresh copy applies to every play that starts after it.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SERVERS_URL + "?t=" + Date.now(), {
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (res.ok) {
      const fresh = await res.json();
      if (valid(fresh)) {
        localStorage.setItem(CACHE_KEY, JSON.stringify(fresh));
        applyServers(fresh);
      }
    }
  } catch {
    // offline -> keep cached / bundled copy
  } finally {
    clearTimeout(t);
  }
}
