// Custom servers (Settings → Custom Servers): sites the viewer adds by
// pasting one link. Each site is saved with a URL template per kind of link
// (movie / series / anime) and the lists it joins. It then shows up in the
// server sheet, the native player's server menu and the download sheet, and
// plays like ani.pm: the link loads in a hidden web view, the stream is
// captured and Super Player's own player runs it (StreamSniffer in
// StreambertPlayer.swift). Pop-ups and redirects off the site are blocked
// there (`lockHost`).
//
// Storage: one app-wide localStorage key (in every backup) plus a Keychain
// copy, so the list survives app updates and a cleared web view.
import { storage, secureStorage } from "../../utils/storage";
import { fetchImdbId, lastTmdbKey, tmdbFetch } from "../../utils/api";
import { normalizeSiteServer, resolveSiteServer, siteAdderEnabled } from "./siteServers";
import { buildUrl, deriveTemplate, normalizeSlugStyle, siteDomain, templatePlaceholders, TEMPLATE_KINDS, validateTemplate } from "../../utils/customServers/template";
import { DIRECT_METHODS, EXTRACT_TYPES, validateDirect, checkTitle } from "../../utils/customServers/direct";
import { cachedResolve, learnDirect, testDirect, DIRECT_TIMEOUT_MS } from "./customDirect";
import { matchSample, withTimeout, LOOKUP_TIMEOUT_MS } from "../../utils/customServers/match";
import { isAutoPick } from "./autoServer";
import { diag } from "../../utils/diag";

/** localStorage key (app-wide, listed in BACKUP_KEYS). */
export const CUSTOM_SERVERS_KEY = "customServers";
const KEYCHAIN_KEY = "customServers";
/** Ids of custom servers start with this; their placeholder links use CUSTOM_HOST. */
export const CUSTOM_ID_PREFIX = "custom-";
const CUSTOM_HOST = "sp-custom.invalid";
export const CHANGED_EVENT = "sb-custom-servers-changed";
/** The hidden page of a custom site gets this long to show a stream when playing. */
export const CUSTOM_SNIFF_TIMEOUT_MS = 9000;
/** A Test waits a little longer, so a slow site gets a clear answer. */
export const TEST_SNIFF_TIMEOUT_MS = 15000;
/** Play waits at most this long for an IMDb / MAL id a template needs. */
const ID_LOOKUP_WAIT_MS = 2500;
const MAX_NAME_LENGTH = 40;
const MAX_SERVERS = 50;

/**
 * How a site plays. "auto": its API first (like Cinejoy), the page if that
 * fails or takes longer than DIRECT_TIMEOUT_MS; "direct": API only; "page":
 * load the page and capture the stream (the original way).
 */
export const MODES = Object.freeze(["auto", "direct", "page"]);
export const DEFAULT_MODE = "auto";
/** Direct definitions are kept per kind of link, plus one hand-written fallback. */
const DIRECT_SLOTS = [...TEMPLATE_KINDS, "manual"];
/** A failed silent learn on play isn't retried for this long. */
const LEARN_RETRY_MS = 24 * 60 * 60_000;

/** Lists a server can join. */
export const LISTS = Object.freeze([
  { key: "anime", label: "Anime" },
  { key: "movies", label: "Movies" },
  { key: "tv", label: "TV Shows" },
]);

/** Titles the Test uses for a link kind the sample didn't cover. */
export const REFERENCE_TITLES = Object.freeze({
  movie: { kind: "movie", tmdb: 27205, imdb: "tt1375666", title: "Inception", year: 2010 },
  tv: { kind: "tv", tmdb: 1396, imdb: "tt0903747", title: "Breaking Bad", year: 2008, season: 1, episode: 1 },
  // tmdb: One Piece on TMDB, for sites whose anime route takes TMDB ids.
  anime: { kind: "anime", anilist: 21, mal: 21, tmdb: 37854, title: "One Piece", altTitles: ["ONE PIECE"], year: 1999, season: 1, episode: 1 },
});

// ── Store ─────────────────────────────────────────────────────────────────

const newId = () => CUSTOM_ID_PREFIX + Math.random().toString(36).slice(2, 10);

