// Custom servers: find which title a sample link points at (TMDB for movies
// and series, AniList / MyAnimeList for anime), then build its template.
// The caller passes the lookups, so Node tests run this with fakes:
//   tmdb(path)          -> TMDB v3 JSON (path like "/movie/27205")
//   anilist(query, vars) -> AniList GraphQL `data`
import { analyzeUrl, detectTemplate, titleWords } from "./template";

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

/** Score of a hit against what the link itself says. */
function score(hit, a, idInLink) {
  let s = idInLink ? 50 : 0;
  const names = [hit.title, ...(hit.altTitles || [])];
  const overlap = a.titleGuess ? Math.max(...names.map((n) => titleOverlap(a.titleGuess, n))) : 0;
  // An id from the link whose title has nothing to do with the link's words
  // (TMDB tv/1 "Pride" for ".../family-guy-y6bs3k/1/1") is not a match.
  if (a.titleGuess) s += overlap >= 0.99 ? 40 : overlap >= 0.5 ? 20 : idInLink && titleWords(a.titleGuess).length >= 2 ? -70 : -25;
  if (a.yearGuess && hit.year) s += a.yearGuess === hit.year ? 15 : 0;
  if (a.kind) s += a.kind === hit.kind ? 20 : -20;
  if (!idInLink && overlap < 0.5) s -= 100; // a search hit must at least share the title
  return s;
}

const settle = (promises) => Promise.allSettled(promises).then((r) => r.filter((x) => x.status === "fulfilled").map((x) => x.value));

/**
 * Match a sample link to a title and build its template.
 * @param {string} sample
 * @param {{ tmdb?: Function, anilist?: Function, prefer?: "movie"|"tv"|"anime"|null,
 *           timeoutMs?: number }} deps
 * @returns {Promise<{ ok: boolean, error?: string, match?: object, detected?: object,
 *                     alternatives?: object[] }>}
 */
