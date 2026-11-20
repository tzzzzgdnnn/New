// Custom servers: recognise the common embed link layouts ("families") and
// fill in the links for the kinds the pasted sample didn't cover. Pure logic
// (no DOM, no network), tested in scripts/test-custom-direct.mjs.
//
//   path     /embed/movie/{tmdb}  ·  /embed/tv/{tmdb}/{season}/{episode}
//            /anime/{anilist}/{episode}/{lang}
//   query    /embed?tmdb={tmdb}&type=movie  ·  …&type=tv&s={season}&e={episode}
//            /embed/tv?id={tmdb}&s={season}&e={episode}
import { originOf, templatePlaceholders, TEMPLATE_KINDS } from "./template";

const MOVIE_WORDS = ["movie", "movies", "film", "films"];
const TV_WORDS = ["tv", "series", "show", "shows", "serie", "tvshow"];
const ANIME_WORDS = ["anime"];
const KIND_WORDS = { movie: MOVIE_WORDS, tv: TV_WORDS, anime: ANIME_WORDS };
// Query keys sites use for season / episode, as pairs that go together.
const SE_PAIRS = [
  ["season", "episode"],
  ["s", "e"],
  ["ss", "ep"],
  ["sea", "epi"],
];

/** Split a template into origin, path segments and query pairs (placeholders kept). */
function parts(template) {
  const origin = originOf(String(template || "").replace(/\{[a-z]+\}/g, "1"));
  if (!origin) return null;
  const [path, query = ""] = template.slice(origin.length).split(/\?(.*)/s);
  const pairs = query ? query.split("&").map((kv) => kv.split(/=(.*)/s).slice(0, 2)) : [];
  return { origin, segs: path.split("/"), pairs };
}

const join = ({ origin, segs, pairs }) => {
  const q = pairs.map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join("&");
  return origin + segs.join("/") + (q ? `?${q}` : "");
};

const kindOfWord = (w) => TEMPLATE_KINDS.find((k) => KIND_WORDS[k].includes(String(w).toLowerCase())) || null;

/** The same kind word in the other kind's spelling ("movies" -> "series", "MOVIE" -> "TV"). */
function swapWord(word, to) {
  const plural = /s$/i.test(word) && !/^series$/i.test(word);
  const out = to === "tv" ? (plural ? "series" : "tv") : to === "anime" ? "anime" : plural ? "movies" : "movie";
  return word === word.toUpperCase() && word.length > 2 ? out.toUpperCase() : out;
}

/** The id placeholder a family uses for a kind. */
const idFor = (kind, tpl) => {
  const used = templatePlaceholders(tpl);
  if (kind === "anime") return used.includes("mal") ? "mal" : "anilist";
  return used.find((p) => p === "tmdb" || p === "imdb") || "tmdb";
};

/**
 * Which family a template belongs to, or null when it is site-specific.
 * @returns {{ family: "path"|"query", kind: "movie"|"tv"|"anime", at: number, key?: string } | null}
 *   `at`: the path segment (path) or query pair (query) holding the kind word.
 */
export function embedFamily(template) {
  const p = parts(template);
  if (!p) return null;
  const used = templatePlaceholders(template);
  if (!used.some((x) => ["tmdb", "imdb", "anilist", "mal"].includes(x))) return null;
  const at = p.segs.findIndex((s) => kindOfWord(s));
  if (at >= 0) {
    // The id sits right after the kind word: /movie/{tmdb}, /tv/{tmdb}/…
    const next = p.segs[at + 1] || "";
    if (/^\{(tmdb|imdb|anilist|mal)\}$/.test(next)) return { family: "path", kind: kindOfWord(p.segs[at]), at };
    // …or in the query: /embed/tv?id={tmdb}&s={season}&e={episode}
    if (p.pairs.some(([, v]) => /^\{(tmdb|imdb|anilist|mal)\}$/.test(v || ""))) return { family: "query", kind: kindOfWord(p.segs[at]), at, key: null };
    return null;
  }
  const qi = p.pairs.findIndex(([, v]) => kindOfWord(v || ""));
  if (qi >= 0 && p.pairs.some(([, v]) => /^\{(tmdb|imdb|anilist|mal)\}$/.test(v || ""))) {
    return { family: "query", kind: kindOfWord(p.pairs[qi][1]), at: qi, key: p.pairs[qi][0] };
  }
  return null;
}

