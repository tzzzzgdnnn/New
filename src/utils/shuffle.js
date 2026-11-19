// "Play Random Episode": which shows get it, and how a random episode is
// picked from TMDB metadata. Playback goes through the page's normal
// episode flow; nothing here touches players or sources.
import { tmdbFetch } from "./api";

// Episodic shows whose episodes stand alone (TMDB ids and names). The list
// wins over the genre rule (Futurama is tagged Sci-Fi, for example).
const ALLOW_IDS = new Set([456, 2190, 1434, 1433, 615, 32726, 2122, 387]);
const ALLOW_NAMES =
  /^(the simpsons|south park|family guy|american dad!?|futurama|bob's burgers|king of the hill|spongebob squarepants|seinfeld|the office|friends|it's always sunny in philadelphia|modern family|brooklyn nine-nine|parks and recreation|the fairly oddparents|rugrats|hey arnold!?|dexter's laboratory|the powerpuff girls|johnny bravo|courage the cowardly dog|ed, edd n eddy|the grim adventures of billy & mandy|regular show|the amazing world of gumball|phineas and ferb|tom and jerry|looney tunes|scooby-doo, where are you!?|the flintstones|the jetsons|rocko's modern life|catdog|the cleveland show|solar opposites|american dad)$/i;

const INCLUDE_GENRES = new Set([35, 16, 10762]); // Comedy, Animation, Kids
const EXCLUDE_GENRES = new Set([18, 9648, 10765, 80, 10759]); // Drama, Mystery, Sci-Fi & Fantasy, Crime, Action & Adventure

/** True when random episodes make sense for this show. */
export function isShuffleable(show, { isAnime = false } = {}) {
  if (!show || isAnime) return false;
  const name = (show.name || show.original_name || "").trim();
  if (ALLOW_IDS.has(Number(show.id)) || ALLOW_NAMES.test(name)) return true;
  const ids = (show.genres || []).map((g) => g.id).concat(show.genre_ids || []);
  return ids.some((g) => INCLUDE_GENRES.has(g)) && !ids.some((g) => EXCLUDE_GENRES.has(g));
}

const aired = (date) => !!date && new Date(date) <= new Date();
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * A random aired episode (no specials or season 0), weighted by episode
 * count so long seasons aren't under-picked. `avoid` skips the episode
 * that is already playing.
 * @returns {Promise<{season: number, episode: number} | null>}
 */
export async function pickRandomEpisode(show, apiKey, avoid = null) {
  const seasons = (show?.seasons || []).filter(
    (s) => s.season_number > 0 && s.episode_count > 0 && (!s.air_date || aired(s.air_date)),
  );
  if (!seasons.length) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const total = seasons.reduce((n, s) => n + s.episode_count, 0);
    let r = Math.random() * total;
    const season = seasons.find((s) => (r -= s.episode_count) < 0) || seasons[seasons.length - 1];
    const data = await tmdbFetch(`/tv/${show.id}/season/${season.season_number}`, apiKey);
    const eps = (data?.episodes || []).filter(
      (e) =>
        e.episode_number > 0 &&
        aired(e.air_date) &&
        !(avoid && avoid.season === season.season_number && avoid.episode === e.episode_number),
    );
    if (eps.length) return { season: season.season_number, episode: pick(eps).episode_number };
  }
  return null;
}
