// React side of the Kids filter: lists that do not come from a TMDB list
// response (history, My List, downloads, curated rows, cached lists) are
// filtered here with the rules in kidsFilter.js. Outside a Kids profile the
// items are returned untouched.
import { useEffect, useMemo, useState } from "react";
import { isKidsProfileActive } from "../../../utils/profileScope";
import { tmdbFetch, lastTmdbKey } from "../../../utils/api";
import { cachedKidsVerdict, resolveKidsVerdict } from "./kidsFilter";

/** fetchJson for the kids rules, with the given (or last used) TMDB token. */
export const kidsFetcher = (apiKey) => (path) => tmdbFetch(path, apiKey || lastTmdbKey());

/**
 * Items a Kids profile may see: only titles verified as allowed; the rest
 * are looked up and appear once they pass. Unrated titles never appear.
 * @param {object[]} items TMDB-like items ({id, media_type}) or downloads ({tmdbId, mediaType})
 * @param {string} [apiKey]
 * @param {"movie"|"tv"} [hint] media type when items carry none
 */
export function useKidsFilter(items, apiKey, hint) {
  const kids = isKidsProfileActive();
  const [tick, setTick] = useState(0);
  const list = Array.isArray(items) ? items : [];
  useEffect(() => {
    if (!kids || !list.length) return;
    const unknown = list.filter((it) => cachedKidsVerdict(it, hint) === undefined);
    if (!unknown.length) return;
    let alive = true;
    const fetchJson = kidsFetcher(apiKey);
    Promise.all(unknown.map((it) => resolveKidsVerdict(it, fetchJson, hint).catch(() => false))).then(() => {
      if (alive) setTick((t) => t + 1);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kids, items, apiKey, hint]);
  return useMemo(
    () => (kids ? list.filter((it) => cachedKidsVerdict(it, hint) === true) : items),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kids, items, hint, tick],
  );
}
