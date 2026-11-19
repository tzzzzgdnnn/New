// Characters for Kids profiles (character bar and pick-favorites screen).
// Art comes from the bundled avatar catalog (characters.json); each show is
// matched to its TMDB title and shown only when that title passes the Kids
// rules (kidsFilter.js). Toonami is left out (its shows are teen-rated).
import { useEffect, useState } from "react";
import CATALOG from "../profiles/characters.json";
import { tmdbFetch, lastTmdbKey } from "../../../utils/api";
import { storage } from "../../../utils/storage";
import { resolveKidsVerdict } from "./kidsFilter";
import { kidsFetcher } from "./useKidsFilter";

// The catalog points at TVmaze "original_untouched" art (~530x745, ~160 KB).
// The avatars are 68-88 pt circles, so the 210x295 "medium_portrait" copy is
// plenty and about 4x lighter to download and decode on old phones.
export const smallArt = (url) =>
  typeof url === "string" ? url.replace("/uploads/images/original_untouched/", "/uploads/images/medium_portrait/") : url;

const SKIP_CHANNELS = new Set(["Toonami"]);
const PER_SHOW = 2;

/** Every candidate character: { key, name, img, show, channel }. */
export const KIDS_CHARACTERS = (CATALOG.channels || [])
  .filter((c) => !SKIP_CHANNELS.has(c.channel))
  .flatMap((c) =>
    (c.shows || []).flatMap((s) =>
      (s.characters || []).slice(0, PER_SHOW).map((ch) => ({
        key: `${s.show}::${ch.name}`,
        name: ch.name,
        img: smallArt(ch.img),
        show: s.show,
        channel: c.channel,
      })),
    ),
  );

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
const SHOW_CACHE = "sb_kids_shows_v1";
let _shows = null;
const shows = () => {
  if (_shows) return _shows;
  try {
    _shows = JSON.parse(localStorage.getItem(SHOW_CACHE) || "{}") || {};
  } catch {
    _shows = {};
  }
  return _shows;
};
const saveShows = () => {
  try {
    localStorage.setItem(SHOW_CACHE, JSON.stringify(_shows || {}));
  } catch {}
};

/**
 * The TMDB show for a catalog show name, or null when there is none or it
 * is not kid-rated. The search result is read raw (one title kept) and that
 * title is verified with the Kids rules before it is returned.
 */
export async function resolveKidsShow(showName, apiKey) {
  const key = apiKey || lastTmdbKey();
  const c = shows();
  let item = c[showName];
  if (item === undefined) {
    try {
      const r = await tmdbFetch(`/search/tv?query=${encodeURIComponent(showName)}&include_adult=false`, key, { kidsRaw: true });
      const list = r?.results || [];
      const hit = list.find((x) => norm(x.name) === norm(showName)) || list[0] || null;
      item = hit && hit.poster_path
        ? { id: hit.id, name: hit.name, media_type: "tv", poster_path: hit.poster_path, backdrop_path: hit.backdrop_path, first_air_date: hit.first_air_date, genre_ids: hit.genre_ids || [] }
        : null;
      c[showName] = item;
      saveShows();
    } catch {
      return null; // offline: try again next time
    }
  }
  if (!item) return null;
  return (await resolveKidsVerdict(item, kidsFetcher(key))) ? item : null;
}

/**
 * Characters whose show is kid-rated, with that show attached; fills in as
 * shows are verified.
 * @returns {{ready: boolean, list: Array<{key,name,img,show,item}>}}
 */
export function useKidsCharacters(apiKey) {
  const [state, setState] = useState({ ready: false, list: [] });
  useEffect(() => {
    let alive = true;
    const names = [...new Set(KIDS_CHARACTERS.map((c) => c.show))];
    const found = new Map();
    let i = 0;
    // One re-render per batch of verified shows (at most every 400 ms), not
    // one per show: the bar re-rendered ~100 times on first load.
    let timer = null;
    const flush = () => {
      timer = null;
      if (!alive) return;
      const list = KIDS_CHARACTERS.filter((c) => found.get(c.show)).map((c) => ({ ...c, item: found.get(c.show) }));
      setState((s) => ({ ready: s.ready, list }));
    };
    const publish = () => {
      if (!timer) timer = setTimeout(flush, 400);
    };
    const worker = async () => {
      while (i < names.length && alive) {
        const name = names[i++];
        const item = await resolveKidsShow(name, apiKey).catch(() => null);
        if (item) {
          found.set(name, item);
          publish();
        }
      }
    };
    Promise.all(Array.from({ length: 4 }, worker)).then(() => {
      if (!alive) return;
      if (timer) clearTimeout(timer);
      flush();
      setState((s) => ({ ...s, ready: true }));
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [apiKey]);
  return state;
}

// ── Favorites (per profile: "kidsFavorites" is a profile-scoped key) ────────

/** Saved favorite character keys, or null when the profile never chose. */
export function loadKidsFavorites() {
  const v = storage.get("kidsFavorites");
  return Array.isArray(v) ? v : null;
}

/** Save favorite character keys for the active profile. */
export function saveKidsFavorites(keys) {
  return storage.set("kidsFavorites", Array.isArray(keys) ? [...new Set(keys)] : []);
}
