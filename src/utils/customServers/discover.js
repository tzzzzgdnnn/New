// Custom servers, route discovery: when the link the viewer pasted is a
// details / info page that never starts a player (m-zone.cc's
// /details/movie/{tmdb}/rn-6665a44c), find the site's own player route and
// the links to try for it, best first:
//   1. player routes declared in the site's script bundles, React-Router /
//      Vue-Router style ("/embed/:type/:id/:season/:episode",
//      "/watch/:mediaType/:tmdbId") or built with string joins;
//   2. the pasted link rewritten: details / info / title  ->  embed / watch /
//      play / player, and a trailing slug the route doesn't need dropped
//      (m-zone's "rn-6665a44c" is a daily-rotating watch token);
//   3. the usual embed-site routes (/embed/movie/{tmdb}, /movie/{tmdb},
//      ?tmdb=, IMDb variants …).
// Pure logic: the caller opens each link in the hidden page and keeps the
// first that gives a stream (smart add) or the Test confirms.

/** Path words that mean "this page plays". */
export const PLAYER_WORDS = Object.freeze(["embed", "watch", "play", "player", "stream", "e", "v", "video"]);
/** Path words that mean "an info page, no player". */
export const INFO_WORDS = /^(details?|info|title|titles|overview|about|media|item|view|show-info|movie-info)$/i;

const PARAM_MAP = [
  [/^(type|mediatype|media_type|media|kind|category|contenttype|content_type)$/i, "{type}"],
  [/^(id|tmdb|tmdbid|tmdb_id|mediaid|media_id|movieid|movie_id|tvid|tv_id|showid|show_id|seriesid)$/i, "{tmdb}"],
  [/^(imdb|imdbid|imdb_id)$/i, "{imdb}"],
  [/^(season|s|seasonnumber|season_number|sn|ss)$/i, "{season}"],
  [/^(episode|e|ep|episodenumber|episode_number|epi|en)$/i, "{episode}"],
];

