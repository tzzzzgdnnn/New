// Custom servers: what kind of title id a site uses, and how to get it.
// Sites key their links on different ids: TMDB, IMDb (tt…), TVDB, AniList,
// MyAnimeList, Kitsu, or the site's own slug / internal id. This module
//   - reads which id a link (and its page) carries: idHints(), pageFacts()
//   - converts between them: TMDB external_ids for IMDb / TVDB, the ARM
//     anime mapping API (arm.haglund.dev, built on Fribb's anime-lists) for
//     AniList / MAL / Kitsu <-> TMDB / TVDB, and the Fribb list as a fallback
//   - keeps each title's mapping per site (createMappingCache)
//   - scores loose title matches (similarity) for typos and extra words.
// Pure logic: every lookup is passed in, so Node tests run it with fakes.
import { titleWords } from "./template";

/** Id kinds a link can carry. "site": the site's own slug or number. */
export const ID_KINDS = Object.freeze(["tmdb", "imdb", "tvdb", "anilist", "mal", "kitsu", "site"]);

// Words a site puts in front of an id ("/anilist/21", "?mal=21", "tvdb-81189").
const ID_LABELS = [
  ["tmdb", /^(tmdb|themoviedb|tmdbid|tmdb_id)$/i],
  ["imdb", /^(imdb|imdbid|imdb_id)$/i],
  ["tvdb", /^(tvdb|thetvdb|tvdbid|tvdb_id)$/i],
  ["anilist", /^(anilist|al|anilistid|anilist_id|aid)$/i],
  ["mal", /^(mal|myanimelist|malid|mal_id)$/i],
  ["kitsu", /^(kitsu|kitsuid|kitsu_id)$/i],
];

/**
 * Ids a link names outright: a label word right before a number
 * ("/anilist/21/1", "?mal=21&ep=1", "/tvdb-81189"), and IMDb ids anywhere.
 * @returns {{ labelled: Array<{ kind, value }>, imdb: string[] }}
 */
export function idHints(url) {
  let s = String(url || "");
  try {
    s = decodeURIComponent(s);
  } catch {
    // Read it as typed.
  }
  const labelled = [];
  for (const m of s.matchAll(/(?<![a-z0-9])([a-z_]{2,12})[/=:_-](\d{1,9})(?![0-9])/gi)) {
    const hit = ID_LABELS.find(([, re]) => re.test(m[1]));
    if (hit) labelled.push({ kind: hit[0], value: Number(m[2]) });
  }
  const imdb = [...new Set(s.match(/tt\d{5,9}/g) || [])];
  return { labelled, imdb };
}

/** Same title, loosely: 0..1 from shared letter pairs (typos, "&", word order). */
export function similarity(a, b) {
  const x = titleWords(a).join(" ");
  const y = titleWords(b).join(" ");
  if (!x || !y) return 0;
  if (x === y) return 1;
  const pairs = (t) => {
    const out = new Map();
    for (let i = 0; i < t.length - 1; i++) {
      const p = t.slice(i, i + 2);
      if (p.includes(" ")) continue;
      out.set(p, (out.get(p) || 0) + 1);
    }
    return out;
  };
  const px = pairs(x);
  const py = pairs(y);
  let both = 0;
  let total = 0;
  for (const v of px.values()) total += v;
  for (const v of py.values()) total += v;
  for (const [p, v] of px) both += Math.min(v, py.get(p) || 0);
  return total ? (2 * both) / total : 0;
}

// ── A page's own facts ────────────────────────────────────────────────────

