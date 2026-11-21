// Custom servers: find which title a sample link points at (TMDB for movies
// and series, AniList / MyAnimeList for anime), then build its template.
// The caller passes the lookups, so Node tests run this with fakes:
//   tmdb(path)          -> TMDB v3 JSON (path like "/movie/27205")
//   anilist(query, vars) -> AniList GraphQL `data`
import { analyzeUrl, detectTemplate, titleWords } from "./template";
import { idHints, pageFacts, similarity, convertIds } from "./idmap";
import { numberingFor, seasonCounts } from "./episodes";

/** Each lookup gives up after this long; the whole match never waits on one slow call. */
export const LOOKUP_TIMEOUT_MS = 5000;
/** At most this many numbers from a link are looked up as ids. */
const MAX_ID_CANDIDATES = 4;
/** Below this score a hit is too weak to call a match. */
const MIN_SCORE = 40;

const ANILIST_BY_IDS = `
query ($ids: [Int], $mal: [Int]) {
  byId: Page(perPage: 8) { media(id_in: $ids, type: ANIME) { id idMal format episodes seasonYear title { romaji english native } } }
  byMal: Page(perPage: 8) { media(idMal_in: $mal, type: ANIME) { id idMal format episodes seasonYear title { romaji english native } } }
}`;
const ANILIST_SEARCH = `
query ($q: String) {
  Page(perPage: 6) { media(search: $q, type: ANIME, sort: SEARCH_MATCH) { id idMal format episodes seasonYear title { romaji english native } } }
}`;

/** Reject `promise` after `ms`. */
export function withTimeout(promise, ms, what = "lookup") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 0..1: how much of `guess` (a title read from the link) is in `title`. */
export function titleOverlap(guess, title) {
  const g = titleWords(guess);
  const t = new Set(titleWords(title));
  if (!g.length || !t.size) return 0;
  return g.filter((w) => t.has(w)).length / g.length;
}

const yearOf = (d) => Number(String(d || "").slice(0, 4)) || null;

/** A TMDB movie / series as a match. */
const fromTmdb = (kind, d, imdb = null) => ({
  kind,
  source: "tmdb",
  ids: { tmdb: d.id, ...(imdb || d.imdb_id ? { imdb: imdb || d.imdb_id } : {}) },
  title: kind === "movie" ? d.title || d.original_title : d.name || d.original_name,
  altTitles: [d.original_title, d.original_name].filter(Boolean),
  year: yearOf(kind === "movie" ? d.release_date : d.first_air_date),
  poster: d.poster_path || null,
});

/** An AniList entry as a match. */
const fromAnilist = (m) => ({
  kind: "anime",
  source: "anilist",
  ids: { anilist: m.id, ...(m.idMal ? { mal: m.idMal } : {}) },
  title: m.title?.english || m.title?.romaji || m.title?.native || "",
  altTitles: [m.title?.romaji, m.title?.native, m.title?.english].filter(Boolean),
  year: m.seasonYear || null,
  format: m.format || null,
});

/** A page title without the site's name and "Watch … online" words. */
export function cleanPageTitle(t) {
  return String(t || "")
    .split(/\s[|·•–—-]\s/)[0]
    .replace(/^\s*(watch|stream)\s+/i, "")
    .replace(/\s+(online|free|full movie|hd|for free|streaming|english sub(bed)?|dubbed)(\s.*)?$/i, "")
    .replace(/\s*\((19|20)\d\d\)\s*/, " ")
    .replace(/\s+(19|20)\d\d\s*$/, "")
    .trim();
}

/** How close a hit's names are to the link's words: shared words, or a loose match for typos. */
function closeness(guess, hit) {
  let best = 0;
  for (const n of [hit.title, ...(hit.altTitles || [])]) {
    const f = similarity(guess, n);
    best = Math.max(best, titleOverlap(guess, n), f >= 0.8 ? f : 0);
  }
  return best;
}

/** Score of a hit against what the link itself says. */
function score(hit, a, idInLink, labelled = false) {
  let s = idInLink ? 50 : 0;
  if (labelled) s += 20; // the link names the id's kind ("/anilist/21")
  const overlap = a.titleGuess ? closeness(a.titleGuess, hit) : 0;
  // An id from the link whose title has nothing to do with the link's words
  // (TMDB tv/1 "Pride" for ".../family-guy-y6bs3k/1/1") is not a match.
  if (a.titleGuess) s += overlap >= 0.99 ? 40 : overlap >= 0.5 ? 20 : idInLink && titleWords(a.titleGuess).length >= 2 ? -70 : -25;
  if (a.yearGuess && hit.year) s += a.yearGuess === hit.year ? 15 : Math.abs(a.yearGuess - hit.year) > 1 ? -10 : 0;
  if (a.kind) s += a.kind === hit.kind || (a.kind === "anime" && hit.animeVia) ? 20 : -20;
  if (!idInLink && overlap < 0.5) s -= 100; // a search hit must at least share the title
  return s;
}

