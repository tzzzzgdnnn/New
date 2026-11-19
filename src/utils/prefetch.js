// Warm-up on card press-in: the details request (into the TMDB cache) and the
// page's code chunk start while the finger is still down, so the page opens
// with its data ready. Each title is prefetched at most once per session.
import { prefetchTmdb } from "./api";
import { getApiKey } from "./storage";

const done = new Set();
let pagesWarm = false;

/** Prefetch a media item's details and its page chunk. Never throws. */
export function prefetchDetails(item) {
  if (!item?.id) return;
  const isTV = item.media_type === "tv" || (!item.media_type && !!item.first_air_date);
  if (!pagesWarm) {
    pagesWarm = true;
    import("../pages/TVPage").catch(() => {});
    import("../pages/MoviePage").catch(() => {});
  }
  const path = `/${isTV ? "tv" : "movie"}/${item.id}`;
  if (done.has(path)) return;
  done.add(path);
  prefetchTmdb(path, getApiKey());
}