const decodeEntities = (t) =>
  String(t || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

const metaContent = (h, attr, name) => {
  const a = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([^"']*)["']`, "i").exec(h);
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${name}["']`, "i").exec(h);
  return decodeEntities((a || b)?.[1] || "").trim() || null;
};

const yearIn = (v) => {
  const m = /\b(19|20)\d\d\b/.exec(String(v || ""));
  return m ? Number(m[0]) : null;
};

/** Every JSON-LD object on a page, nested @graph entries included. */
function jsonLd(h) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      out.push(v);
      if (v["@graph"]) walk(v["@graph"]);
    }
  };
  for (const m of h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch {
      // A broken block: skip it.
    }
  }
  return out;
}

/** Title ids in links on a page (IMDb, TMDB, AniList, MAL, Kitsu, TVDB). */
export function idsInHtml(html) {
  const h = String(html || "");
  const ids = {};
  const first = (re, f = (m) => m[1]) => {
    const m = re.exec(h);
    return m ? f(m) : null;
  };
  ids.imdb = first(/imdb\.com\/title\/(tt\d{5,9})/i);
  const tm = /themoviedb\.org\/(movie|tv)\/(\d+)/i.exec(h);
  if (tm) {
    ids.tmdb = Number(tm[2]);
    ids.tmdbKind = tm[1].toLowerCase();
  }
  ids.anilist = first(/anilist\.co\/anime\/(\d+)/i, (m) => Number(m[1]));
  ids.mal = first(/myanimelist\.net\/anime\/(\d+)/i, (m) => Number(m[1]));
  ids.kitsu = first(/kitsu\.(?:io|app)\/anime\/(\d+)/i, (m) => Number(m[1]));
  ids.tvdb = first(/thetvdb\.com\/[^"'\s]*?(?:series|id)[/=](\d+)/i, (m) => Number(m[1]));
  for (const k of Object.keys(ids)) if (ids[k] == null) delete ids[k];
  return ids;
}

/**
 * What a page says about the title it plays: og:title / og:type, JSON-LD
 * (Movie, TVSeries, TVEpisode: name, year, season, episode, sameAs ids),
 * <title>, and title ids in its links.
 * @returns {{ title: string|null, year: number|null, kind: "movie"|"tv"|null,
 *   season: number|null, episode: number|null, episodeTitle: string|null, ids: object }}
 */
export function pageFacts(html) {
  const h = String(html || "");
  const facts = { title: null, year: null, kind: null, season: null, episode: null, episodeTitle: null, ids: idsInHtml(h) };
  for (const o of jsonLd(h)) {
    const type = [].concat(o["@type"] || []).join(" ");
    const sameAs = [].concat(o.sameAs || [], o.url || []).join(" ");
    const more = idsInHtml(sameAs);
    facts.ids = { ...more, ...facts.ids };
    if (/TVEpisode/i.test(type)) {
      facts.kind = "tv";
      facts.episodeTitle = facts.episodeTitle || o.name || null;
      facts.episode = Number(o.episodeNumber) || facts.episode;
      facts.season = Number(o.partOfSeason?.seasonNumber) || facts.season;
      const series = o.partOfSeries || o.partOfTVSeries;
      if (series?.name) facts.title = facts.title || series.name;
      facts.year = facts.year || yearIn(series?.startDate);
    } else if (/TVSeries|TVSeason/i.test(type)) {
      facts.kind = "tv";
      facts.title = facts.title || o.name || null;
      facts.year = facts.year || yearIn(o.startDate || o.datePublished);
    } else if (/Movie/i.test(type)) {
      facts.kind = facts.kind || "movie";
      facts.title = facts.title || o.name || null;
      facts.year = facts.year || yearIn(o.datePublished || o.dateCreated || o.releasedEvent?.startDate);
    }
  }
  const og = metaContent(h, "property", "og:title") || metaContent(h, "name", "twitter:title");
  const ogType = metaContent(h, "property", "og:type") || "";
  if (!facts.kind && /video\.movie/i.test(ogType)) facts.kind = "movie";
  if (!facts.kind && /video\.(tv_show|episode)/i.test(ogType)) facts.kind = "tv";
  const titleTag = /<title[^>]*>([^<]{2,200})<\/title>/i.exec(h)?.[1];
  facts.title = facts.title || og || (titleTag ? decodeEntities(titleTag).trim() : null);
  facts.year = facts.year || yearIn(metaContent(h, "property", "video:release_date")) || yearIn(og) || yearIn(titleTag);
  if (facts.title) facts.title = decodeEntities(facts.title).trim();
  return facts;
}

// ── Converting between ids ────────────────────────────────────────────────

/** ARM (arm.haglund.dev) source names for each id kind. */
const ARM_SOURCE = { anilist: "anilist", mal: "myanimelist", kitsu: "kitsu" };
/** ARM's other endpoints (by TMDB / TVDB / IMDb id), answering arrays. */
const ARM_PATH = { tmdb: "themoviedb", tvdb: "thetvdb", imdb: "imdb" };

/** The ARM link for one id. */
export function armUrl(kind, id) {
  if (ARM_SOURCE[kind]) return `https://arm.haglund.dev/api/v2/ids?source=${ARM_SOURCE[kind]}&id=${encodeURIComponent(id)}`;
  if (ARM_PATH[kind]) return `https://arm.haglund.dev/api/v2/${ARM_PATH[kind]}?id=${encodeURIComponent(id)}`;
  return null;
}
/** Fribb's full list (5.9 MB): the fallback when ARM is down. */
export const FRIBB_LIST_URL = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json";

/** One ARM or Fribb record as plain ids. */
export function normalizeAnimeRecord(r) {
  if (!r || typeof r !== "object") return null;
  const num = (v) => (v == null || v === "" ? null : Number(v) || null);
  const tmdbObj = r.themoviedb_id && typeof r.themoviedb_id === "object" ? r.themoviedb_id : null;
  const out = {
    anilist: num(r.anilist ?? r.anilist_id),
    mal: num(r.myanimelist ?? r.mal_id),
    kitsu: num(r.kitsu ?? r.kitsu_id),
    anidb: num(r.anidb ?? r.anidb_id),
    tvdb: num(r.thetvdb ?? r.tvdb_id),
    tvdbSeason: num(r["thetvdb-season"] ?? r.season?.tvdb),
    tmdb: num(r.themoviedb ?? (tmdbObj ? tmdbObj.tv ?? tmdbObj.movie : r.themoviedb_id)),
    tmdbKind: tmdbObj ? (tmdbObj.tv ? "tv" : tmdbObj.movie ? "movie" : null) : r.media === "MOVIE" || r.type === "MOVIE" ? "movie" : null,
    tmdbSeason: num(r["themoviedb-season"] ?? r.season?.tmdb),
    imdb: [].concat(r.imdb ?? r.imdb_id ?? [])[0] || null,
    format: r.media || r.type || null,
  };
  return out;
}

/**
 * Get the ids a template needs from the ids we have.
 * @param {object} have e.g. { tmdb: 1434, kind: "tv", season: 1 } or { anilist: 21 }
 * @param {string[]} want e.g. ["imdb", "tvdb", "kitsu"]
 * @param {{ tmdb?: Function, arm?: Function, fribb?: Function }} deps
 *   tmdb(path) -> JSON; arm(url) -> JSON; fribb() -> the Fribb list (array)
 * @returns {Promise<object>} have + every id found (missing ones left out)
 */
export async function convertIds(have, want, { tmdb, arm, fribb } = {}) {
  const out = { ...have };
  const need = () => want.filter((k) => out[k] == null);
  const kind = have.kind === "movie" ? "movie" : "tv";
  // TMDB -> IMDb / TVDB.
  if (tmdb && out.tmdb && need().some((k) => k === "imdb" || k === "tvdb")) {
    const x = await Promise.resolve(tmdb(`/${kind}/${out.tmdb}/external_ids`)).catch(() => null);
    if (x?.imdb_id && out.imdb == null) out.imdb = x.imdb_id;
    if (x?.tvdb_id && out.tvdb == null) out.tvdb = x.tvdb_id;
  }
  // IMDb / TVDB -> TMDB.
  if (tmdb && !out.tmdb && (out.imdb || out.tvdb)) {
    const src = out.imdb ? `${out.imdb}?external_source=imdb_id` : `${out.tvdb}?external_source=tvdb_id`;
    const r = await Promise.resolve(tmdb(`/find/${src}`)).catch(() => null);
    const hit = (kind === "movie" ? r?.movie_results : r?.tv_results)?.[0] || r?.tv_results?.[0] || r?.movie_results?.[0];
    if (hit) out.tmdb = hit.id;
  }
  // Anime ids, both ways, through ARM (then Fribb's list).
  const animeWanted = need().some((k) => ["anilist", "mal", "kitsu", "tmdb", "tvdb", "imdb"].includes(k));
  if (animeWanted && (arm || fribb)) {
    const from = ["anilist", "mal", "kitsu", "tmdb", "tvdb", "imdb"].find((k) => out[k] != null);
    let recs = [];
    if (from && arm) {
      const url = armUrl(from, out[from]);
      const r = url ? await Promise.resolve(arm(url)).catch(() => null) : null;
      recs = [].concat(r || []).map(normalizeAnimeRecord).filter(Boolean);
    }
    if (!recs.length && from && fribb) {
      const list = await Promise.resolve(fribb()).catch(() => null);
      recs = (Array.isArray(list) ? list : [])
        .map(normalizeAnimeRecord)
        .filter((r) => r && r[from] != null && String(r[from]) === String(out[from]));
    }
    // A TMDB show split over several AniList entries: the one for this season.
    const pick =
      (out.season != null && recs.find((r) => r.tmdbSeason === Number(out.season))) ||
      recs.find((r) => r.tmdbSeason == null || r.tmdbSeason === 1) ||
      recs[0];
    if (pick) for (const k of ["anilist", "mal", "kitsu", "tvdb", "tmdb", "imdb"]) if (out[k] == null && pick[k] != null) out[k] = pick[k];
  }
  return out;
}

// ── Each title's mapping, per site ────────────────────────────────────────

/**
 * A small lasting cache: "<site>|<kind>|<tmdb>" -> the site's value for the
 * title ({site} path, internal id, converted ids, episode offsets).
 * @param {{ getItem, setItem }} store localStorage or a fake
 */
export function createMappingCache(store, { key = "sbCustomTitleMap.v1", max = 3000 } = {}) {
  let data = null;
  const load = () => {
    if (data) return data;
    try {
      data = JSON.parse(store?.getItem(key) || "{}") || {};
    } catch {
      data = {};
    }
    return data;
  };
  const save = () => {
    try {
      const keys = Object.keys(data);
      if (keys.length > max) {
        keys.sort((a, b) => (data[a].t || 0) - (data[b].t || 0));
        for (const k of keys.slice(0, keys.length - max)) delete data[k];
      }
      store?.setItem(key, JSON.stringify(data));
    } catch {
      // Full storage: the cache only saves time.
    }
  };
  const k = (site, kind, id) => `${site}|${kind}|${id}`;
  return {
    get(site, kind, id) {
      return load()[k(site, kind, id)]?.v ?? null;
    },
    set(site, kind, id, v) {
      if (v == null) return;
      load()[k(site, kind, id)] = { v, t: Date.now() };
      save();
    },
    forget(site) {
      const d = load();
      for (const x of Object.keys(d)) if (x.startsWith(`${site}|`)) delete d[x];
      save();
    },
  };
}