/** A saved server with every field in its expected shape (unknown fields dropped). */
export function normalizeServer(s) {
  if (!s || typeof s !== "object") return null;
  if (s.kind === "site") return normalizeSiteServer(s, CUSTOM_ID_PREFIX);
  const templates = {};
  const guessed = {};
  for (const k of TEMPLATE_KINDS) {
    const t = typeof s.templates?.[k] === "string" ? s.templates[k].trim() : "";
    if (t && !validateTemplate(t)) {
      templates[k] = t;
      if (s.guessed?.[k]) guessed[k] = true;
    }
  }
  if (!Object.keys(templates).length) return null;
  const firstTemplate = templates.movie || templates.tv || templates.anime;
  const lists = {
    anime: !!s.lists?.anime,
    movies: !!s.lists?.movies,
    tv: !!s.lists?.tv,
  };
  const host = siteDomain(firstTemplate.replace(/\{[a-z]+\}/g, "1"));
  return {
    id: typeof s.id === "string" && s.id.startsWith(CUSTOM_ID_PREFIX) ? s.id : newId(),
    name: String(s.name || host || "Custom server").trim().slice(0, MAX_NAME_LENGTH),
    sample: typeof s.sample === "string" ? s.sample.trim() : "",
    site: host,
    templates,
    guessed,
    lists,
    match: s.match && typeof s.match === "object"
      ? {
          kind: s.match.kind,
          title: String(s.match.title || ""),
          year: Number(s.match.year) || null,
          ids: { ...(s.match.ids || {}) },
          season: Number(s.match.season) || null,
          episode: Number(s.match.episode) || null,
        }
      : null,
    lastTest: s.lastTest && typeof s.lastTest === "object" ? { ok: !!s.lastTest.ok, at: Number(s.lastTest.at) || 0, summary: String(s.lastTest.summary || "") } : null,
    mode: MODES.includes(s.mode) ? s.mode : DEFAULT_MODE,
    direct: normalizeDirectMap(s.direct),
    directNotes: Object.fromEntries(DIRECT_SLOTS.filter((k) => typeof s.directNotes?.[k] === "string").map((k) => [k, s.directNotes[k].slice(0, 200)])),
    learnTried: Object.fromEntries(TEMPLATE_KINDS.filter((k) => Number(s.learnTried?.[k])).map((k) => [k, Number(s.learnTried[k])])),
    slugStyle: s.slugStyle ? normalizeSlugStyle(s.slugStyle) : null,
    icon: typeof s.icon === "string" && /^https?:\/\//.test(s.icon) ? s.icon : null,
    createdAt: Number(s.createdAt) || Date.now(),
    updatedAt: Number(s.updatedAt) || Date.now(),
  };
}

/** A saved direct definition in its expected shape, or null when it can't work. */
export function normalizeDirect(d) {
  if (!d || typeof d !== "object" || typeof d.url !== "string") return null;
  const def = {
    url: d.url.trim(),
    method: DIRECT_METHODS.includes(d.method) ? d.method : "GET",
    headers: plainHeaders(d.headers),
    body: typeof d.body === "string" && d.body ? d.body : null,
    extract: EXTRACT_TYPES.includes(d.extract?.type)
      ? d.extract.type === "path"
        ? { type: "path", path: String(d.extract.path || "") }
        : { type: "regex", pattern: String(d.extract.pattern || "") }
      : null,
    streamHeaders: plainHeaders(d.streamHeaders),
    source: d.source === "manual" ? "manual" : "auto",
    learnedAt: Number(d.learnedAt) || null,
  };
  return validateDirect(def) ? null : def;
}

// Only string headers, never Cookie or Authorization (nothing session-bound is kept).
function plainHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h && typeof h === "object" ? h : {})) {
    if (typeof v === "string" && /^[A-Za-z0-9-]+$/.test(k) && !/^(cookie|authorization)$/i.test(k)) out[k] = v;
  }
  return out;
}

function normalizeDirectMap(m) {
  const out = {};
  for (const k of DIRECT_SLOTS) {
    const d = normalizeDirect(m?.[k]);
    if (d) out[k] = d;
  }
  return out;
}

/** The direct definition a server uses for a kind of link (learned first, then hand-written). */
export const directFor = (s, kind) => (s.mode === "page" ? null : s.direct?.[kind] || s.direct?.manual || null);

/** Every saved custom server, in the order they were added. */
export function listCustomServers() {
  const raw = storage.get(CUSTOM_SERVERS_KEY);
  return Array.isArray(raw) ? raw.map(normalizeServer).filter(Boolean) : [];
}

const listeners = new Set();
/** Called with the new list after every change; returns an unsubscribe. */
export function onCustomServersChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let applyHook = null;
/** servers.js registers how to rebuild PLAYER_SOURCES after a change. */
export const setCustomServersApplyHook = (fn) => (applyHook = fn);

function announce(list) {
  applyHook?.();
  for (const fn of listeners) fn(list);
  try {
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: list.length }));
  } catch (e) {
    diag("custom", `change event failed: ${e?.message || e}`);
  }
}

/** Write the list to localStorage and the Keychain (awaited: saved means both). */
async function writeAll(list) {
  if (!storage.set(CUSTOM_SERVERS_KEY, list)) throw new Error("Couldn't save: the phone's storage is full.");
  try {
    await secureStorage.set(KEYCHAIN_KEY, JSON.stringify(list));
  } catch (e) {
    // localStorage holds it; only the update-proof copy is missing.
    diag("custom", `Keychain copy not saved: ${e?.message || e}`);
  }
  announce(list);
  return list;
}

