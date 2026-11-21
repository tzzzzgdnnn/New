// Custom servers: turn one sample link from a site into a URL template, and
// fill a template for any title. Pure logic (no DOM, no network), so Node
// tests run it (scripts/test-custom-servers.mjs).
//
// A template is the sample link with the title's values replaced by
// placeholders, for example
//   https://site.tv/embed/tv/1399/2/5      -> https://site.tv/embed/tv/{tmdb}/{season}/{episode}
//   https://site.tv/watch/inception-2010   -> https://site.tv/watch/{slug}-{year}
//   http://192.168.1.20:8080/a/21?ep=7&dub -> http://192.168.1.20:8080/a/{anilist}?ep={episode}&{lang}

/** Every placeholder a template may hold. */
// {site}: the site's own path for a title ("family-guy-y6bs3k"): slug plus a
// per-title site id that TMDB can't give; looked up through the site's own
// search (the server's `lookup` recipe) when a title plays.
export const PLACEHOLDERS = Object.freeze(["tmdb", "imdb", "tvdb", "anilist", "mal", "kitsu", "title", "slug", "site", "year", "season", "episode", "absolute", "lang"]);
/** Placeholders that identify the title (a template needs one of them). */
export const ID_PLACEHOLDERS = Object.freeze(["tmdb", "imdb", "tvdb", "anilist", "mal", "kitsu", "title", "slug", "site"]);

/**
 * A per-title site id at the end of a slug ("family-guy-y6bs3k" -> "y6bs3k",
 * "avengers-endgame-2019-5iu40l" -> "5iu40l"): 4–10 letters and digits mixed,
 * not a year, not an episode word, not "s01e02".
 */
export const SITE_ID_TOKEN = /^(?=[a-z0-9]{4,10}$)(?=.*\d)(?=.*[a-z])(?!s\d{1,2}e\d{1,4}$)(?!\d{1,2}x\d{1,4}$)(?!(?:ep?|episode|season|s)\d+$)(?!\d{3,4}p$)(?!x26[45]$)(?!h26[45]$)[a-z0-9]+$/i;

/** A slug path segment split into title words, year and trailing site id. */
export function splitSlug(segment) {
  const parts = String(segment || "").split(/[-_+.\s]+/).filter(Boolean);
  let siteId = null;
  if (parts.length >= 2 && SITE_ID_TOKEN.test(parts[parts.length - 1])) siteId = parts.pop();
  let year = null;
  if (parts.length >= 2 && /^(19|20)\d\d$/.test(parts[parts.length - 1])) year = Number(parts.pop());
  return { words: parts, year, siteId };
}
/** Kinds of link a server can have a template for. */
export const TEMPLATE_KINDS = Object.freeze(["movie", "tv", "anime"]);

const MAX_SEASON = 99;
const MAX_EPISODE = 9999;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
// Path words that say what kind of page a link is.
const KIND_WORDS = {
  anime: ["anime", "anilist", "mal", "myanimelist"],
  tv: ["tv", "series", "show", "shows", "episode", "episodes", "season", "seasons", "serie", "tvshow"],
  movie: ["movie", "movies", "film", "films"],
};
// Words that never belong to a title in a link.
const NOISE_WORDS = new Set([
  "watch", "embed", "player", "play", "stream", "streaming", "video", "videos", "v", "e", "s", "ep", "html", "htm",
  "php", "aspx", "en", "online", "free", "full", "hd", "sub", "dub", "id", "media", "tmdb", "imdb", "www", "index",
  "tvdb", "thetvdb", "themoviedb", "kitsu", "details",
  ...KIND_WORDS.anime, ...KIND_WORDS.tv, ...KIND_WORDS.movie,
]);

