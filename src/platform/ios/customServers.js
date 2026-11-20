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
import { buildUrl, deriveTemplate, siteDomain, templatePlaceholders, TEMPLATE_KINDS, validateTemplate } from "../../utils/customServers/template";
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
  anime: { kind: "anime", anilist: 21, mal: 21, title: "One Piece", year: 1999, episode: 1 },
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
    createdAt: Number(s.createdAt) || Date.now(),
    updatedAt: Number(s.updatedAt) || Date.now(),
  };
}

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

/**
 * Custom-server candidates for the native player / downloader, in the order
 * the servers were added. Ids match the server menu ("custom-x:dub" when the
 * server has a Sub/Dub route).
 */
export async function customCandidates(ctx, opts = {}) {
  if (!ctx || (!ctx.tmdbId && !ctx.anilistId)) return [];
  const isAnime = !!ctx.isAnime;
  const type = ctx.type === "tv" ? "tv" : "movie";
  const dubMode = ctx.dubMode === "dub" ? "dub" : "sub";
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
        if (!tpl) return null;
        const url = buildUrl(tpl, await valuesFor(tpl, ctx, opts));
        if (!url) {
          diag("custom", `${s.name}: no link for ${type} ${ctx.tmdbId ?? ctx.anilistId} (a value is missing)`);
          return null;
        }
        const dubbable = isAnime && !!s.templates.anime && templatePlaceholders(s.templates.anime).includes("lang");
        const id = dubbable ? `${s.id}:${dubMode}` : s.id;
        return candidateFor(s, url, { id, label: s.name + (isAnime ? (dubMode === "dub" ? " · Dub" : " · Sub") : "") });
      }),
  );
  return out.filter(Boolean);
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
  const url = buildUrl(tpl, v);
  if (!url) return { ok: false, error: "The template needs a value this title doesn't have." };
  const expected = own && server.sample ? server.sample : null;
  return { ok: true, url, expected, title: own ? own.title : ref.title, reference: !own };
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

/**
 * Run the step-by-step test for every link a server has. `onStep` gets
 * progress as it comes in. Resolves to { ok, kinds: [{ kind, steps[] }], summary, playable }.
 * Steps: link built, page reached, stream found, playable, ads blocked.
 */
export async function testServer(server, { onStep } = {}) {
  const kinds = TEMPLATE_KINDS.filter((k) => server.templates[k]);
  const results = [];
  let playable = null;
  for (const kind of kinds) {
    const steps = [];
    const push = (s) => {
      steps.push(s);
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
    let r;
    try {
      r = await nativeTest().postMessage({
        candidate: candidateFor(server, link.url, { id: server.id, timeoutMs: TEST_SNIFF_TIMEOUT_MS, cache: false }),
      });
    } catch (e) {
      r = { ok: false, error: e?.message || String(e) };
    }
    const page = r?.page || {};
    push({
      id: "page",
      ok: !!page.ok,
      label: "Page reached",
      detail: page.ok
        ? `${page.status ? `HTTP ${page.status}` : "Loaded"}${page.ms != null ? ` in ${(page.ms / 1000).toFixed(1)} s` : ""}`
        : page.error || (page.status ? `The site answered HTTP ${page.status}` : r?.error || "No answer from the site"),
    });
    const stream = r?.stream || {};
    push({
      id: "stream",
      ok: !!stream.ok,
      label: "Stream found",
      detail: stream.ok
        ? `${(stream.kind || "hls").toUpperCase()} in ${((stream.ms ?? Date.now() - t0) / 1000).toFixed(1)} s`
        : stream.error || (page.ok ? `No video stream within ${TEST_SNIFF_TIMEOUT_MS / 1000} s` : "Skipped: the page didn't load"),
    });
    const play = r?.playable || {};
    push({
      id: "playable",
      ok: !!play.ok,
      label: "Plays in Super Player",
      detail: play.ok ? play.detail || "Ready to play" : stream.ok ? play.error || "The player couldn't open the stream" : "Skipped: no stream",
    });
    const ads = r?.ads || {};
    const blocked = (ads.popups || 0) + (ads.redirects?.length || 0);
    push({
      id: "ads",
      ok: ads.filter !== false,
      label: "Ads blocked",
      detail: ads.filter === false
        ? "The ad filter isn't active"
        : blocked
          ? `Stopped ${ads.popups || 0} pop-up${ads.popups === 1 ? "" : "s"} and ${ads.redirects?.length || 0} redirect${ads.redirects?.length === 1 ? "" : "s"}${ads.redirects?.length ? ` (${ads.redirects.slice(0, 3).join(", ")})` : ""}`
          : "Filter on; this page didn't try any",
    });
    if (stream.ok && play.ok && !playable) playable = { kind, url: link.url };
    results.push({ kind, steps });
  }
  const ok = results.length > 0 && results.every((k) => k.steps.every((s) => s.ok));
  const working = results.filter((k) => k.steps.find((s) => s.id === "playable")?.ok).map((k) => k.kind);
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