/** Add or update one server (matched by id). Resolves to the saved server. */
export async function saveCustomServer(server) {
  const s = normalizeServer({ ...server, updatedAt: Date.now() });
  if (!s) throw new Error("This server has no working link template.");
  const list = listCustomServers();
  const i = list.findIndex((x) => x.id === s.id);
  if (i < 0 && list.length >= MAX_SERVERS) throw new Error(`You can add up to ${MAX_SERVERS} custom servers.`);
  if (i >= 0) list[i] = { ...s, createdAt: list[i].createdAt };
  else list.push(s);
  await writeAll(list);
  return s;
}

/** Remove one server. */
export async function deleteCustomServer(id) {
  const list = listCustomServers();
  const next = list.filter((s) => s.id !== id);
  if (next.length !== list.length) await writeAll(next);
}

/** Store a test result on the server (shown in the list). */
export async function recordTestResult(id, result) {
  const list = listCustomServers();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  s.lastTest = { ok: !!result.ok, at: Date.now(), summary: result.summary || "" };
  await writeAll(list);
}

/**
 * Store what Direct learning found for one kind: the definition, or why
 * there is none (shown in the Test and the summary).
 */
export async function recordDirect(id, kind, def, note = "") {
  const list = listCustomServers();
  const s = list.find((x) => x.id === id);
  if (!s) return;
  s.direct = { ...s.direct };
  s.directNotes = { ...s.directNotes };
  s.learnTried = { ...s.learnTried, [kind]: Date.now() };
  if (def) {
    s.direct[kind] = def;
    delete s.directNotes[kind];
  } else if (note) {
    s.directNotes[kind] = note;
  }
  await writeAll(list);
}

/**
 * Launch: bring the list back from the Keychain when localStorage lost it
 * (web view data cleared, or a restore from an older backup), then apply.
 */
export async function restoreCustomServers() {
  const local = listCustomServers();
  if (local.length) {
    applyHook?.();
    // Keep the Keychain copy in step (a restored backup only wrote localStorage).
    await secureStorage.set(KEYCHAIN_KEY, JSON.stringify(local)).catch((e) => diag("custom", `Keychain copy not saved: ${e?.message || e}`));
    return;
  }
  let raw = null;
  try {
    raw = await secureStorage.get(KEYCHAIN_KEY);
  } catch (e) {
    diag("custom", `Keychain read failed: ${e?.message || e}`);
    return;
  }
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    const list = Array.isArray(saved) ? saved.map(normalizeServer).filter(Boolean) : [];
    if (!list.length) return;
    storage.set(CUSTOM_SERVERS_KEY, list);
    diag("custom", `restored ${list.length} custom server(s) from the Keychain`);
    announce(list);
  } catch (e) {
    diag("custom", `Keychain copy unreadable: ${e?.message || e}`);
  }
}

// ── Lists and the server pickers ──────────────────────────────────────────

export const isCustomId = (id) => typeof id === "string" && id.startsWith(CUSTOM_ID_PREFIX);

/** Whether a server joins the list for this title (anime / movie / series). */
export function serverFits(s, { isAnime, type }) {
  if (s.kind === "site") return isAnime ? !!s.lists.anime : type === "tv" ? !!s.lists.tv : !!s.lists.movies;
  if (!s?.lists) return false;
  if (isAnime) return !!s.lists.anime && !!templateFor(s, { isAnime, type, dubMode: "sub" });
  return type === "tv" ? !!s.lists.tv && !!s.templates.tv : !!s.lists.movies && !!s.templates.movie;
}

/**
 * The template a server uses for a title: anime titles take the anime
 * template (AniList / MAL ids) and fall back to the TMDB one for their kind.
 * Dub needs a template with {lang}: Dub never silently plays Sub.
 */
export function templateFor(s, { isAnime, type, dubMode }) {
  const tmdbTpl = type === "tv" ? s.templates.tv : s.templates.movie;
  const candidates = isAnime ? [s.templates.anime, tmdbTpl] : [tmdbTpl];
  const dub = isAnime && dubMode === "dub";
  return candidates.find((t) => t && (!dub || templatePlaceholders(t).includes("lang"))) || null;
}

const keyUrl = (id, ...parts) => `https://${CUSTOM_HOST}/${id}/${parts.map((p) => encodeURIComponent(p ?? "")).join("/")}`;

/**
 * Custom servers as PLAYER_SOURCES entries, so the server sheet, the native
 * server menu and the pages list them. Their URLs are placeholders
 * (CUSTOM_HOST): the real link needs the whole title (name, year, ids), so
 * customCandidates() builds it when Play starts.
 */