export async function matchSample(sample, { tmdb, anilist, prefer = null, timeoutMs = LOOKUP_TIMEOUT_MS, pageTitle = null } = {}) {
  const a = analyzeUrl(sample);
  if (!a.ok) return { ok: false, error: a.error };
  const kindHint = a.kind || prefer;
  const t = (p, what) => withTimeout(Promise.resolve().then(p), timeoutMs, what);
  const ids = (a.idNumbers || a.numbers).filter((n) => n > 0 && !(n === a.yearGuess)).slice(0, MAX_ID_CANDIDATES);
  const errors = [];
  const note = (e) => {
    errors.push(e?.message || String(e));
    return null;
  };
  const jobs = [];

  // IMDb id in the link: TMDB's /find answers exactly.
  if (tmdb) {
    for (const imdb of a.imdb) {
      jobs.push(
        t(() => tmdb(`/find/${imdb}?external_source=imdb_id`), "TMDB")
          .then((r) => [
            ...(r?.movie_results || []).map((d) => fromTmdb("movie", d, imdb)),
            ...(r?.tv_results || []).map((d) => fromTmdb("tv", d, imdb)),
          ].map((hit) => ({ hit, idInLink: true })))
          .catch(note),
      );
    }
  }
  // Numbers in the link as TMDB ids (the kinds the link hints at).
  if (tmdb && kindHint !== "anime") {
    const kinds = kindHint === "movie" || kindHint === "tv" ? [kindHint] : ["movie", "tv"];
    for (const n of ids) {
      for (const k of kinds) {
        jobs.push(
          t(() => tmdb(`/${k}/${n}`), "TMDB")
            .then((d) => (d?.id === n ? [{ hit: fromTmdb(k, d), idInLink: true }] : []))
            .catch((e) => (e?.status === 404 || /404|not found/i.test(e?.message || "") ? [] : note(e))),
        );
      }
    }
  }
  // Numbers as AniList / MAL ids (anime links, or links with no kind word).
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
  // No usable id: search by the title in the link.
  const searches = [];
  if (a.titleGuess) {
    if (tmdb && kindHint !== "anime") {
      const q = encodeURIComponent(a.titleGuess);
      const multi = (path) =>
        t(() => tmdb(path), "TMDB")
          .then((r) =>
            (r?.results || [])
              .filter((d) => (d.media_type || kindHint) === "movie" || (d.media_type || kindHint) === "tv")
              .slice(0, 5)
              .map((d) => ({ hit: fromTmdb(d.media_type || kindHint, d), idInLink: false })),
          )
          .catch(note);
      searches.push(multi(`/search/multi?query=${q}`));
      // The kind's own search takes the year as a filter (multi ignores it).
      if (kindHint === "movie" && a.yearGuess) searches.push(multi(`/search/movie?query=${q}&year=${a.yearGuess}`));
      if (kindHint === "tv" && a.yearGuess) searches.push(multi(`/search/tv?query=${q}&first_air_date_year=${a.yearGuess}`));
    }
    if (anilist && (kindHint === "anime" || !kindHint)) {
      searches.push(
        t(() => anilist(ANILIST_SEARCH, { q: a.titleGuess }), "AniList")
          .then((d) => (d?.Page?.media || []).slice(0, 4).map((m) => ({ hit: fromAnilist(m), idInLink: false })))
          .catch(note),
      );
    }
  }

  const found = (await settle([...jobs, ...searches])).flat().filter(Boolean);
  const ranked = found
    .map((f) => ({ ...f, s: score(f.hit, a, f.idInLink) + (prefer && f.hit.kind === prefer ? 5 : 0) }))
    .sort((x, y) => y.s - x.s);
  // The best hit whose template actually places the title in the link.
  for (const r of ranked) {
    if (r.s < MIN_SCORE) break;
    const hit = r.hit.viaMal ? { ...r.hit, ids: { mal: r.hit.ids.mal } } : r.hit;
    const detected = detectTemplate(sample, hit);
    if (detected.ok) {
      return {
        ok: true,
        match: hit,
        detected,
        alternatives: ranked.filter((o) => o !== r && o.s >= MIN_SCORE).slice(0, 3).map((o) => o.hit),
      };
    }
  }
  // The page's own title (og:title / <title> / JSON-LD), when the link's words weren't enough.
  if (pageTitle && tmdb && !matchSample.inner) {
    const clean = cleanPageTitle(pageTitle);
    const junk = /quick check|just a moment|attention required|verify|access denied|not found|error|captcha|security check|loading/i.test(clean || "");
    const related = !a.titleGuess || titleWords(a.titleGuess).length < 2 || titleOverlap(a.titleGuess, clean) >= 0.3;
    if (clean && !junk && related && titleWords(clean).join(" ") !== titleWords(a.titleGuess).join(" ")) {
      const year = /\b(19|20)\d\d\b/.exec(pageTitle)?.[0] || a.yearGuess || "";
      const kindWord = a.kind === "tv" || a.kind === "movie" ? `/${a.kind}` : "";
      const synthetic = `${a.origin}${kindWord}/${clean.toLowerCase().replace(/[^a-z0-9]+/g, "-")}${year ? `-${year}` : ""}`;
      matchSample.inner = true;
      try {
        const r = await matchSample(synthetic, { tmdb, anilist, prefer: prefer || a.kind, timeoutMs });
        if (r.ok) {
          const detected = detectTemplate(sample, r.match);
          if (detected.ok) return { ...r, detected, via: "page title" };
        }
      } finally {
        matchSample.inner = false;
      }
    }
  }
  if (!found.length && errors.length) return { ok: false, error: `Couldn't reach the title database (${errors[0]}).` };
  // Never a dead end: the closest titles, to pick from.
  const guesses = ranked.filter((r) => r.s > -50).slice(0, 3).map((r) => r.hit);
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