/** Season / episode query keys a template already uses, or the family default. */
function seKeys(pairs) {
  for (const [s, e] of SE_PAIRS) {
    if (pairs.some(([k]) => k === s) && pairs.some(([k]) => k === e)) return [s, e];
  }
  return ["season", "episode"];
}

/**
 * The link for another kind on the same site, following its family.
 * Returns null when there is no safe guess. Guesses are marked by the caller
 * and checked by the smart-add probes.
 */
export function familyTemplate(template, to) {
  const fam = embedFamily(template);
  if (!fam || fam.kind === to) return null;
  const p = parts(template);
  const from = fam.kind;
  const segs = p.segs.slice();
  let pairs = p.pairs.map((x) => x.slice());
  const fromId = idFor(from, template);
  const toId = to === "anime" ? "anilist" : from === "anime" ? "tmdb" : fromId;

  if (fam.family === "path") {
    segs[fam.at] = swapWord(segs[fam.at], to);
    // Everything after the kind word is the family's own tail.
    const tail = to === "movie" ? [`{${toId}}`] : to === "tv" ? [`{${toId}}`, "{season}", "{episode}"] : [`{${toId}}`, "{episode}", "{lang}"];
    segs.splice(fam.at + 1, segs.length - fam.at - 1, ...tail);
    return join({ origin: p.origin, segs, pairs: to === "movie" ? pairs.filter(([, v]) => !/\{(season|episode|lang)\}/.test(v || "")) : pairs });
  }
  // Query family.
  if (fam.key) pairs[fam.at][1] = swapWord(pairs[fam.at][1], to);
  else segs[fam.at] = swapWord(segs[fam.at], to);
  pairs = pairs.map(([k, v]) => [k, v && new RegExp(`^\\{${fromId}\\}$`).test(v) ? `{${toId}}` : v]);
  const [sk, ek] = seKeys(p.pairs);
  pairs = pairs.filter(([, v]) => !/\{(season|episode|lang)\}/.test(v || ""));
  if (to === "tv") pairs.push([sk, "{season}"], [ek, "{episode}"]);
  if (to === "anime") pairs.push([ek, "{episode}"], ["lang", "{lang}"]);
  return join({ origin: p.origin, segs, pairs });
}

/**
 * Fill every kind a family can give from the templates we have.
 * @param {{movie?, tv?, anime?}} templates
 * @returns {{ templates, guessed: {movie?, tv?, anime?}, family: string|null }}
 */
export function fillFromFamily(templates) {
  const out = { ...templates };
  const guessed = {};
  const source = ["tv", "movie", "anime"].map((k) => templates[k]).find((t) => t && embedFamily(t));
  const fam = source ? embedFamily(source) : null;
  if (source) {
    for (const k of TEMPLATE_KINDS) {
      if (out[k]) continue;
      const g = familyTemplate(source, k);
      if (g) {
        out[k] = g;
        guessed[k] = true;
      }
    }
  }
  return { templates: out, guessed, family: fam ? `${fam.family === "path" ? "/embed/{kind}/{id}" : "?id=&s=&e="} links` : null };
}

/** Plain words for the ids a set of templates uses ("TMDB ids", "titles in the link"). */
export function idScheme(templates) {
  const used = new Set(Object.values(templates || {}).flatMap((t) => templatePlaceholders(t)));
  const names = [];
  if (used.has("tmdb")) names.push("TMDB");
  if (used.has("imdb")) names.push("IMDb");
  if (used.has("anilist")) names.push("AniList");
  if (used.has("mal")) names.push("MAL");
  if (names.length) return `${names.join(" + ")} ids`;
  if (used.has("slug") || used.has("title")) return "titles in the link";
  return "unknown ids";
}

/** Whether a template carries a Sub/Dub value (path or query). */
export const hasLang = (template) => templatePlaceholders(template).includes("lang");