export function customPlayerSources() {
  return listCustomServers().map((s) => {
    const dubbable = !!s.templates.anime && templatePlaceholders(s.templates.anime).includes("lang");
    return {
      id: s.id,
      label: s.name,
      tag: null,
      note: "Custom",
      custom: true,
      customLists: s.lists,
      supportsProgress: false,
      supportsAnime: !!s.lists.anime,
      params: {},
      movieUrl: (id) => keyUrl(s.id, "movie", id),
      tvUrl: (id, season, ep) => keyUrl(s.id, "tv", id, season, ep),
      ...(dubbable ? { animeUrl: (anilistId, ep, lang) => keyUrl(s.id, "anime", anilistId, ep, lang) } : {}),
    };
  });
}

/** Whether a PLAYER_SOURCES entry is shown for this title (built-ins always are). */
export function sourceFitsTitle(src, { isAnime, type }) {
  if (!src?.custom) return true;
  const s = listCustomServers().find((x) => x.id === src.id);
  return !!s && serverFits(s, { isAnime, type });
}

// ── Building links for a title ───────────────────────────────────────────

// Ids a template may need that the page doesn't carry, looked up once per session.
const imdbIds = new Map(); // "movie:27205" -> Promise<string|null>
const malIds = new Map(); // anilist id -> Promise<number|null>
const ANILIST_MAL = "query ($id: Int) { Media(id: $id, type: ANIME) { idMal } }";

/** POST one AniList GraphQL query; resolves to `data`. */
export async function anilistQuery(query, variables, { signal } = {}) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json?.errors?.length) throw new Error(`AniList: ${json.errors[0]?.message || "error"}`);
  return json?.data;
}

function imdbFor(type, tmdbId) {
  const key = `${type}:${tmdbId}`;
  if (!imdbIds.has(key)) {
    imdbIds.set(
      key,
      fetchImdbId(type, tmdbId, lastTmdbKey()).catch((e) => {
        diag("custom", `no IMDb id for ${key}: ${e?.message || e}`);
        imdbIds.delete(key);
        return null;
      }),
    );
  }
  return imdbIds.get(key);
}

function malFor(anilistId) {
  if (!malIds.has(anilistId)) {
    malIds.set(
      anilistId,
      anilistQuery(ANILIST_MAL, { id: Number(anilistId) })
        .then((d) => d?.Media?.idMal || null)
        .catch((e) => {
          diag("custom", `no MAL id for AniList ${anilistId}: ${e?.message || e}`);
          malIds.delete(anilistId);
          return null;
        }),
    );
  }
  return malIds.get(anilistId);
}

/**
 * Values to fill a template with for the title on screen. Episode numbers
 * follow the template's ids: AniList / MAL routes count episodes per AniList
 * entry, TMDB routes per TMDB season.
 */
export async function valuesFor(template, ctx, { waitMs = ID_LOOKUP_WAIT_MS } = {}) {
  const used = templatePlaceholders(template);
  const animeIds = used.includes("anilist") || used.includes("mal");
  const v = {
    tmdb: ctx.tmdbId ?? null,
    anilist: ctx.anilistId ?? null,
    title: ctx.title || null,
    year: ctx.year || null,
    season: ctx.tmdbSeason ?? ctx.season ?? 1,
    episode: animeIds ? ctx.anilistEpisode ?? ctx.episode ?? 1 : ctx.tmdbEpisode ?? ctx.episode ?? 1,
    absolute: ctx.absoluteEpisode ?? null,
    lang: ctx.dubMode === "dub" ? "dub" : "sub",
    imdb: ctx.imdbId || null,
    mal: ctx.malId || null,
  };
  const wait = (p) => withTimeout(p, waitMs, "id lookup").catch(() => null);
  const jobs = [];
  if (used.includes("imdb") && !v.imdb && v.tmdb) jobs.push(wait(imdbFor(ctx.type === "tv" ? "tv" : "movie", v.tmdb)).then((x) => (v.imdb = x)));
  if (used.includes("mal") && !v.mal && v.anilist) jobs.push(wait(malFor(v.anilist)).then((x) => (v.mal = x)));
  await Promise.all(jobs);
  return v;
}

/** Whether a source URL is a custom server's placeholder (never loaded as a page). */
export const isCustomPlaceholder = (url) => String(url || "").includes(`//${CUSTOM_HOST}/`);

/** Which kind of link a template is on a server ("movie" | "tv" | "anime"). */
const kindOfTemplate = (s, tpl) => TEMPLATE_KINDS.find((k) => s.templates[k] === tpl) || "movie";

// Page links whose play should also learn the site's API (silently), by link.
const pendingLearn = new Map(); // url -> { serverId, kind, values, want }