/** Lowercase words of a title, accents dropped. */
export function titleWords(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Separators a site may put between the words of a title slug. */
export const SLUG_SEPARATORS = Object.freeze(["-", "_", "+", ".", "%20"]);
/** The usual slug: lowercase words joined by "-". */
export const DEFAULT_SLUG_STYLE = Object.freeze({ sep: "-", case: "lower" });

/** Title words with their own capitals kept (accents dropped). */
function titleWordsKeepCase(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/**
 * How a site writes a title in its links, read from the slug in a sample:
 * "the-dark-knight" -> { sep: "-", case: "lower" }, "The_Dark_Knight" ->
 * { sep: "_", case: "title" }.
 */
export function slugStyleFrom(value) {
  const v = String(value || "");
  const sep = SLUG_SEPARATORS.find((s) => v.includes(s)) || DEFAULT_SLUG_STYLE.sep;
  const letters = v.replace(/%20/g, " ").replace(/[^A-Za-z]/g, "");
  let kase = "lower";
  if (letters && letters === letters.toUpperCase() && letters.length > 1) kase = "upper";
  else if (letters !== letters.toLowerCase()) {
    const words = v.split(sep).filter((w) => /[A-Za-z]/.test(w));
    kase = words.every((w) => /^[A-Z0-9]/.test(w)) ? "title" : "keep";
  }
  return { sep, case: kase };
}

/** A saved slug style with only known values (anything else: the default). */
export function normalizeSlugStyle(style) {
  const sep = SLUG_SEPARATORS.includes(style?.sep) ? style.sep : DEFAULT_SLUG_STYLE.sep;
  const kase = ["lower", "upper", "title", "keep"].includes(style?.case) ? style.case : DEFAULT_SLUG_STYLE.case;
  return { sep, case: kase };
}

/** "The Dark Knight: Rises!" -> "the-dark-knight-rises" (or the site's own style). */
export function slugify(title, style = DEFAULT_SLUG_STYLE) {
  const { sep, case: kase } = normalizeSlugStyle(style);
  const words = kase === "keep" ? titleWordsKeepCase(title) : titleWords(title);
  const cased =
    kase === "upper"
      ? words.map((w) => w.toUpperCase())
      : kase === "title"
        ? words.map((w) => w[0].toUpperCase() + w.slice(1))
        : words;
  return cased.join(sep);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Scheme + host (+ port) of a link, or null for anything but http(s). */
export function originOf(url) {
  try {
    const u = new URL(String(url).trim());
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// Second-level labels under which sites register (example.co.uk).
const SHARED_SLD = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"]);

/**
 * The site's own domain, used to block redirects and pop-ups that leave it:
 * "embed.site.tv" -> "site.tv", "a.b.co.uk" -> "b.co.uk". An IP address,
 * "localhost" or a one-label LAN name is kept whole.
 */
export function siteDomain(url) {
  let host;
  try {
    host = new URL(String(url).trim()).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!host) return null;
  if (IPV4.test(host) || host.includes(":") || host.startsWith("[")) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const sld = labels[labels.length - 2];
  const keep = SHARED_SLD.has(sld) && labels[labels.length - 1].length === 2 ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** Whether `host` is the site's domain or one of its subdomains. */
export function isOnSite(host, site) {
  const h = String(host || "").toLowerCase();
  const s = String(site || "").toLowerCase();
  return !!h && !!s && (h === s || h.endsWith("." + s));
}

/** True for addresses on the viewer's own network (http allowed without a warning). */
export function isLocalAddress(url) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home") || !host.includes(".")) return true;
  const m = IPV4.exec(host) && host.split(".").map(Number);
  if (!m) return false;
  return m[0] === 10 || m[0] === 127 || (m[0] === 192 && m[1] === 168) || (m[0] === 172 && m[1] >= 16 && m[1] <= 31) || (m[0] === 169 && m[1] === 254);
}

/**
 * What a link says on its own: the words that hint at its kind, the numbers
 * and IMDb ids in it (possible title ids), and a title guessed from its
 * slug. The matcher looks these up on TMDB / AniList.
 * @returns {{ ok: boolean, error?: string, origin?: string, kind?: "movie"|"tv"|"anime"|null,
 *   numbers: number[], imdb: string[], titleGuess: string, yearGuess: number|null }}
 */
export function analyzeUrl(url) {
  const empty = { ok: false, numbers: [], imdb: [], titleGuess: "", yearGuess: null, kind: null };
  const origin = originOf(url);
  if (!origin) return { ...empty, error: "Paste a full link that starts with http:// or https://" };
  const tail = String(url).trim().slice(origin.length);
  let decoded = tail;
  try {
    decoded = decodeURIComponent(tail.replace(/\+/g, " "));
  } catch {
    // A stray "%" in the link: read it as typed.
  }
  const words = decoded.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const kind = ["anime", "tv", "movie"].find((k) => words.some((w) => KIND_WORDS[k].includes(w))) || null;
  const imdb = [...new Set(decoded.match(/tt\d{5,9}/g) || [])];
  const numbers = [...new Set((decoded.match(/(?<![a-z0-9])\d{1,8}(?![a-z0-9])/gi) || []).map(Number))];
  const yearGuess = numbers.find((n) => n >= MIN_YEAR && n <= MAX_YEAR && n <= new Date().getFullYear() + 2) ?? null;
  // Title guess: the longest run of plain words in one path segment / value,
  // without a per-title site id ("-y6bs3k") or the year ("-2019").
  let titleGuess = "";
  let siteId = null;
  let slugSegment = null;
  let slugYear = null;
  const parts = decoded.split(/[/?&#=]+/);
  let slugAt = -1;
  parts.forEach((part, i) => {
    const sp = splitSlug(part);
    const kept = sp.words.filter((w) => /[a-z]/i.test(w) && !/^tt\d+$/i.test(w) && !NOISE_WORDS.has(w.toLowerCase()));
    // A lone short word next to a token ("rn-6665a44c", m-zone's watch token) is not a title.
    const run = kept.length === 1 && kept[0].length <= 2 && (sp.siteId || /\d/.test(part)) ? "" : kept.join(" ");
    if (run.length > titleGuess.length) {
      titleGuess = run;
      siteId = sp.siteId;
      slugYear = sp.year;
      slugSegment = part;
      slugAt = i;
    }
  });
  // Plain numbers after a slug ("/family-guy-y6bs3k/1/1") are season / episode, never title ids.
  const trailing = slugAt >= 0 && titleGuess.split(" ").length >= 1
    ? [...new Set(parts.slice(slugAt + 1).filter((x) => /^\d{1,4}$/.test(x)).map(Number))]
    : [];
  const idNumbers = numbers.filter((n) => !trailing.includes(n) || n > 9999);
  return { ok: true, origin, kind, numbers, idNumbers, trailing, imdb, titleGuess, yearGuess: slugYear ?? yearGuess, siteId, slugSegment };
}

// ── Template detection ────────────────────────────────────────────────────

/** Every match of `re` (global) in `s` as a span { start, end, ph, value }. */
const spansOf = (s, re, ph) => [...s.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length, ph, value: m[0] }));

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

/**
 * Turn a sample link into a template.
 * @param {string} sample the link pasted from the site
 * @param {{ kind: "movie"|"tv"|"anime", ids?: { tmdb?, imdb?, anilist?, mal? },
 *           title?: string, year?: number }} match what the link was matched to
 * @returns {{ ok: boolean, template: string|null, kind: string, placeholders: string[],
 *             warnings: string[], error?: string }}
 */
export function detectTemplate(sample, match) {
  const kind = TEMPLATE_KINDS.includes(match?.kind) ? match.kind : "movie";
  const fail = (error) => ({ ok: false, template: null, kind, placeholders: [], warnings: [], error });
  const origin = originOf(sample);
  if (!origin) return fail("Paste a full link that starts with http:// or https://");
  const raw = String(sample).trim();
  const tail = raw.slice(origin.length);
  const ids = match?.ids || {};
  const spans = [];
  const take = (list) => {
    for (const sp of list) if (!spans.some((o) => overlaps(o, sp))) spans.push(sp);
  };
  const num = (n) => new RegExp(`(?<![0-9])${n}(?![0-9])`, "g");

  // 0. The site's own id for the title (an internal number or token, found
  //    through its search): {site}.
  if (match?.siteValue != null && String(match.siteValue) !== "") {
    const v = String(match.siteValue);
    take(spansOf(tail, new RegExp(`(?<![a-z0-9])${escapeRe(v)}(?![a-z0-9])`, "gi"), "site"));
  }
  // 1. Title ids: exact numbers / IMDb id, never inside a longer number.
  if (ids.imdb) take(spansOf(tail, new RegExp(escapeRe(String(ids.imdb)), "g"), "imdb"));
  for (const ph of ["tmdb", "tvdb", "anilist", "mal", "kitsu"]) {
    if (ids[ph] != null && String(ids[ph]) !== "") take(spansOf(tail, num(String(ids[ph])), ph));
  }
  // 2. Season / episode written out: s01e05, 1x05, season-2, ep=7, episode/7.
  if (kind !== "movie") {
    for (const m of tail.matchAll(/(?<![a-z0-9])s(\d{1,2})[-_.]?e(\d{1,4})(?![0-9])/gi)) {
      const s = m.index + 1;
      const e = m.index + m[0].length - m[2].length;
      take([
        { start: s, end: s + m[1].length, ph: "season", value: m[1] },
        { start: e, end: e + m[2].length, ph: "episode", value: m[2] },
      ]);
    }
    for (const m of tail.matchAll(/(?<![a-z0-9])(\d{1,2})x(\d{1,4})(?![a-z0-9])/gi)) {
      const e = m.index + m[1].length + 1;
      take([
        { start: m.index, end: m.index + m[1].length, ph: "season", value: m[1] },
        { start: e, end: e + m[2].length, ph: "episode", value: m[2] },
      ]);
    }
    const labelled = (labels, ph) =>
      [...tail.matchAll(new RegExp(`(?<![a-z0-9])(?:${labels})(?:[-_=/:]|%3d)?(\\d{1,4})(?![0-9])`, "gi"))].map((m) => {
        const start = m.index + m[0].length - m[1].length;
        return { start, end: start + m[1].length, ph, value: m[1] };
      });
    take(labelled("seasons?|ssn|se|s", "season"));
    take(labelled("episodes?|eps?|e", "episode"));
  }
  // 3. Title as a slug ("the-dark-knight") or as text ("The%20Dark%20Knight").
  const words = titleWords(match?.title);
  if (words.length) {
    const sep = "(?:[-_+.]|%20|%2[dD])";
    take(spansOf(tail, new RegExp(`(?<![a-z0-9])${words.map(escapeRe).join(sep)}(?![a-z0-9])`, "gi"), "slug").map((sp) => {
      // Exactly the title as typed (URL-encoded) is {title}; any other
      // spelling is a slug in the site's own style (slugStyleFrom).
      return sp.value === encodeURIComponent(match.title) ? { ...sp, ph: "title" } : sp;
    }));
  }
  // 4. Year, 5. Sub/Dub.
  if (match?.year) take(spansOf(tail, num(String(match.year)), "year"));
  if (kind === "anime" || /(?<![a-z])(sub|dub)(?![a-z])/i.test(tail)) {
    // never a query key (?sub=vortex picks a server, it isn't the language)
    take(spansOf(tail, /(?<![a-z])(?:sub|dub)(?![a-z])(?!=)/gi, "lang"));
  }
  // 6. Season / episode by position: the plain numbers after the title id.
  if (kind !== "movie") {
    const anchor = Math.max(0, ...spans.filter((s) => ID_PLACEHOLDERS.includes(s.ph)).map((s) => s.end));
    const free = [...tail.matchAll(/(?<![a-z0-9])\d{1,4}(?![a-z0-9])/gi)]
      .map((m) => ({ start: m.index, end: m.index + m[0].length, value: m[0] }))
      .filter((n) => n.start >= anchor && !spans.some((o) => overlaps(o, n)));
    const has = (ph) => spans.some((s) => s.ph === ph);
    if (!has("episode") && free.length) {
      const ep = free[free.length - 1];
      if (Number(ep.value) <= MAX_EPISODE) take([{ ...ep, ph: "episode" }]);
      const before = free.length > 1 ? free[free.length - 2] : null;
      if (!has("season") && kind === "tv" && before && Number(before.value) <= MAX_SEASON) take([{ ...before, ph: "season" }]);
    }
  }

  // A per-title site id right after the slug ("family-guy-y6bs3k"): the whole
  // segment is the site's own path for the title, {site}, found through its search.
  const slugIdx = spans.findIndex((sp) => sp.ph === "slug" || sp.ph === "title");
  if (slugIdx >= 0) {
    const sp = spans[slugIdx];
    const after = /^([-_.][0-9]{4})?[-_.]([a-z0-9]{4,10})(?=$|[/?#&])/i.exec(tail.slice(sp.end));
    if (after && SITE_ID_TOKEN.test(after[2])) {
      const end = sp.end + after[0].length;
      for (let i = spans.length - 1; i >= 0; i--) if (spans[i] !== sp && spans[i].start >= sp.start && spans[i].end <= end) spans.splice(i, 1);
      spans[spans.indexOf(sp)] = { start: sp.start, end, ph: "site", value: tail.slice(sp.start, end) };
    }
  }
  // Never two of the same title id ("/{tmdb}/{tmdb}"): keep the first.
  for (const ph of ID_PLACEHOLDERS) {
    const same = spans.filter((sp) => sp.ph === ph);
    for (const extra of same.slice(1)) spans.splice(spans.indexOf(extra), 1);
  }
  spans.sort((a, b) => a.start - b.start);
  let template = origin;
  let at = 0;
  for (const sp of spans) {
    template += tail.slice(at, sp.start) + `{${sp.ph}}`;
    at = sp.end;
  }
  template += tail.slice(at);
  const placeholders = [...new Set(spans.map((s) => s.ph))];
  const slugSpan = spans.find((sp) => sp.ph === "slug");
  const slugStyle = slugSpan ? slugStyleFrom(slugSpan.value) : null;
  const warnings = [];
  if (!placeholders.some((p) => ID_PLACEHOLDERS.includes(p))) {
    return { ...fail("Couldn't find the title's id or name in this link."), template, placeholders };
  }
  if (kind !== "movie" && !placeholders.includes("episode")) warnings.push("No episode number found in the link.");
  if (kind === "tv" && !placeholders.includes("season")) warnings.push("No season in the link: every season uses the episode number as is.");
  return { ok: true, template, kind, placeholders, warnings, slugStyle };
}

/** Placeholders a template uses, in order. */
export const templatePlaceholders = (template) => [...new Set([...String(template || "").matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]))];

/**
 * Whether a hand-edited template is usable: http(s), only known
 * placeholders, and one that names the title. Returns an error or null.
 */
/** Whether a template uses one title id twice ("/{tmdb}/{tmdb}"): never a real link. */
export const hasDuplicateId = (template) =>
  ID_PLACEHOLDERS.some((ph) => (String(template || "").match(new RegExp(`\\{${ph}\\}`, "g")) || []).length > 1);

export function validateTemplate(template) {
  if (!originOf(String(template || "").replace(/\{[a-z]+\}/g, "1"))) return "The link must start with http:// or https://";
  const used = templatePlaceholders(template);
  const unknown = used.filter((p) => !PLACEHOLDERS.includes(p));
  if (unknown.length) return `Unknown placeholder {${unknown[0]}}`;
  if (!used.some((p) => ID_PLACEHOLDERS.includes(p))) return "Add {tmdb}, {imdb}, {tvdb}, {anilist}, {mal}, {kitsu}, {title} or {slug}";
  if (hasDuplicateId(template)) return "A title id is in the link twice";
  return null;
}

/**
 * Fill a template for one title. Returns null when the template needs a
 * value the title doesn't have (an AniList template on a movie without one).
 * @param {string} template
 * @param {{ tmdb?, imdb?, anilist?, mal?, title?, year?, season?, episode?, absolute?, lang?,
 *           slugStyle? }} v  slugStyle: how this site writes slugs (slugStyleFrom)
 */
export function buildUrl(template, v = {}) {
  if (!template) return null;
  const values = {
    tmdb: v.tmdb,
    imdb: v.imdb,
    tvdb: v.tvdb,
    anilist: v.anilist,
    mal: v.mal,
    kitsu: v.kitsu,
    title: v.title ? encodeURIComponent(v.title) : null,
    slug: v.title ? slugify(v.title, v.slugStyle || DEFAULT_SLUG_STYLE) || null : null,
    year: v.year,
    season: v.season ?? 1,
    episode: v.episode ?? 1,
    absolute: v.absolute ?? v.episode ?? 1,
    lang: v.lang === "dub" ? "dub" : "sub",
    site: v.site || null,
  };
  let missing = false;
  const url = template.replace(/\{([a-z]+)\}/g, (all, ph) => {
    const val = values[ph];
    if (val == null || val === "") {
      missing = true;
      return all;
    }
    return ph === "title" || ph === "slug" || ph === "site" ? String(val) : encodeURIComponent(String(val));
  });
  return missing ? null : url;
}

const MOVIE_SEGMENTS = ["movie", "movies", "film", "films"];
const TV_SEGMENTS = ["tv", "series", "show", "shows", "serie", "tvshow"];

/**
 * Guess a site's link for another kind from the one we have, the way most
 * embed sites lay them out: /movie/{tmdb} <-> /tv/{tmdb}/{season}/{episode}.
 * Returns null when there is no safe guess (anime links, no kind word).
 * A guessed template is marked so the editor can ask for a test.
 */
export function deriveTemplate(template, from, to) {
  if (!template || from === to || from === "anime" || to === "anime") return null;
  const origin = originOf(template.replace(/\{[a-z]+\}/g, "1"));
  if (!origin) return null;
  const [path, query = ""] = template.slice(origin.length).split(/\?(.*)/s);
  const segs = path.split("/");
  const fromWords = from === "movie" ? MOVIE_SEGMENTS : TV_SEGMENTS;
  const i = segs.findIndex((s) => fromWords.includes(s.toLowerCase()));
  if (i < 0) return null;
  const word = segs[i];
  const swap = to === "tv" ? (word.toLowerCase().endsWith("s") ? "series" : "tv") : word.toLowerCase().endsWith("s") ? "movies" : "movie";
  const out = segs.slice();
  out[i] = word === word.toUpperCase() && word.length > 2 ? swap.toUpperCase() : swap;
  let p = out.join("/");
  let q = query;
  if (to === "tv") {
    if (!templatePlaceholders(template).some((x) => x === "episode" || x === "absolute")) p = p.replace(/\/?$/, "/{season}/{episode}");
  } else {
    p = p.replace(/\/\{(season|episode|absolute)\}/g, "");
    q = q
      .split("&")
      .filter((kv) => !/\{(season|episode|absolute)\}/.test(kv))
      .join("&");
  }
  const out2 = origin + p + (q ? `?${q}` : "");
  // Never a broken guess: one title id once, and a movie link without episode numbers.
  if (hasDuplicateId(out2)) return null;
  if (to === "movie" && /\{(season|episode|absolute)\}/.test(out2)) return null;
  if (!templatePlaceholders(out2).some((x) => ID_PLACEHOLDERS.includes(x))) return null;
  return out2;
}