const settle = (promises) => Promise.allSettled(promises).then((r) => r.filter((x) => x.status === "fulfilled").map((x) => x.value));

const ANILIST_ONE = `
query ($id: Int, $mal: Int) {
  Media(id: $id, idMal: $mal, type: ANIME) { id idMal format episodes seasonYear title { romaji english native } }
}`;

const JUNK_TITLE = /quick check|just a moment|attention required|verify|access denied|not found|error|captcha|security check|loading|^home$|^watch$/i;

/** A path segment that is the site's own id for the title: a slug with a site id, or a number / token. */
function siteToken(sample, a) {
  if (a.slugSegment && a.siteId) return a.slugSegment;
  let path = "";
  try {
    path = new URL(sample).pathname;
  } catch {
    return null;
  }
  const segs = path.split("/").filter(Boolean);
  const kindish = /^(movie|movies|film|films|tv|series|show|shows|anime|watch|play|embed|player|details|info|title|v|e|s|ep)$/i;
  // Season / episode numbers at the end are not the title's id.
  let end = segs.length;
  while (end > 0 && /^\d{1,4}$/.test(segs[end - 1]) && end > 1 && !kindish.test(segs[end - 2])) end--;
  for (let i = end - 1; i >= 0; i--) {
    const x = segs[i];
    if (kindish.test(x) || x.length < 2) continue;
    if (/^\d+$/.test(x) || /\d/.test(x)) return x;
  }
  return null;
}

/**
 * Match a sample link to a title and build its template.
 * @param {string} sample
 * @param {{ tmdb?: Function, anilist?: Function, arm?: Function, page?: Function,
 *           prefer?: "movie"|"tv"|"anime"|null, timeoutMs?: number, pageTitle?: string|null }} deps
 *   arm(url) -> ARM anime-mapping JSON; page() -> the sample page's HTML (or null)
 * @returns {Promise<{ ok: boolean, error?: string, match?: object, detected?: object,
 *                     alternatives?: object[], guesses?: object[], via?: string, numbering?: string }>}
 */
