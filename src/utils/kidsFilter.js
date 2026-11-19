// Kids profiles: what a child may see. Rated titles are capped at PG / TV-PG
// through the age-rating helpers (KIDS_MAX_AGE); list results, which carry no
// certification, drop adult-flagged titles and the genres below.

/** Highest minimum age a Kids profile may watch (US PG / TV-PG map to 7). */
export const KIDS_MAX_AGE = 7;

/** TMDB genre ids hidden from Kids profiles: Horror, Crime, War, War & Politics. */
const KIDS_EXCLUDED_GENRES = new Set([27, 80, 10752, 10768]);

const genreIdsOf = (item) =>
  Array.isArray(item?.genre_ids)
    ? item.genre_ids
    : Array.isArray(item?.genres)
      ? item.genres.map((g) => g?.id)
      : [];

/**
 * Whether a TMDB title is suitable for a Kids profile.
 * @param {object} item a TMDB list or detail object
 * @returns {boolean}
 */
export function isKidSafe(item) {
  if (item?.adult === true) return false;
  return !genreIdsOf(item).some((id) => KIDS_EXCLUDED_GENRES.has(id));
}

/**
 * Drop unsuitable titles from a TMDB list response (`{ results: [...] }`).
 * Other response shapes are returned unchanged.
 * @param {object} data TMDB response
 * @returns {object}
 */
export function filterKidSafeResults(data) {
  if (!Array.isArray(data?.results)) return data;
  const results = data.results.filter(isKidSafe);
  return results.length === data.results.length ? data : { ...data, results };
}
