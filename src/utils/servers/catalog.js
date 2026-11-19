// Every server a title can play on, grouped by audio for anime.
// Platform-neutral: takes source definitions, returns plain entries.
//
// Anime audio: a server with an anime route (`animeUrl`: AniList id + "sub" |
// "dub") is listed once per mode. A server that only has a TMDB route carries
// the subbed release, so it is listed under Sub only.

export const AUDIO_MODES = ["sub", "dub"];
const MODE_LABEL = { sub: "Sub", dub: "Dub" };

export const normalizeMode = (mode) => (mode === "dub" ? "dub" : "sub");

/** Menu id of a server: anime-route entries carry their mode ("vidnest:dub"). */
export const serverKey = (sourceId, mode = null) => (mode ? `${sourceId}:${mode}` : sourceId);

/** Inverse of serverKey: `{ sourceId, mode }`, mode null for plain ids. */
export function parseServerKey(key) {
  const m = /^(.*):(sub|dub)$/.exec(key);
  return m ? { sourceId: m[1], mode: m[2] } : { sourceId: key, mode: null };
}

const entry = (src, group, routeMode) => ({
  key: serverKey(src.id, routeMode),
  sourceId: src.id,
  label: src.label,
  group,
});

/**
 * Flat server list. Non-anime: one entry per source, group null.
 * Anime: every source under "sub", then every anime-route source under "dub".
 */
export function serverCatalog(sources, isAnime) {
  if (!isAnime) return sources.map((s) => entry(s, null, null));
  const sub = sources.map((s) => entry(s, "sub", s.animeUrl ? "sub" : null));
  const dub = sources.filter((s) => s.animeUrl).map((s) => entry(s, "dub", "dub"));
  return [...sub, ...dub];
}

/** Catalog entries split into ordered groups: `[{ mode, label, servers }]`. */
export function groupServers(entries) {
  if (!entries.some((e) => e.group)) return [{ mode: null, label: "Servers", servers: entries }];
  return AUDIO_MODES.map((mode) => ({
    mode,
    label: MODE_LABEL[mode],
    servers: entries.filter((e) => e.group === mode),
  })).filter((g) => g.servers.length);
}

/** Display label with the audio group: "Vidnest · Dub". */
export const groupedLabel = (e) => (e.group ? `${e.label} · ${MODE_LABEL[e.group]}` : e.label);