/** TMDB's idea of the title on screen, for title checks. */
const wantFor = (ctx, values, kind) => ({
  kind: kind === "movie" ? "movie" : "tv",
  title: ctx.title || "",
  year: ctx.year || null,
  tmdb: values.tmdb,
  imdb: values.imdb,
});

/**
 * Custom-server candidates for the native player / downloader, in the order
 * the servers were added. Ids match the server menu ("custom-x:dub" when the
 * server has a Sub/Dub route). A server with a learned API gives its stream
 * first ("<stream>#sb-direct", like Cinejoy), then its page as the fallback
 * (mode "auto"). An API that answers for another title drops the server.
 * @param {{ directTimeoutMs?: number }} opts
 */
export async function customCandidates(ctx, opts = {}) {
  if (!ctx || (!ctx.tmdbId && !ctx.anilistId)) return [];
  const isAnime = !!ctx.isAnime;
  const type = ctx.type === "tv" ? "tv" : "movie";
  const dubMode = ctx.dubMode === "dub" ? "dub" : "sub";
  const directTimeoutMs = opts.directTimeoutMs ?? DIRECT_TIMEOUT_MS;
  const out = await Promise.all(
    listCustomServers()
      .filter((s) => serverFits(s, { isAnime, type }))
      .map(async (s) => {
        if (s.kind === "site") {
          if (!siteAdderEnabled()) return null;
          const r = await resolveSiteServer(s, ctx).catch(() => null);
          return r ? candidateFor(s, r.url) : null;
        }
        const tpl = templateFor(s, { isAnime, type, dubMode });
        if (!tpl) return [];
        const values = { ...(await valuesFor(tpl, ctx, opts)), slugStyle: s.slugStyle };
        const url = buildUrl(tpl, values);
        if (!url) {
          diag("custom", `${s.name}: no link for ${type} ${ctx.tmdbId ?? ctx.anilistId} (a value is missing)`);
          return [];
        }
        const dubbable = isAnime && !!s.templates.anime && templatePlaceholders(s.templates.anime).includes("lang");
        const id = dubbable ? `${s.id}:${dubMode}` : s.id;
        const label = s.name + (isAnime ? (dubMode === "dub" ? " · Dub" : " · Sub") : "");
        const kind = kindOfTemplate(s, tpl);
        const def = directFor(s, kind);
        const list = [];
        if (def) {
          const want = wantFor(ctx, values, kind);
          const r = await cachedResolve(`${s.id}:${url}`, def, values, want, { timeoutMs: directTimeoutMs });
          if (r.check === "mismatch") {
            diag("custom", `${s.name}: its API answered for another title than ${ctx.title}; skipped`);
            return [];
          }
          if (r.ok) list.push({ id, label, url: `${r.stream}#sb-direct`, headers: def.streamHeaders, direct: true });
        }
        if (s.mode !== "direct" || !def) {
          const learn = s.mode !== "page" && !def && Date.now() - (s.learnTried?.[kind] || 0) > LEARN_RETRY_MS;
          if (learn) pendingLearn.set(url, { serverId: s.id, kind, values, want: wantFor(ctx, values, kind) });
          list.push({ ...candidateFor(s, url, { id, label }), ...(learn ? { learn: true } : {}) });
        }
        return list;
      }),
  );
  return out.flat();
}

/** Start the direct lookups for a title now (title page opened), so Play doesn't wait. */
export function prefetchCustomDirect(ctx) {
  customCandidates(ctx).catch((e) => diag("custom", `prefetch: ${e?.message || e}`));
}

/**
 * The first play of a page link that had no API yet: the native sniffer
 * sends what the page did, and the API is learned in the background.
 * window.__sbCustomLearn({ link, stream, headers, page, log })
 */
export async function learnFromPlay(payload) {
  const job = pendingLearn.get(payload?.link);
  if (!job) return;
  pendingLearn.delete(payload.link);
  const s = listCustomServers().find((x) => x.id === job.serverId);
  if (!s || directFor(s, job.kind)) return;
  const r = await learnDirect({
    kind: job.kind,
    values: job.values,
    want: job.want,
    stream: payload.stream,
    streamHeaders: payload.headers || {},
    log: payload.log,
    page: payload.page || payload.link,
  });
  diag("custom", `${s.name}: learned on play: ${r.ok ? `direct API (${r.via})` : r.reason}`);
  await recordDirect(s.id, job.kind, r.ok ? r.def : null, r.ok ? "" : r.reason);
}
if (typeof window !== "undefined") {
  window.__sbCustomLearn = (p) => {
    learnFromPlay(p).catch((e) => diag("custom", `learn on play failed: ${e?.message || e}`));
  };
}

