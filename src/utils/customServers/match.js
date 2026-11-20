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

/** Score of a hit against what the link itself says. */
function score(hit, a, idInLink) {
  let s = idInLink ? 50 : 0;
  const names = [hit.title, ...(hit.altTitles || [])];
  const overlap = a.titleGuess ? Math.max(...names.map((n) => titleOverlap(a.titleGuess, n))) : 0;
  if (a.titleGuess) s += overlap >= 0.99 ? 40 : overlap >= 0.5 ? 20 : -25;
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
export async function matchSample(sample, { tmdb, anilist, prefer = null, timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
  const a = analyzeUrl(sample);
  if (!a.ok) return { ok: false, error: a.error };
  const kindHint = a.kind || prefer;
  const t = (p, what) => withTimeout(Promise.resolve().then(p), timeoutMs, what);
  const ids = a.numbers.filter((n) => n > 0 && !(n === a.yearGuess)).slice(0, MAX_ID_CANDIDATES);
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
      const year = a.yearGuess ? `&year=${a.yearGuess}` : "";
      searches.push(
        t(() => tmdb(`/search/multi?query=${encodeURIComponent(a.titleGuess)}${year}`), "TMDB")
          .then((r) =>
            (r?.results || [])
              .filter((d) => d.media_type === "movie" || d.media_type === "tv")
              .slice(0, 5)
              .map((d) => ({ hit: fromTmdb(d.media_type, d), idInLink: false })),
          )
          .catch(note),
      );
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
  if (!found.length && errors.length) return { ok: false, error: `Couldn't reach the title database (${errors[0]}).` };
  return {
    ok: false,
    error: a.titleGuess
      ? `No title matched "${a.titleGuess}". Paste the link of a page that plays a movie or an episode.`
      : "No title matched this link. Paste the link of a page that plays a movie or an episode.",
  };
}
