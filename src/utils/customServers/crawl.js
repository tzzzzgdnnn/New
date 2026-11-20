// Custom servers, smart add from any link on a site (homepage included):
// read the page, robots.txt, the sitemap, the search form and the script
// bundles, find the site's own movie / episode / anime links and pick the
// best sample of each kind for the matcher. Pure logic: the caller passes
// `http(url) -> { status, text, url }`, so Node tests run it on saved HTML
// (scripts/fixtures/custom-sites).
import { analyzeUrl, isOnSite, originOf, siteDomain } from "./template";
import { scanEndpoints, scanWorthy } from "./direct";

/** Each page fetch gives up after this long. */
export const CRAWL_FETCH_TIMEOUT_MS = 4000;
/** The whole crawl stops after this long (smart add's budget is ~20 s). */
export const CRAWL_BUDGET_MS = 7000;
/** Pages fetched after the first one (title pages, list pages, search). */
const MAX_FOLLOW = 6;
/** Script bundles scanned for routes. */
const MAX_SCRIPTS = 6;
const MAX_SITEMAP_URLS = 4000;
const MAX_HTML = 2 * 1024 * 1024;

const KIND_SEGMENTS = {
  movie: /^(movies?|films?)$/i,
  tv: /^(tv|series|shows?|tv-shows?|tvshows?|serie|episodes?)$/i,
  anime: /^(anime|animes)$/i,
};
// Path words that mean "this page plays the video".
const PLAY_WORDS = /(^|[/?&=_-])(watch|embed|play|player|stream|e)([/?&=_.-]|$)/i;
const ASSET = /\.(css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|xml|txt|json|webmanifest|pdf|zip)(\?|#|$)/i;
const SKIP_PATH = /^\/(cdn-cgi|_next|static|assets|api|fonts|images?|img|wp-content|wp-json|login|signin|signup|register|account|settings|watchlist|dmca|privacy|terms|contact|about|faq)(\/|$)/i;

// ── Reading HTML / sitemaps ──────────────────────────────────────────────

/** Decode the HTML entities links carry ("&amp;", "&#x2F;"). */
export const decodeEntities = (s) =>
  String(s || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#x2f;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");

const abs = (u, base) => {
  try {
    return new URL(decodeEntities(u).trim(), base).href;
  } catch {
    return null; // a malformed href is skipped
  }
};

/**
 * Links on a page that stay on the site: <a href>, <iframe src>, plus
 * site-relative paths written in inline data ("/tv/1421/watch?…").
 * @returns {string[]} absolute, unique, assets and account pages left out
 */
export function extractLinks(html, base) {
  const text = String(html || "").slice(0, MAX_HTML);
  const site = siteDomain(base);
  const out = new Set();
  const add = (u) => {
    const a = abs(u, base);
    if (!a || !/^https?:/i.test(a)) return;
    const url = new URL(a);
    if (!isOnSite(url.hostname, site) || ASSET.test(url.pathname) || SKIP_PATH.test(url.pathname)) return;
    url.hash = "";
    out.add(url.href);
  };
  // <a href>, <iframe src>, and any element a script turns into a link
  // (data-href, data-navigation-href, data-url: 7movies' episode cards).
  for (const m of text.matchAll(/<(a|iframe|area)\b[^>]*?\s(?:href|src)\s*=\s*(["'])(.*?)\2/gis)) add(m[3]);
  for (const m of text.matchAll(/\sdata-(?:[\w-]*-)?(?:href|url|link|src)\s*=\s*(["'])(.*?)\1/gis)) add(m[2]);
  // Inline JSON / scripts: quoted site paths that look like title pages.
  for (const m of text.matchAll(/["'](\/(?:[a-z-]+\/)*[a-z-]*\d[^"'\s<>\\]{0,80})["']/gi)) {
    if (/^\/(movie|tv|series|show|anime|watch|embed|film)/i.test(m[1])) add(m[1]);
  }
  return [...out];
}

/** <loc> entries of a sitemap (or sitemap index). */
export const sitemapLocs = (xml) => [...String(xml || "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1])).slice(0, MAX_SITEMAP_URLS);

/** Sitemap addresses robots.txt lists. */
export const robotsSitemaps = (txt) => [...String(txt || "").matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);

/**
 * A sitemap on a mirror domain (robots.txt "Host:" / another TLD) lists the
 * same paths: move them onto the site the viewer pasted.
 */
export function rebase(urls, origin) {
  return urls
    .map((u) => {
      try {
        const x = new URL(u);
        return origin + x.pathname + x.search;
      } catch {
        return null; // not a URL
      }
    })
    .filter(Boolean);
}

/** Site name and icon from the page head. */
export function siteInfo(html, base) {
  const text = String(html || "").slice(0, 200000);
  const meta = (re) => re.exec(text)?.[1]?.trim() || null;
  const ogName = meta(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) || meta(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
  const appName = meta(/<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']+)["']/i);
  const title = decodeEntities(meta(/<title[^>]*>([^<]{1,120})<\/title>/i) || "");
  // "Watch Movies Online — 7Movies" -> "7Movies": the part that isn't a slogan.
  const parts = title.split(/\s+[-–—|·:]\s+/).map((p) => p.trim()).filter(Boolean);
  const fromTitle = parts.length > 1 ? parts.sort((a, b) => a.length - b.length)[0] : parts[0] || null;
  const icons = [...text.matchAll(/<link\b[^>]*rel=["'](?:shortcut )?(?:icon|apple-touch-icon)["'][^>]*>/gi)].map((m) => /href=["']([^"']+)["']/i.exec(m[0])?.[1]).filter(Boolean);
  // A PNG / apple-touch icon beats a tiny .ico.
  const icon = icons.find((h) => /apple-touch|\.png/i.test(h)) || icons[0] || "/favicon.ico";
  return { name: (ogName || appName || fromTitle || "").slice(0, 40) || null, icon: abs(icon, base) };
}

/** The site's search page as a URL with {query}, from a <form> with a text field. */
export function searchTemplate(html, base) {
  for (const m of String(html || "").matchAll(/<form\b([^>]*)>(.*?)<\/form>/gis)) {
    const action = /action=["']([^"']*)["']/i.exec(m[1])?.[1] ?? "";
    const method = /method=["']([^"']*)["']/i.exec(m[1])?.[1] ?? "get";
    if (!/^get$/i.test(method)) continue;
    const input = /<input\b[^>]*type=["']?(?:search|text)["']?[^>]*>/i.exec(m[2]) || /<input\b[^>]*name=["'](?:q|query|s|keyword|search|term)["'][^>]*>/i.exec(m[2]);
    const name = input && /name=["']([^"']+)["']/i.exec(input[0])?.[1];
    if (!name) continue;
    const url = abs(action || base, base);
    if (!url) continue;
    return `${url.split("?")[0]}?${encodeURIComponent(name)}={query}`;
  }
  // No form: the usual /search?q= is tried by the caller only if nothing else worked.
  return null;
}

/** Script bundle addresses on a page, site scripts first. */
export function scriptUrls(html, base) {
  const out = [];
  for (const m of String(html || "").matchAll(/<script\b[^>]*\ssrc=["']([^"']+)["']/gi)) {
    const u = abs(m[1], base);
    if (u && scanWorthy(u) && !out.includes(u)) out.push(u);
  }
  // Page / app chunks hold the routes; framework runtime chunks don't.
  return out.sort((a, b) => (/\/(app|pages)\//.test(b) ? 1 : 0) - (/\/(app|pages)\//.test(a) ? 1 : 0));
}

// ── Classifying links ────────────────────────────────────────────────────

/**
 * What a link on the site is: its kind, whether it plays (watch / embed /
 * episode numbers), and its shape (numbers replaced) to group siblings.
 * @returns {{ url, kind: string|null, plays: boolean, episode: boolean, hasId: boolean, shape: string, score: number }}
 */
export function classifyLink(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { url, kind: null, plays: false, episode: false, hasId: false, shape: "", score: -1 };
  }
  const segs = u.pathname.split("/").filter(Boolean);
  const kindAt = segs.findIndex((s) => Object.values(KIND_SEGMENTS).some((re) => re.test(s)));
  let kind = null;
  if (kindAt >= 0) kind = Object.keys(KIND_SEGMENTS).find((k) => KIND_SEGMENTS[k].test(segs[kindAt]));
  if (kind === "tv" && /^episodes?$/i.test(segs[kindAt])) kind = "tv";
  const a = analyzeUrl(url);
  if (!kind && a.kind) kind = a.kind;
  const q = u.searchParams;
  const episode =
    /(^|[^a-z])(s\d{1,2}e\d{1,4}|\d{1,2}x\d{1,4})([^a-z0-9]|$)/i.test(u.pathname) ||
    ((q.has("season") || q.has("s") || q.has("ss")) && (q.has("episode") || q.has("e") || q.has("ep"))) ||
    (kind === "tv" && segs.length - kindAt >= 4 && /^\d+$/.test(segs[segs.length - 1]) && /^\d+$/.test(segs[segs.length - 2])) ||
    (kind === "anime" && segs.slice(kindAt + 1).filter((x) => /^\d+$/.test(x)).length >= 2);
  const plays = PLAY_WORDS.test(u.pathname + u.search) || episode;
  const hasIdRaw = a.numbers.length > 0 || a.imdb.length > 0;
  // A kind list page ("/movies", "/tv/page/2") has no title in it.
  // "/movies/action/2" is a list page: a plural kind word then a word.
  const listPage =
    segs.length <= 1 ||
    /^(page|genre|genres|category|year|country|top|popular|trending|latest|new|a-z|filter|discover)$/i.test(segs[kindAt + 1] || "") ||
    (/^(movies|films|tv-shows|shows|animes)$/i.test(segs[kindAt] || "") && !!segs[kindAt + 1] && !/\d/.test(segs[kindAt + 1]));
  const hasId = hasIdRaw && !listPage;
  const shape = u.pathname.replace(/\d+/g, "#").replace(/\/[^/]*[a-z][^/]*-[^/]*(?=\/|$)/gi, "/~") + (u.search ? "?" + [...q.keys()].sort().join("&") : "");
  let score = 0;
  if (kind) score += 10;
  if (hasId || /[a-z]-[a-z]/i.test(u.pathname)) score += 10;
  if (plays) score += 20;
  if (episode) score += 15;
  if (listPage && !hasId) score -= 40;
  return { url, kind, plays, episode, hasId, shape, score, listPage };
}

/**
 * Best sample link per kind: plays beats a details page, an episode link
 * beats a show page. Also the title pages worth opening to find play links.
 * @returns {{ samples: {movie?, tv?, anime?}, follow: string[] }}
 */
export function pickSamples(urls) {
  const items = urls.map(classifyLink).filter((c) => c.kind && c.score > 0);
  const samples = {};
  const follow = [];
  for (const kind of ["movie", "tv", "anime"]) {
    const mine = items.filter((c) => c.kind === kind).sort((a, b) => b.score - a.score);
    const best = mine[0];
    if (!best) continue;
    const ready = kind === "movie" ? best.plays : best.episode;
    if (ready) samples[kind] = best.url;
    else {
      // Keep the details link as a fallback sample and open one to find its play links.
      samples[kind] = samples[kind] || null;
      follow.push(best.url);
      if (!samples[kind] && best.hasId) samples[`${kind}Details`] = best.url;
    }
  }
  return { samples, follow };
}

/** Kind list pages ("/movies", "/tv", "/anime") worth opening when no title link was seen. */
export function listPages(urls) {
  return urls.filter((u) => {
    const c = classifyLink(u);
    return c.kind && c.listPage;
  });
}

/** Site routes written in scripts ("/movie/".concat(id,"/watch")), as page templates per kind. */
export function routesFromScripts(texts, origin) {
  const out = { movie: [], tv: [], anime: [] };
  for (const t of texts) {
    for (const p of scanEndpoints(t)) {
      if (/^\/?api\//i.test(p.replace(/^https?:\/\/[^/]+/, "").replace(/^\//, ""))) continue;
      const path = p.replace(/^https?:\/\/[^/]+/, "");
      if (!path.startsWith("/")) continue;
      const holes = path.split("\u0000").length - 1;
      const seg = path.split("/")[1] || "";
      const kind = Object.keys(KIND_SEGMENTS).find((k) => KIND_SEGMENTS[k].test(seg));
      if (!kind) continue;
      const fill = kind === "movie" ? ["{tmdb}"] : kind === "tv" ? ["{tmdb}", "{season}", "{episode}"] : ["{anilist}", "{episode}", "{lang}"];
      if (holes < 1 || holes > fill.length) continue;
      let i = 0;
      const tpl = origin + path.replace(/\u0000/g, () => fill[i++]);
      if (kind === "tv" && holes < 3) continue; // a show page, not an episode
      if (!out[kind].includes(tpl)) out[kind].push(tpl);
    }
  }
  return out;
}

// ── The crawl ─────────────────────────────────────────────────────────────

/**
 * Read a site from any link on it.
 * @param {string} start the pasted link
 * @param {{ http: (url) => Promise<{status, text, url?}>, onStep?: (id, state, detail?) => void,
 *           budgetMs?: number, searchTitles?: {movie?: string, tv?: string, anime?: string} }} deps
 * @returns {Promise<{ origin, name, icon, samples: {movie?, tv?, anime?}, details: {movie?, tv?, anime?},
 *                     scriptRoutes, search: string|null, pages: number, wall: string|null, errors: string[] }>}
 */
export async function crawlSite(start, { http, onStep = () => {}, budgetMs = CRAWL_BUDGET_MS, searchTitles = {} } = {}) {
  const origin = originOf(start);
  const deadline = Date.now() + budgetMs;
  const errors = [];
  const seen = new Map(); // url -> text
  let wall = null;
  const get = async (url) => {
    if (seen.has(url)) return seen.get(url);
    if (Date.now() > deadline) return null;
    try {
      const r = await http(url);
      const text = typeof r?.text === "string" ? r.text : "";
      if (r?.status === 403 || r?.status === 503) {
        if (/cf-chl|challenge-platform|just a moment|attention required|cf-browser-verification|ddos-guard/i.test(text)) wall = "Cloudflare";
      }
      if (!r || r.status >= 400) {
        errors.push(`${new URL(url).pathname}: HTTP ${r?.status ?? "?"}`);
        seen.set(url, null);
        return null;
      }
      seen.set(url, text);
      return text;
    } catch (e) {
      errors.push(`${new URL(url).pathname}: ${e?.message || e}`);
      seen.set(url, null);
      return null;
    }
  };

  onStep("read", "running");
  const home = origin + "/";
  const [first, homeHtml, robots] = await Promise.all([get(start), start === home ? null : get(home), get(origin + "/robots.txt")]);
  const pageHtml = first ?? homeHtml;
  const headHtml = homeHtml ?? first;
  const info = siteInfo(headHtml, origin);
  onStep("read", pageHtml ? "done" : "failed", pageHtml ? info.name || siteDomain(origin) : wall ? `${wall} check` : errors[0]);

  onStep("links", "running");
  let links = [...extractLinks(first, start), ...extractLinks(homeHtml, home)];
  const sitemaps = robotsSitemaps(robots);
  const sitemapUrl = sitemaps[0] || origin + "/sitemap.xml";
  const sm = await get(sitemapUrl);
  let locs = sitemapLocs(sm);
  // A sitemap index: open its first child sitemap that names a kind.
  if (locs.length && locs.every((l) => /\.xml(\?|$)/i.test(l))) {
    const child = locs.find((l) => /movie|tv|show|series|anime|post/i.test(l)) || locs[0];
    locs = sitemapLocs(await get(child));
  }
  links.push(...rebase(locs, origin).filter((u) => !/\.xml(\?|$)/i.test(u)));
  links = [...new Set(links)];

  let { samples, follow } = pickSamples(links);
  // No title links at all: open the kind list pages ("/movies", "/tv").
  if (!follow.length && !Object.values(samples).some(Boolean)) follow = listPages(links).slice(0, 3);
  // Open title / list pages to reach their play links.
  const opened = await Promise.all(follow.slice(0, MAX_FOLLOW).map(async (u) => extractLinks(await get(u), u)));
  links = [...new Set([...links, ...opened.flat()])];
  ({ samples } = pickSamples(links));

  // Search: a known title, for kinds still without a link.
  const search = searchTemplate(headHtml, origin) || searchTemplate(first, start);
  const missing = ["movie", "tv", "anime"].filter((k) => !samples[k] && searchTitles[k]);
  if (search && missing.length) {
    const found = await Promise.all(missing.map(async (k) => extractLinks(await get(search.replace("{query}", encodeURIComponent(searchTitles[k]))), origin)));
    links = [...new Set([...links, ...found.flat()])];
    let more = pickSamples(links);
    if (more.follow.length) {
      const deeper = await Promise.all(more.follow.slice(0, 3).map(async (u) => extractLinks(await get(u), u)));
      links = [...new Set([...links, ...deeper.flat()])];
      more = pickSamples(links);
    }
    for (const k of missing) samples[k] = samples[k] || more.samples[k] || null;
  }

  // Script bundles: routes the app builds in the browser.
  const scripts = scriptUrls(headHtml, origin).slice(0, MAX_SCRIPTS);
  const texts = (await Promise.all(scripts.map(get))).filter(Boolean);
  const scriptRoutes = routesFromScripts(texts, origin);

  const details = {};
  for (const k of ["movie", "tv", "anime"]) if (samples[`${k}Details`]) details[k] = samples[`${k}Details`];
  const clean = Object.fromEntries(["movie", "tv", "anime"].filter((k) => samples[k]).map((k) => [k, samples[k]]));
  const kinds = Object.keys(clean);
  onStep("links", kinds.length ? "done" : "failed", kinds.length ? `Found ${kinds.map((k) => (k === "tv" ? "episode" : k)).join(", ")} links` : "No movie or episode links on the site");
  return { origin, name: info.name, icon: info.icon, samples: clean, details, scriptRoutes, search, pages: seen.size, wall, errors, links: links.length };
}