/** Router routes with :params in script text ("/embed/:type/:id"). */
export function paramRoutes(text) {
  const out = new Set();
  const src = String(text || "").slice(0, 4 * 1024 * 1024);
  for (const m of src.matchAll(/(["'`])(\/[A-Za-z0-9_\-/:?.]{3,120})\1/g)) {
    const p = m[2];
    if (!/\/:[A-Za-z_]/.test(p)) continue;
    if (/\/api\//i.test(p) || /\.(js|css|png|svg)$/i.test(p)) continue;
    out.add(p.replace(/\?(?=\/|$)/g, ""));
  }
  return [...out];
}

/**
 * One router route as templates per kind. "/embed/:type/:id" gives
 * movie: /embed/movie/{tmdb} and (with :season/:episode) tv: …/{season}/{episode}.
 * @returns {{ movie?: string, tv?: string, player: boolean }}
 */
export function routeToTemplates(route, origin) {
  const segs = route.split("/").filter(Boolean);
  const mapped = segs.map((s) => {
    if (!s.startsWith(":")) return s;
    const name = s.slice(1).replace(/\?$/, "");
    const hit = PARAM_MAP.find(([re]) => re.test(name));
    return hit ? hit[1] : null;
  });
  if (mapped.includes(null)) return { player: false };
  const has = (ph) => mapped.includes(ph);
  if (!has("{tmdb}") && !has("{imdb}")) return { player: false };
  const literalKind = segs.find((s) => /^(movies?|films?)$/i.test(s)) ? "movie" : segs.find((s) => /^(tv|series|shows?|tv-shows?)$/i.test(s)) ? "tv" : null;
  const player = segs.some((s) => PLAYER_WORDS.includes(s.toLowerCase()));
  const info = segs.some((s) => INFO_WORDS.test(s));
  const episodic = has("{season}") && has("{episode}");
  const out = { player: player && !info, info };
  const build = (kind) => origin + "/" + mapped.map((s) => (s === "{type}" ? kind : s)).join("/");
  if (has("{type}")) {
    if (episodic) out.tv = build("tv");
    else out.movie = build("movie");
  } else if (literalKind === "movie" && !episodic) out.movie = build("movie");
  else if (literalKind === "tv" && episodic) out.tv = build("tv");
  else if (!literalKind) {
    if (episodic) out.tv = build("tv");
    else out.movie = build("movie");
  }
  return out;
}

/** Usual embed-site routes, in the order they are worth trying. */
export const COMMON_PATTERNS = Object.freeze({
  movie: [
    "/embed/movie/{tmdb}",
    "/embed/movie?tmdb={tmdb}",
    "/embed/movie/{imdb}",
    "/embed/{tmdb}",
    "/movie/{tmdb}",
    "/watch/movie/{tmdb}",
    "/play/movie/{tmdb}",
    "/player/movie/{tmdb}",
    "/movie/{tmdb}/watch",
    "/embed?tmdb={tmdb}",
    "/embed?imdb={imdb}",
    "/e/movie/{tmdb}",
    "/v2/embed/movie/{tmdb}",
    "/api/embed/movie/{tmdb}",
  ],
  tv: [
    "/embed/tv/{tmdb}/{season}/{episode}",
    "/embed/tv?tmdb={tmdb}&season={season}&episode={episode}",
    "/embed/tv/{imdb}/{season}/{episode}",
    "/embed/tv/{tmdb}/{season}-{episode}",
    "/embed/{tmdb}/{season}/{episode}",
    "/tv/{tmdb}/{season}/{episode}",
    "/watch/tv/{tmdb}/{season}/{episode}",
    "/play/tv/{tmdb}/{season}/{episode}",
    "/player/tv/{tmdb}/{season}/{episode}",
    "/tv/{tmdb}/watch?season={season}&episode={episode}",
    "/embed?tmdb={tmdb}&season={season}&episode={episode}",
    "/embed?imdb={imdb}&season={season}&episode={episode}",
    "/e/tv/{tmdb}/{season}/{episode}",
    "/v2/embed/tv/{tmdb}/{season}/{episode}",
    "/api/embed/tv/{tmdb}/{season}/{episode}",
  ],
  anime: ["/embed/anime/{anilist}/{episode}/{lang}", "/anime/{anilist}/{episode}/{lang}", "/embed/anime/{anilist}/{episode}", "/watch/anime/{anilist}/{episode}"],
});

/**
 * A pasted details template rewritten to the site's likely player links:
 * the info word swapped for each player word, and a trailing fixed slug
 * (not a placeholder) dropped. "https://m-zone.cc/details/movie/{tmdb}/rn-6665a44c"
 * -> "https://m-zone.cc/embed/movie/{tmdb}", ".../watch/movie/{tmdb}", ...
 */
export function rewriteDetails(template) {
  const m = /^(https?:\/\/[^/]+)(\/[^?#]*)?(\?[^#]*)?/.exec(String(template || ""));
  if (!m) return [];
  const origin = m[1];
  const segs = (m[2] || "").split("/").filter(Boolean);
  const out = [];
  const add = (s) => {
    const t = origin + "/" + s.join("/");
    if (t !== template && !out.includes(t)) out.push(t);
  };
  // Slug dropped: fixed segments after the last placeholder that aren't kind / episode words.
  const lastPh = segs.reduce((a, s, i) => (/\{[a-z]+\}/.test(s) ? i : a), -1);
  const trimmed = lastPh >= 0 ? segs.filter((s, i) => i <= lastPh || /\{[a-z]+\}/.test(s)) : segs;
  const infoAt = trimmed.findIndex((s) => INFO_WORDS.test(s));
  if (infoAt >= 0) {
    for (const w of ["embed", "watch", "play", "player"]) add(trimmed.map((s, i) => (i === infoAt ? w : s)));
    add(trimmed.filter((s, i) => i !== infoAt));
  } else {
    if (trimmed.length !== segs.length) add(trimmed);
    if (!trimmed.some((s) => PLAYER_WORDS.includes(s.toLowerCase()))) {
      add(["embed", ...trimmed]);
      add([...trimmed, "watch"]);
      add(["watch", ...trimmed]);
    }
  }
  return out;
}

/** Movie -> TV (or back) for a player route: the kind word swapped, season / episode added or dropped. */
export function otherKind(template, from) {
  if (!template) return null;
  if (from === "movie") {
    if (!/\/(movies?|films?)\//i.test(template)) return null;
    const t = template.replace(/\/(movies?|films?)\//i, "/tv/");
    if (t.includes("?")) return null;
    return t.replace(/(\{tmdb\}|\{imdb\})/, "$1/{season}/{episode}");
  }
  if (from === "tv") {
    if (!/\/tv\//i.test(template)) return null;
    return template.replace(/\/tv\//i, "/movie/").replace(/\/\{season\}\/\{episode\}/, "").replace(/[?&]season=\{season\}&episode=\{episode\}/, "");
  }
  return null;
}

/**
 * Links to try per kind, best first, each with why it is on the list.
 * @param {{ origin: string, pasted?: {movie?, tv?, anime?}, scriptTexts?: string[],
 *           scriptRoutes?: {movie?: string[], tv?: string[], anime?: string[]} }} input
 * @returns {{ movie: Array<{tpl, why}>, tv: Array<{tpl, why}>, anime: Array<{tpl, why}>, routes: string[] }}
 */
export function discoverCandidates({ origin, pasted = {}, scriptTexts = [], scriptRoutes = {} }) {
  const out = { movie: [], tv: [], anime: [] };
  const add = (k, tpl, why) => {
    if (!tpl || !k || !out[k]) return;
    if (/\{(type|slug)\}/.test(tpl) && !/\{slug\}/.test(pasted[k] || "")) return;
    if (!out[k].some((c) => c.tpl === tpl)) out[k].push({ tpl, why });
  };
  // 1. Router routes from the bundle: player routes first, info routes never.
  const routes = [...new Set(scriptTexts.flatMap(paramRoutes))];
  const mapped = routes.map((r) => ({ r, t: routeToTemplates(r, origin) })).filter((x) => x.t.movie || x.t.tv);
  mapped.sort((a, b) => Number(b.t.player) - Number(a.t.player) || Number(!!a.t.info) - Number(!!b.t.info));
  for (const { r, t } of mapped) {
    if (t.info) continue;
    if (!t.player && pasted.movie && t.movie === pasted.movie) continue;
    if (t.movie) add("movie", t.movie, `site route ${r}`);
    if (t.tv) add("tv", t.tv, `site route ${r}`);
  }
  // 2. The pasted link rewritten to a player link.
  for (const k of ["movie", "tv", "anime"]) {
    for (const t of rewriteDetails(pasted[k])) add(k, t, "pasted link, player page");
  }
  // Cross-fill: a movie route found gives the TV one and back.
  for (const c of [...out.movie]) add("tv", otherKind(c.tpl, "movie"), `${c.why} (TV form)`);
  for (const c of [...out.tv]) add("movie", otherKind(c.tpl, "tv"), `${c.why} (movie form)`);
  // String-joined routes the crawl read from scripts.
  for (const k of ["movie", "tv", "anime"]) for (const t of scriptRoutes[k] || []) add(k, t, "site script");
  // 3. The usual embed routes.
  for (const k of ["movie", "tv", "anime"]) for (const p of COMMON_PATTERNS[k]) add(k, origin + p, "usual embed route");
  return { ...out, routes };
}

/** Whether a template points at an info page rather than a player. */
export const looksLikeInfoPage = (template) => {
  try {
    const segs = new URL(String(template).replace(/\{[a-z]+\}/g, "1")).pathname.split("/").filter(Boolean);
    return segs.some((s) => INFO_WORDS.test(s)) && !segs.some((s) => PLAYER_WORDS.includes(s.toLowerCase()));
  } catch {
    return false;
  }
};