export async function matchSample(sample, { tmdb, anilist, arm, page = null, prefer = null, timeoutMs = LOOKUP_TIMEOUT_MS, pageTitle = null } = {}) {
  const a = analyzeUrl(sample);
  if (!a.ok) return { ok: false, error: a.error };
  const hints = idHints(sample);
  const kindHint = a.kind || prefer;
  const t = (p, what) => withTimeout(Promise.resolve().then(p), timeoutMs, what);
  const labelledNums = new Set(hints.labelled.map((l) => l.value));
  const ids = (a.idNumbers || a.numbers).filter((n) => n > 0 && !(n === a.yearGuess) && !labelledNums.has(n)).slice(0, MAX_ID_CANDIDATES);
  const errors = [];
  const note = (e) => {
    errors.push(e?.message || String(e));
    return null;
  };
  const notFound = (e) => (e?.status === 404 || /404|not found/i.test(e?.message || "") ? [] : note(e));
  const tmdbKinds = kindHint === "movie" || kindHint === "tv" ? [kindHint] : ["movie", "tv"];
  const asAnime = (hit) => (a.kind === "anime" ? { ...hit, kind: "anime", animeVia: hit.kind } : hit);
  const byTmdbId = (n, kinds, extra = {}) =>
    kinds.map((k) =>
      t(() => tmdb(`/${k}/${n}`), "TMDB")
        .then((d) => (d?.id === n ? [{ hit: fromTmdb(k, d), idInLink: true, ...extra }] : []))
        .catch(notFound),
    );
  const findTmdb = (id, source, extra = {}) =>
    t(() => tmdb(`/find/${id}?external_source=${source}`), "TMDB")
      .then((r) => [
        ...(r?.movie_results || []).map((d) => fromTmdb("movie", d, source === "imdb_id" ? id : null)),
        ...(r?.tv_results || []).map((d) => fromTmdb("tv", d, source === "imdb_id" ? id : null)),
      ].map((hit) => ({ hit: source === "tvdb_id" ? { ...hit, ids: { ...hit.ids, tvdb: id } } : hit, idInLink: true, ...extra })))
      .catch(note);
  const anilistOne = (vars, extra = {}) =>
    t(() => anilist(ANILIST_ONE, vars), "AniList")
      .then((d) => (d?.Media ? [{ hit: { ...fromAnilist(d.Media), ...(vars.mal && !vars.id ? { viaMal: true } : {}) }, idInLink: true, ...extra }] : []))
      .catch(notFound);
  const jobs = [];

  // Ids the link labels ("/anilist/21", "?mal=21", "/tvdb/81189", "kitsu=12"): only that kind.
  for (const { kind, value } of hints.labelled) {
    const L = { labelled: true };
    if (kind === "tmdb" && tmdb) jobs.push(...byTmdbId(value, tmdbKinds, L).map((p) => p.then((x) => (x || []).map((f) => ({ ...f, hit: asAnime(f.hit) })))));
    if (kind === "tvdb" && tmdb) jobs.push(findTmdb(value, "tvdb_id", L).then((x) => (x || []).map((f) => ({ ...f, hit: { ...asAnime(f.hit), viaTvdb: true } }))));
    if (kind === "anilist" && anilist) jobs.push(anilistOne({ id: value }, L));
    if (kind === "mal" && anilist) jobs.push(anilistOne({ mal: value }, L));
    if (kind === "kitsu" && (arm || anilist)) {
      jobs.push(
        t(() => convertIds({ kitsu: value }, ["anilist", "mal"], { arm }), "ARM")
          .then((x) => (x.anilist && anilist ? anilistOne({ id: x.anilist }, L) : []))
          .then((list) => (list || []).map((f) => ({ ...f, hit: { ...f.hit, ids: { ...f.hit.ids, kitsu: value }, viaKitsu: true } })))
          .catch(note),
      );
    }
  }
  // IMDb id in the link: TMDB's /find answers exactly.
  if (tmdb) for (const imdb of a.imdb) jobs.push(findTmdb(imdb, "imdb_id"));
  // Unlabelled numbers as TMDB ids (the kinds the link hints at).
  if (tmdb && kindHint !== "anime") for (const n of ids) jobs.push(...byTmdbId(n, tmdbKinds));
  // Unlabelled numbers as AniList / MAL ids (anime links, or links with no kind word).
  if (anilist && ids.length && (kindHint === "anime" || !kindHint)) {
    jobs.push(
      t(() => anilist(ANILIST_BY_IDS, { ids, mal: ids }), "AniList")
        .then((d) => [
          ...(d?.byId?.media || []).map((m) => ({ hit: fromAnilist(m), idInLink: true })),
          ...(d?.byMal?.media || []).map((m) => ({ hit: { ...fromAnilist(m), viaMal: true }, idInLink: true })),
        ])
        .catch(note),
    );
  }
  // By the title in the link (site ids and the year already stripped).
  const searchTitle = (query, year, kind) => {
    const out = [];
    if (!query) return out;
    if (tmdb && kind !== "anime") {
      const q = encodeURIComponent(query);
      const run = (path) =>
        t(() => tmdb(path), "TMDB")
          .then((r) =>
            (r?.results || [])
              .filter((d) => (d.media_type || kind) === "movie" || (d.media_type || kind) === "tv")
              .slice(0, 5)
              .map((d) => ({ hit: fromTmdb(d.media_type || kind, d), idInLink: false })),
          )
          .catch(note);
      out.push(run(`/search/multi?query=${q}`));
      // The kind's own search takes the year as a filter (multi ignores it).
      if (kind === "movie" && year) out.push(run(`/search/movie?query=${q}&year=${year}`));
      if (kind === "tv" && year) out.push(run(`/search/tv?query=${q}&first_air_date_year=${year}`));
    }
    // TV-worded links too ("/watch/<slug>-episode-7"): an anime may be linked like a show.
    if (anilist && (kind === "anime" || kind === "tv" || !kind)) {
      out.push(
        t(() => anilist(ANILIST_SEARCH, { q: query }), "AniList")
          .then((d) => (d?.Page?.media || []).slice(0, 4).map((m) => ({ hit: fromAnilist(m), idInLink: false })))
          .catch(note),
      );
    }
    return out;
  };

  const rank = (list, against = a) =>
    list
      .map((f) => ({ ...f, s: score(f.hit, against, f.idInLink, f.labelled) + (prefer && f.hit.kind === prefer ? 5 : 0) }))
      .sort((x, y) => y.s - x.s);
  let found = (await settle([...jobs, ...searchTitle(a.titleGuess, a.yearGuess, kindHint)])).flat().filter(Boolean);
  let ranked = rank(found);
  // Nothing close: the title with a word less at either end (extra words in the slug).
  const words = titleWords(a.titleGuess);
  if (!(ranked[0]?.s >= MIN_SCORE) && words.length >= 3) {
    const more = (await settle([...searchTitle(words.slice(0, -1).join(" "), a.yearGuess, kindHint), ...searchTitle(words.slice(1).join(" "), a.yearGuess, kindHint)])).flat().filter(Boolean);
    found = [...found, ...more];
    ranked = rank(found);
  }

  // The page's own facts, read once and only when needed.
  let facts;
  const readPage = async () => {
    if (facts !== undefined) return facts;
    facts = null;
    if (page) {
      const html = await t(() => page(), "page").catch(() => null);
      if (html) facts = pageFacts(html);
    }
    if (!facts?.title && pageTitle) facts = { ...(facts || { ids: {} }), title: pageTitle, year: facts?.year || Number(/\b(19|20)\d\d\b/.exec(pageTitle)?.[0]) || null };
    return facts;
  };
  /** Titles the page names: its own ids first, then its title searched. */
  const pageHits = async () => {
    const f = await readPage();
    if (!f) return [];
    const kind = f.kind || (a.kind === "movie" || a.kind === "tv" ? a.kind : null) || prefer;
    const own = [];
    if (tmdb && f.ids?.tmdb) own.push(...byTmdbId(f.ids.tmdb, f.ids.tmdbKind ? [f.ids.tmdbKind] : kind === "movie" || kind === "tv" ? [kind] : ["movie", "tv"]));
    if (tmdb && f.ids?.imdb) own.push(findTmdb(f.ids.imdb, "imdb_id"));
    if (anilist && f.ids?.anilist) own.push(anilistOne({ id: f.ids.anilist }));
    if (anilist && !f.ids?.anilist && f.ids?.mal) own.push(anilistOne({ mal: f.ids.mal }));
    const clean = cleanPageTitle(f.title);
    const usable = clean && !JUNK_TITLE.test(clean);
    const hits = [];
    for (const x of (await settle(own)).flat().filter(Boolean)) hits.push({ ...x, idInLink: false, pageId: true, s: 100 });
    if (usable) {
      const year = f.year || a.yearGuess || null;
      const pa = { ...a, titleGuess: clean, yearGuess: year, kind: kind === "movie" || kind === "tv" || kind === "anime" ? kind : a.kind };
      const searched = (await settle(searchTitle(clean, year, pa.kind))).flat().filter(Boolean);
      hits.push(...rank(searched, pa).filter((r) => r.s >= MIN_SCORE));
    }
    return hits.sort((x, y) => y.s - x.s);
  };

  const done = (r, hit, detected, extra = {}) => {
    // An episode link that reads as anime (Sub / Dub in it, or episodes with no
    // season) by title, and the same title is on AniList: the anime link.
    const tpl = detected?.template || "";
    if (detected?.ok && detected.kind === "tv" && /\{(slug|title)\}/.test(tpl) && /\{episode\}/.test(tpl) && (/\{lang\}/.test(tpl) || !/\{season\}/.test(tpl))) {
      const ani = ranked.find((o) => o.hit.kind === "anime" && o.hit.ids?.anilist && o.hit.source === "anilist" && closeness(hit.title, o.hit) >= 0.8);
      if (ani) {
        const h = { ...ani.hit, title: hit.title, year: hit.year ?? ani.hit.year, ids: { ...ani.hit.ids, ...(hit.ids?.tmdb ? { tmdb: hit.ids.tmdb } : {}) } };
        const det = detectTemplate(sample, { ...h, kind: "anime" });
        if (det.ok && det.kind === "anime") {
          return withNumbering({ ok: true, match: h, detected: det, alternatives: [hit], animeFrom: "tv", ...extra }, { tmdb, t, a });
        }
      }
    }
    return withNumbering(
      {
        ok: true,
        match: hit,
        detected,
        alternatives: ranked.filter((o) => o !== r && o.s >= MIN_SCORE && o.hit !== hit).slice(0, 3).map((o) => o.hit),
        ...extra,
      },
      { tmdb, t, a },
    );
  };
  // The match keeps every id; its template only the one the link holds.
  const forTemplate = (h) => (h.viaMal ? { ...h, ids: { mal: h.ids.mal } } : h);
  const detectFor = (h) =>
    detectTemplate(sample, h.viaKitsu ? { ...h, ids: { kitsu: h.ids.kitsu } } : h.viaTvdb ? { ...h, ids: { tvdb: h.ids.tvdb } } : h);

  // The best hit whose template actually places the title in the link.
  for (const r of ranked) {
    if (r.s < MIN_SCORE) break;
    const hit = forTemplate(r.hit);
    // A bare number with no title words is checked against the page: a site's
    // own number that happens to be some TMDB id is not that title.
    if (r.idInLink && !r.labelled && !titleWords(a.titleGuess).length && !a.imdb.length && page) {
      const f = await readPage();
      const confirmed = f && ((f.ids?.tmdb && f.ids.tmdb === hit.ids.tmdb) || (f.ids?.imdb && f.ids.imdb === hit.ids.imdb));
      const clean = cleanPageTitle(f?.title);
      if (!confirmed && clean && !JUNK_TITLE.test(clean) && Math.max(titleOverlap(clean, hit.title), similarity(clean, hit.title)) < 0.5) {
        const other = (await pageHits())[0];
        if (other && other.s >= MIN_SCORE) {
          const token = siteToken(sample, a);
          const m = { ...forTemplate(other.hit), siteValue: token };
          const det = token ? detectTemplate(sample, m) : { ok: false };
          if (det.ok) return done(other, m, det, { via: "page title", siteId: token });
        }
      }
    }
    const detected = detectFor(hit);
    if (detected.ok) return done(r, hit, detected);
    // A slug with a site id whose words are spelled differently from the
    // title ("avengers-endgam-2019-5iu40l", same year): the whole segment is {site}.
    if (a.siteId && a.slugSegment && !r.idInLink && a.yearGuess && a.yearGuess === hit.year && closeness(a.titleGuess, hit) >= 0.8) {
      const m = { ...hit, siteValue: a.slugSegment };
      const det = detectTemplate(sample, m);
      if (det.ok) return done(r, m, det, { siteId: a.slugSegment });
    }
  }

  // The page's own title / ids, when the link's words weren't enough.
  const fromPage = page || pageTitle ? await pageHits() : [];
  for (const r of fromPage) {
    const hit = forTemplate(r.hit);
    let detected = detectFor(hit);
    let extra = { via: "page title" };
    if (!detected.ok) {
      // The link holds the site's own id for the title, not TMDB's: {site}.
      const token = siteToken(sample, a);
      if (token) {
        const m = { ...hit, siteValue: token };
        detected = detectTemplate(sample, m);
        if (detected.ok) return done(r, m, detected, { ...extra, siteId: token });
      }
      continue;
    }
    return done(r, hit, detected, extra);
  }

  if (!found.length && !fromPage.length && errors.length) return { ok: false, error: `Couldn't reach the title database (${errors[0]}).` };
  // Never a dead end: the closest titles, to pick from.
  const seen = new Set();
  const guesses = [...fromPage, ...ranked.filter((r) => r.s > -50)]
    .map((r) => r.hit)
    .filter((h) => {
      const k = `${h.kind}:${h.ids.tmdb ?? h.ids.anilist ?? h.ids.mal}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 5);
  return {
    ok: false,
    guesses,
    error: guesses.length
      ? `Not sure which title this link is. Closest: ${guesses.map((g) => `${g.title}${g.year ? ` (${g.year})` : ""}`).join(", ")}.`
      : a.titleGuess
        ? `Couldn't find "${a.titleGuess}"${a.yearGuess ? ` (${a.yearGuess})` : ""} on TMDB yet; Super Player keeps looking through the site's own links.`
        : "Couldn't tell which title this link is; Super Player keeps looking through the site's own links.",
  };
}

/**
 * A TV link with an episode number but no season, for a show with more than
 * one season: the site counts episodes from 1 across seasons ({absolute}).
 */
async function withNumbering(res, { tmdb, t, a }) {
  const d = res.detected;
  if (!tmdb || !d?.ok || d.kind !== "tv" || !res.match?.ids?.tmdb) return res;
  if (!d.placeholders.includes("episode") || d.placeholders.includes("season")) return res;
  const tv = await t(() => tmdb(`/tv/${res.match.ids.tmdb}`), "TMDB").catch(() => null);
  const counts = seasonCounts(tv);
  const episode = Math.max(0, ...(a.trailing || []), ...(a.numbers || []).filter((n) => n <= 9999 && n !== a.yearGuess && n !== res.match.ids.tmdb));
  const numbering = numberingFor({ hasSeason: false, episode, counts });
  if (numbering !== "absolute") return { ...res, numbering };
  const template = d.template.replace("{episode}", "{absolute}");
  return {
    ...res,
    numbering,
    detected: {
      ...d,
      template,
      placeholders: d.placeholders.map((p) => (p === "episode" ? "absolute" : p)),
      warnings: d.warnings.filter((w) => !/season/i.test(w)).concat("Episodes are counted from 1 across all seasons (absolute numbering)."),
    },
  };
}
