// Custom servers, site lookup: sites whose links carry a per-title site id
// ("https://bingebang.sx/tv/play/family-guy-y6bs3k/1/1") can't be built from
// TMDB alone. The adder learns the site's own search (an API or a search
// page) by searching the pasted title and finding the pasted link's segment
// in the answer; when a title plays, the same search finds that title's
// segment ({site}). Pure logic: `http(url)` is passed in (native HTTP on
// iPhone, no CORS).
import { splitSlug, titleWords } from "./template";

/** Searches sites usually answer, tried at once. {type}: movie / tv. */
export const SEARCH_PATTERNS = Object.freeze([
  "/api/search/{type}?query={query}&page=1",
  "/api/search/multi?query={query}&page=1",
  "/api/search?query={query}",
  "/api/search?q={query}",
  "/api/search?keyword={query}",
  "/api/v1/search?query={query}",
  "/search/{type}?query={query}",
  "/search?q={query}",
  "/search?query={query}",
  "/search?keyword={query}",
  "/search/{query}",
  "/?s={query}",
  "/ajax/search?keyword={query}",
  "/filter?keyword={query}",
]);

/** The search link for a title. */
export const searchUrl = (pattern, { query, type }) =>
  pattern.replace("{query}", encodeURIComponent(query)).replace("{type}", type === "tv" ? "tv" : "movie");

/**
 * Learn how the site finds a title: the first search whose answer holds the
 * pasted link's segment.
 * @param {{ origin, kind: "movie"|"tv", title, siteSegment, http, extra?: string[] }} o
 *   extra: more search links read from the site (its search form), with {query}
 * @returns {Promise<{ url: string, type: string } | null>} url: a pattern with {query} (and {type})
 */
export async function learnLookup({ origin, kind, title, siteSegment, http, extra = [] }) {
  if (!siteSegment || !title || !http) return null;
  const patterns = [...extra.map((e) => (e.startsWith("http") ? e : origin + e)), ...SEARCH_PATTERNS.map((p) => origin + p)];
  const uniq = [...new Set(patterns)];
  const want = siteSegment.toLowerCase();
  const hits = await Promise.all(
    uniq.map(async (p) => {
      try {
        const r = await http(searchUrl(p, { query: title, type: kind }));
        const text = typeof r?.text === "string" ? r.text.toLowerCase() : "";
        return r?.status < 400 && text.includes(want) ? p : null;
      } catch {
        return null;
      }
    }),
  );
  const url = hits.find(Boolean);
  return url ? { url, type: kind } : null;
}

/**
 * Every slug segment with a site id in a search answer, with what it says.
 * @returns {Array<{ segment, words: string[], year: number|null }>}
 */
export function siteSegments(text) {
  const out = new Map();
  const src = String(text || "").replace(/\\\//g, "/");
  for (const m of src.matchAll(/(?<![a-z0-9-])([a-z0-9]+(?:-[a-z0-9]+)+)(?![a-z0-9-])/gi)) {
    const seg = m[1];
    if (seg.length > 120 || out.has(seg)) continue;
    const sp = splitSlug(seg);
    if (!sp.siteId || !sp.words.length) continue;
    out.set(seg, { segment: seg, words: sp.words.map((w) => w.toLowerCase()), year: sp.year });
  }
  return [...out.values()];
}

/** The segment of the title asked for in a search answer (title words equal, year when given). */
export function pickSegment(text, { title, year }) {
  const want = titleWords(title).join(" ");
  const all = siteSegments(text).filter((s) => titleWords(s.words.join(" ")).join(" ") === want);
  if (!all.length) return null;
  const sameYear = year ? all.find((s) => s.year === Number(year)) : null;
  return (sameYear || all.find((s) => !s.year) || all[0]).segment;
}

/** Find a title's {site} value through the learned search. */
export async function resolveSite(lookup, { title, year, kind, http }) {
  if (!lookup?.url || !title) return null;
  try {
    const r = await http(searchUrl(lookup.url, { query: title, type: kind || lookup.type }));
    if (!r || r.status >= 400) return null;
    return pickSegment(r.text, { title, year });
  } catch {
    return null;
  }
}
