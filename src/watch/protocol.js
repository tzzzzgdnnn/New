// Watch Together: the one protocol every platform speaks (iPhone app, Android
// app, web app). Pure functions only: shared by the room server (Cloudflare
// Durable Object), the room client and the tests.

/** Room codes: 6 characters, no look-alikes (0/O, 1/I/L). */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LEN = 6;

/** Lead time for a synchronized start: every phone gets the start instant this far ahead. */
export const START_LEAD_MS = 800;
/** A dropped connection holds the room this long before the member counts as gone. */
export const RECONNECT_GRACE_MS = 30_000;
/** An empty room is deleted after this long. */
export const EMPTY_ROOM_TTL_MS = 10 * 60_000;
export const MAX_MEMBERS = 8;
export const PLATFORMS = ["ios", "android", "web"];

export function makeCode(rand = Math.random) {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return s;
}

/** What a person typed -> a code ("abc-23x" -> "ABC23X"). */
export function normalizeCode(input) {
  return String(input || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LEN);
}

export const isValidCode = (c) =>
  typeof c === "string" && c.length === CODE_LEN && [...c].every((ch) => CODE_ALPHABET.includes(ch));

/** Code shown big on the starter screen: "ABC 23X". */
export const prettyCode = (c) => (c && c.length === CODE_LEN ? `${c.slice(0, 3)} ${c.slice(3)}` : c || "");

/** Identity of one playable thing: movie, or episode, plus anime audio (sub/dub). */
export function mediaKey(m) {
  if (!m || !m.tmdbId) return "";
  const type = m.type === "tv" ? "tv" : "movie";
  const ep = type === "tv" ? `:${Number(m.season) || 0}:${Number(m.episode) || 0}` : "";
  const dub = m.isAnime ? `:${m.dubMode === "dub" ? "dub" : "sub"}` : "";
  return `${type}:${m.tmdbId}${ep}${dub}`;
}

/** Only the fields a room needs to open the same title everywhere. */
export function cleanMedia(m) {
  if (!m || !m.tmdbId) return null;
  const type = m.type === "tv" ? "tv" : "movie";
  const out = {
    type,
    tmdbId: m.tmdbId,
    title: String(m.title || "").slice(0, 200),
    season: type === "tv" ? Number(m.season) || 1 : null,
    episode: type === "tv" ? Number(m.episode) || 1 : null,
    isAnime: !!m.isAnime,
    dubMode: m.dubMode === "dub" ? "dub" : "sub",
    anilistId: m.anilistId || null,
    year: m.year || null,
    poster: typeof m.poster === "string" ? m.poster.slice(0, 300) : null,
    server: typeof m.server === "string" ? m.server.slice(0, 80) : null,
    audioLang: typeof m.audioLang === "string" ? m.audioLang.slice(0, 16) : null,
    subLang: typeof m.subLang === "string" ? m.subLang.slice(0, 16) : null,
    startAt: Math.max(0, Number(m.startAt) || 0),
  };
  out.key = mediaKey(out);
  return out;
}

/**
 * Where playback should be at server time `serverNow` (ms). Paused, or a
 * start that is still scheduled, holds at `pos`. Seconds of item time: one
 * timeline that carries both the video and the audio track.
 */
export function expectedPosition(pb, serverNow) {
  if (!pb) return 0;
  if (pb.paused || serverNow < pb.at) return pb.pos;
  return pb.pos + ((serverNow - pb.at) / 1000) * (pb.rate || 1);
}
