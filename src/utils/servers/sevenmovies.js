// 7Movies (7movies.ac) stream lookup. The site plays everything through
// Vidrift's embed (embed.vidrift.net): the embed page, opened with 7Movies as
// its referrer, bakes a playback token and the title's sources into
// `var embedMeta = {...}`:
//   - orionStreams: Orion's HLS masters ("/api/orion/<id>/master.m3u8", one
//     per audio language, HEVC fMP4). Empty when not baked: then
//     /api/source/<path>?token=..&provider=orion&parent=7movies.ac gives them.
//     The playlists answer only with Referer https://embed.vidrift.net/.
//   - evionUrl: Evion, the site's own media (series; a signed
//     media.bigbang.observer HLS, open to any client). For movies the same lane
//     is called Vexon (vexonUrl), so Evion uses that one for movies.
// Pure logic, no DOM; the caller passes a GET (native HTTP on iOS).

export const VIDRIFT = "https://embed.vidrift.net";
export const SEVENMOVIES_PARENT = "7movies.ac";
export const SEVENMOVIES_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
/** Headers the Orion playlists need (the native player adds them for this host). */
export const VIDRIFT_HEADERS = { Referer: VIDRIFT + "/", "User-Agent": SEVENMOVIES_UA };

/** "movie/<id>" or "tv/<id>/<s>/<e>". */
export const vidriftPath = (q) =>
  q.type === "tv" ? `tv/${q.tmdbId}/${q.season ?? 1}/${q.episode ?? 1}` : `movie/${q.tmdbId}`;

/** The embedMeta object baked into an embed page, or null. */
export function parseEmbedMeta(html) {
  const s = String(html || "");
  const at = s.indexOf("var embedMeta = ");
  if (at < 0) return null;
  const start = at + "var embedMeta = ".length;
  // The object ends at the first "};" that closes it (JSON never contains "};" outside strings
  // in practice, but walk braces to be safe).
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

const abs = (u) => (/^https:\/\//.test(u || "") ? u : u && u.startsWith("/") ? VIDRIFT + u : null);

/** Orion's first (original-language) stream from a stream list. */
export function pickOrion(streams) {
  const list = (Array.isArray(streams) ? streams : []).map((s) => ({ ...s, url: abs(s?.url || s?.proxyUrl) })).filter((s) => s.url);
  if (!list.length) return null;
  return list.find((s) => /original/i.test(s.name || "")) || list[0];
}

/**
 * Resolve both servers for one title/episode.
 * @param {(url: string, headers: object) => Promise<string>} http GET -> body text (throws on HTTP errors)
 * @param {{ type: "movie"|"tv", tmdbId: number|string, season?: number, episode?: number }} q
 * @returns {Promise<{ orion: string|null, evion: string|null, subtitles: string|null, ms: number }>}
 */
export async function resolveSevenMovies(http, q, { now = Date.now } = {}) {
  if (!q?.tmdbId) throw new Error("7movies: needs a TMDB id");
  const t0 = now();
  const path = vidriftPath(q);
  const html = await http(`${VIDRIFT}/embed/${path}`, {
    Referer: `https://${SEVENMOVIES_PARENT}/`,
    "User-Agent": SEVENMOVIES_UA,
  });
  const meta = parseEmbedMeta(html);
  if (!meta) throw new Error("7movies: no embed data");
  let orion = pickOrion(meta.orionStreams);
  if (!orion && meta.playbackToken) {
    try {
      const body = await http(
        `${VIDRIFT}/api/source/${path}?token=${encodeURIComponent(meta.playbackToken)}&provider=orion&parent=${SEVENMOVIES_PARENT}&nofallback=1`,
        { ...VIDRIFT_HEADERS, Referer: `${VIDRIFT}/embed/${path}` },
      );
      orion = pickOrion(JSON.parse(body)?.streams);
    } catch {
      orion = null;
    }
  }
  const evion = abs(meta.evionUrl) || (q.type === "tv" ? null : abs(meta.vexonUrl));
  if (!orion && !evion) throw new Error("7movies: nothing for this title");
  return { orion: orion?.url || null, evion, subtitles: orion?.subtitleListUrl ? abs(orion.subtitleListUrl) : null, ms: now() - t0 };
}