/** One native candidate for a server's link. */
export const candidateFor = (s, url, { id = s.id, label = s.name, timeoutMs = CUSTOM_SNIFF_TIMEOUT_MS, cache = true } = {}) => ({
  id,
  label,
  url,
  lockHost: s.site,
  timeoutMs,
  cache,
});

/**
 * Merge custom candidates into the play / download order. A custom server
 * picked by hand plays first; otherwise they follow the direct streams
 * (ani.pm, Movy, Cinejoy) and come before the embed servers, since the
 * viewer added them on purpose.
 * @param {Array<{id:string,url:string}>} list the built-in order
 * @param {Array<object>} custom from customCandidates()
 * @param {string|null} picked the viewer's server (null in Auto)
 */
export function withCustom(list, custom, picked = null) {
  if (!custom?.length) return list;
  const pick = picked ? custom.filter((c) => c.id.split(":")[0] === picked) : [];
  const rest = custom.filter((c) => !pick.includes(c));
  if (pick.length) return [...pick, ...list, ...rest];
  const lead = list.findIndex((c) => !/#sb-direct$/.test(c.url));
  const at = lead < 0 ? list.length : lead;
  return [...list.slice(0, at), ...rest, ...list.slice(at)];
}

/** The server the viewer picked by hand when it is a custom one, else null. */
export function pickedCustomId() {
  if (isAutoPick()) return null;
  const id = storage.get("playerSource");
  return isCustomId(id) ? id : null;
}

// ── Adding a site ─────────────────────────────────────────────────────────

/**
 * Read a pasted link: match it to a title and build its template, then fill
 * in guesses for the other kinds the chosen lists need.
 * @returns {Promise<{ ok, error?, match?, detected?, alternatives?, templates?, guessed? }>}
 */
export async function analyzeSample(sample, { apiKey = lastTmdbKey(), prefer = null } = {}) {
  const tmdb = apiKey ? (path) => tmdbFetch(path, apiKey, { kidsRaw: true }) : null;
  const anilist = (q, v) => anilistQuery(q, v);
  const res = await matchSample(sample, { tmdb, anilist, prefer, timeoutMs: LOOKUP_TIMEOUT_MS });
  if (!res.ok) return res;
  const kind = res.detected.kind;
  const templates = { [kind]: res.detected.template };
  const guessed = {};
  for (const other of ["movie", "tv"]) {
    if (templates[other]) continue;
    const g = deriveTemplate(res.detected.template, kind, other);
    if (g) {
      templates[other] = g;
      guessed[other] = true;
    }
  }
  return { ...res, templates, guessed };
}

/** Lists a fresh server joins by default: the kind of link that was pasted. */
export function defaultLists(kind) {
  return { anime: kind === "anime", movies: kind === "movie", tv: kind === "tv" };
}

/** Kinds of link a server needs for its lists (Anime can use a TV/movie link). */
export function neededKinds(lists) {
  const k = [];
  if (lists.movies) k.push("movie");
  if (lists.tv) k.push("tv");
  if (lists.anime) k.push("anime");
  return k;
}

/** Why a server can't be saved yet, or null. */
export function saveProblem(draft) {
  if (!draft.lists.anime && !draft.lists.movies && !draft.lists.tv) return "Pick at least one list.";
  if (draft.lists.movies && !draft.templates.movie) return "Movies needs a movie link.";
  if (draft.lists.tv && !draft.templates.tv) return "TV Shows needs a TV link.";
  if (draft.lists.anime && !draft.templates.anime && !draft.templates.tv && !draft.templates.movie) return "Anime needs an anime link.";
  for (const [k, t] of Object.entries(draft.templates)) {
    const err = t && validateTemplate(t);
    if (err) return `${k === "tv" ? "TV" : k[0].toUpperCase() + k.slice(1)} link: ${err}`;
  }
  const manual = draft.direct?.manual;
  if (manual && (manual.url || manual.extract?.path)) {
    const err = validateDirect(manual);
    if (err) return `Manual API: ${err}`;
  }
  return null;
}

// ── Test ─────────────────────────────────────────────────────────────────

const nativeTest = () => window.webkit?.messageHandlers?.sbServerTest || null;
export const canTestNatively = () => !!nativeTest();

/**
 * The link the Test opens for one kind: the pasted sample's own title when
 * it is that kind, else a well-known reference title. `expected` is the
 * pasted link, when the template should rebuild it exactly.
 */
export function testLinkFor(server, kind) {
  const tpl = server.templates[kind];
  if (!tpl) return { ok: false, error: `No ${kind} link` };
  const own = server.match && server.match.kind === kind ? server.match : null;
  const ref = REFERENCE_TITLES[kind];
  const v = own
    ? { ...own.ids, title: own.title, year: own.year, season: own.season ?? 1, episode: own.episode ?? 1, lang: "sub" }
    : { ...ref, lang: "sub" };
  // Season / episode / lang as they were in the sample, so the rebuilt link matches it.
  if (own && server.sample) Object.assign(v, sampleNumbers(tpl, server.sample));
  v.slugStyle = server.slugStyle;
  const url = buildUrl(tpl, v);
  if (!url) return { ok: false, error: "The template needs a value this title doesn't have." };
  const expected = own && server.sample ? server.sample : null;
  const title = own ? own.title : ref.title;
  const want = { kind: kind === "movie" ? "movie" : "tv", title, altTitles: (own || ref).altTitles || [], year: v.year, tmdb: v.tmdb, imdb: v.imdb };
  return { ok: true, url, expected, title, reference: !own, values: v, want };
}

/** Season / episode / lang read back out of the sample at the template's places. */
export function sampleNumbers(template, sample) {
  const names = [];
  const re = new RegExp(
    "^" +
      template
        .split(/(\{[a-z]+\})/)
        .map((part) => {
          const m = /^\{([a-z]+)\}$/.exec(part);
          if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          names.push(m[1]);
          return "(.+?)";
        })
        .join("") +
      "$",
    "i",
  );
  const m = re.exec(sample);
  if (!m) return {};
  const out = {};
  names.forEach((n, i) => {
    if (n === "season" || n === "episode") out[n] = Number(m[i + 1]) || 1;
    if (n === "lang") out.lang = /dub/i.test(m[i + 1]) ? "dub" : "sub";
  });
  return out;
}

/** Open one link in the hidden page (native), with the learn log on. */
export async function nativeTry(server, url, { timeoutMs = TEST_SNIFF_TIMEOUT_MS, learn = true } = {}) {
  try {
    return await nativeTest().postMessage({
      candidate: { ...candidateFor(server, url, { id: server.id, timeoutMs, cache: false }), learn },
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Whether the native headless player can open a stream with these headers. */
export async function nativePlayable(url, headers) {
  if (!nativeTest()) return { ok: false, error: "Checking playback needs the iPhone app." };
  try {
    const r = await nativeTest().postMessage({ playable: { url, headers } });
    return r?.ok ? { ok: true, detail: r.detail } : { ok: false, error: r?.error || "The player couldn't open the stream" };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Steps for what one hidden page did (page, stream, playable, title, ads). */
export function pageSteps(r, { title, want, site, t0 = Date.now() }) {
  const steps = [];
  const page = r?.page || {};
  steps.push({
    id: "page",
    ok: !!page.ok && !page.wall,
    label: "Page reached",
    detail: page.wall
      ? `${page.wall}: the site shows a bot check to the app`
      : page.ok
        ? `${page.status ? `HTTP ${page.status}` : "Loaded"}${page.ms != null ? ` in ${(page.ms / 1000).toFixed(1)} s` : ""}`
        : page.error || (page.status ? `The site answered HTTP ${page.status}` : r?.error || "No answer from the site"),
  });
  const stream = r?.stream || {};
  steps.push({
    id: "stream",
    ok: !!stream.ok,
    label: "Stream found",
    detail: stream.ok
      ? `${(stream.kind || "hls").toUpperCase()} in ${((stream.ms ?? Date.now() - t0) / 1000).toFixed(1)} s`
      : stream.error || (page.ok ? `No video stream within ${TEST_SNIFF_TIMEOUT_MS / 1000} s` : "Skipped: the page didn't load"),
  });
  const play = r?.playable || {};
  steps.push({
    id: "playable",
    ok: !!play.ok,
    label: "Plays in Super Player",
    detail: play.ok ? play.detail || "Ready to play" : stream.ok ? play.error || "The player couldn't open the stream" : "Skipped: no stream",
  });
  // The page's title against TMDB's: the link must open the title asked for.
  const verdict = page.title ? checkTitle(page.title, want, [site || ""]) : "unknown";
  steps.push({
    id: "title",
    ok: verdict !== "mismatch",
    neutral: verdict === "unknown",
    label: "Right title",
    detail: verdict === "match" ? `The page is ${title}` : verdict === "mismatch" ? `The page says "${page.title}", not ${title}` : "The page doesn't name the title",
  });
  const ads = r?.ads || {};
  const blocked = (ads.popups || 0) + (ads.redirects?.length || 0);
  steps.push({
    id: "ads",
    ok: ads.filter !== false,
    label: "Ads blocked",
    detail: ads.filter === false
      ? "The ad filter isn't active"
      : blocked
        ? `Stopped ${ads.popups || 0} pop-up${ads.popups === 1 ? "" : "s"} and ${ads.redirects?.length || 0} redirect${ads.redirects?.length === 1 ? "" : "s"}${ads.redirects?.length ? ` (${ads.redirects.slice(0, 3).join(", ")})` : ""}`
        : "Filter on; this page didn't try any",
  });
  return steps;
}

/**
 * Learn (or re-check) Direct mode for one kind after its page was tried.
 * @returns {Promise<{ steps, def, note }>}
 */
export async function directSteps(server, kind, link, r) {
  const steps = [];
  let def = server.direct?.[kind] || null;
  let note = "";
  if (!def && r?.stream?.ok) {
    const learned = await learnDirect({
      kind,
      values: link.values,
      want: link.want,
      stream: r.stream.url,
      streamHeaders: r.stream.headers || {},
      log: r.learn,
      page: link.url,
    });
    if (learned.ok) def = learned.def;
    else note = learned.reason;
  } else if (!def) {
    note = "Needs a working page first.";
  }
  steps.push({
    id: "direct",
    ok: true,
    neutral: !def,
    label: def ? "Direct mode available ✓" : "Direct mode",
    detail: def
      ? `Plays from the site's API (${new URL(def.url.replace(/\{[a-z]+\}/g, "1")).host}), no page`
      : `${note} Keeps Page mode.`,
  });
  const use = def || server.direct?.manual || null;
  if (use) {
    const t = await testDirect(use, link.values, link.want, { playable: nativePlayable });
    steps.push(...t.steps);
    if (!t.ok && def && !server.direct?.[kind]) {
      // Learned but not working on replay: don't keep it.
      note = t.steps.find((x) => !x.ok)?.detail || "The API didn't work on a second try.";
      def = null;
    }
  }
  return { steps, def, note };
}

/**
 * Run the step-by-step test for every link a server has. `onStep` gets
 * progress as it comes in. Resolves to { ok, kinds: [{ kind, steps[] }], summary, playable }.
 * Steps: link built, page reached, stream found, playable, right title, ads
 * blocked, then Direct mode (learned from the page) and its own test.
 * Learned APIs are saved on the server.
 */
export async function testServer(server, { onStep } = {}) {
  const kinds = TEMPLATE_KINDS.filter((k) => server.templates[k]);
  const results = [];
  let playable = null;
  for (const kind of kinds) {
    const steps = [];
    const push = (...s) => {
      steps.push(...s);
      onStep?.({ kind, steps: steps.slice() });
    };
    const link = testLinkFor(server, kind);
    if (!link.ok) {
      push({ id: "link", ok: false, label: "Link built", detail: link.error });
      results.push({ kind, steps });
      continue;
    }
    const rebuilt = !link.expected || link.expected.replace(/\/$/, "") === link.url.replace(/\/$/, "");
    push({
      id: "link",
      ok: rebuilt,
      label: "Link built",
      detail: rebuilt
        ? `${link.reference ? `${link.title} (test title)` : link.title}: ${link.url}`
        : `Rebuilt ${link.url} but you pasted ${link.expected}. Check the template.`,
    });
    if (!nativeTest()) {
      push({ id: "page", ok: false, label: "Page reached", detail: "Testing a site needs the iPhone app." });
      results.push({ kind, steps });
      continue;
    }
    const t0 = Date.now();
    const r = await nativeTry(server, link.url, { learn: server.mode !== "page" });
    push(...pageSteps(r, { title: link.title, want: link.want, site: server.name, t0 }));
    if (server.mode !== "page") {
      const d = await directSteps(server, kind, link, r);
      push(...d.steps);
      await recordDirect(server.id, kind, d.def, d.note);
    }
    if (r?.stream?.ok && r?.playable?.ok && !playable) playable = { kind, url: link.url };
    results.push({ kind, steps });
  }
  const ok = results.length > 0 && results.every((k) => k.steps.every((s) => s.ok));
  const working = results.filter((k) => k.steps.some((s) => (s.id === "playable" || s.id === "d-playable") && s.ok)).map((k) => k.kind);
  const summary = ok
    ? "Working"
    : working.length
      ? `Works for ${working.join(", ")}`
      : results.flatMap((k) => k.steps).find((s) => !s.ok)?.detail || "Not working";
  return { ok, kinds: results, summary, playable };
}

/** Play a test link in the native player (the link the Test found working). */
export function playTest(server, url) {
  const h = window.webkit?.messageHandlers?.sbResolve;
  if (!h) return false;
  const kind = TEMPLATE_KINDS.find((k) => server.templates[k] && testLinkFor(server, k).url === url) || "movie";
  h.postMessage({
    token: `custom-test-${Date.now()}`,
    candidates: [candidateFor(server, url)],
    ctx: { title: `${server.name} · test`, type: kind === "movie" ? "movie" : "tv", startAt: 0 },
    current: server.id,
    servers: [{ id: server.id, label: server.name }],
  });
  return true;
}
