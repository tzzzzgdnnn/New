// Site adder: add a whole site from its home page link. discoverSite() works
// out, on its own, how the site searches (WordPress REST, OpenSearch, its
// search form, the JSON API its pages call, or its sitemap), what its title
// pages look like, and where its player hides the stream (captured requests,
// decoded scripts, or one of its server / mirror buttons). The result is a
// "recipe" saved with the server. resolveSite() then turns any title in the
// app into the site's links for it: the stream itself when it can be read
// straight from the page (played directly), every server / mirror the page
// offers, and the page itself (played through the hidden stream finder).
//
// No network or DOM here: the caller passes `net`, so Node tests run this
// with fixtures and the e2e test with a real headless browser.
//   net.fetch(url, { headers, method, body, timeoutMs })
//     -> { ok, status, url, text, contentType }   native HTTP, the web view's
//        cookies (Cloudflare clearance) and User-Agent sent along
//   net.render(url, { play, search, timeoutMs })
//     -> { ok, status, url, title, frames[], api[], media[], drm, cookie, userAgent, challenge }
//        the page in a hidden web view (collector.js)
//   net.interactive?(url) -> { ok }  show a Cloudflare check once (iPhone)
import { findMediaUrls, playableUrls, isProtectedManifest, masterVariants, aesKeyUris, firstSegment, mediaKind } from "./decode";
import { titleWords, siteDomain, isOnSite, originOf } from "./template";

export const RECIPE_VERSION = 1;
/** Below this a search hit is not the title. */
export const MIN_MATCH = 0.72;
const QUERY_WORDS = 3;

// ── Pages ───────────────────────────────────────────────────────────────

/** Cloudflare / DDoS-Guard "checking your browser" page. */
export function isChallenge(res) {
  if (!res) return false;
  const t = String(res.text ?? res.html ?? res.title ?? "").slice(0, 60000);
  const title = String(res.title || /<title[^>]*>([^<]*)/i.exec(t)?.[1] || "");
  if (/^\s*(?:just a moment|attention required|please wait|checking your browser|ddos-guard)/i.test(title)) return true;
  if (/cf-chl-|challenge-platform|cf_chl_opt|__cf_chl_|cdn-cgi\/challenge|ddos-guard\/js-challenge/i.test(t) && (res.status === 403 || res.status === 503 || res.status === 429 || t.length < 40000)) return true;
  return false;
}

/** Whether the challenge needs a person (Turnstile / hCaptcha box), not just a wait. */
export const isInteractiveChallenge = (res) => isChallenge(res) && /turnstile|hcaptcha|g-recaptcha|cf-turnstile|challenges\.cloudflare\.com\/turnstile/i.test(String(res.text ?? res.html ?? ""));

const stripTags = (s) => String(s || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#8217;/g, "’").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const absUrl = (u, base) => {
  try {
    return new URL(String(u).replace(/&amp;/g, "&"), base).href;
  } catch {
    return null;
  }
};

/** Anchors of an HTML page: [{ href, text }] (absolute links, text from the anchor, its title or its image's alt). */
export function extractLinks(html, base) {
  const out = [];
  for (const m of String(html || "").matchAll(/<a\b([^>]*?)\bhref\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = absUrl(m[3], base);
    if (!href || !/^https?:/i.test(href)) continue;
    const attrs = m[1] + m[4];
    const inner = m[5];
    const text = stripTags(inner) || /\btitle\s*=\s*["']([^"']+)/i.exec(attrs)?.[1] || /\balt\s*=\s*["']([^"']+)/i.exec(inner)?.[1] || "";
    out.push({ href, text: text.slice(0, 160) });
  }
  return out;
}

/** Forms of an HTML page: [{ action, method, inputs: [{ name, type, placeholder, value }] }]. */
export function extractForms(html, base) {
  const out = [];
  for (const m of String(html || "").matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const action = absUrl(/\baction\s*=\s*["']([^"']*)/i.exec(m[1])?.[1] || "", base) || base;
    const method = (/\bmethod\s*=\s*["']?(\w+)/i.exec(m[1])?.[1] || "get").toLowerCase();
    const inputs = [...m[2].matchAll(/<(?:input|select|textarea)\b([^>]*)>/gi)].map((i) => ({
      name: /\bname\s*=\s*["']([^"']*)/i.exec(i[1])?.[1] || "",
      type: (/\btype\s*=\s*["']?([\w-]+)/i.exec(i[1])?.[1] || "text").toLowerCase(),
      placeholder: /\bplaceholder\s*=\s*["']([^"']*)/i.exec(i[1])?.[1] || "",
      value: /\bvalue\s*=\s*["']([^"']*)/i.exec(i[1])?.[1] || "",
    }));
    out.push({ action, method, inputs });
  }
  return out;
}

const SEARCH_NAMES = ["s", "q", "query", "keyword", "keywords", "search", "k", "term", "search_query", "story", "title", "searchword", "do"];

/** The search form of a page as a GET link template ("…?s={q}"), or null. */
export function searchFormTemplate(forms) {
  for (const f of forms || []) {
    if (f.method !== "get" && f.method !== "") continue;
    const box = f.inputs.find((i) => i.type === "search") ||
      f.inputs.find((i) => SEARCH_NAMES.includes(i.name.toLowerCase()) && i.type !== "hidden") ||
      f.inputs.find((i) => /search|find|title/i.test(i.placeholder) && i.name);
    if (!box?.name) continue;
    if (f.inputs.some((i) => i.type === "password")) continue;
    const u = new URL(f.action);
    for (const i of f.inputs) if (i.type === "hidden" && i.name && !u.searchParams.has(i.name)) u.searchParams.set(i.name, i.value);
    u.searchParams.set(box.name, "__Q__");
    return u.href.replace("__Q__", "{q}");
  }
  return null;
}

/** OpenSearch description link in a page, or null. */
export const openSearchLink = (html, base) => {
  const m = /<link\b[^>]*rel\s*=\s*["']search["'][^>]*>/i.exec(String(html || ""));
  const href = m && /\bhref\s*=\s*["']([^"']+)/i.exec(m[0])?.[1];
  return href ? absUrl(href, base) : null;
};

/** The HTML search link template of an OpenSearch description ("…{searchTerms}" -> "{q}"). */
export function parseOpenSearch(xml) {
  const urls = [...String(xml || "").matchAll(/<Url\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick = urls.find((a) => /type\s*=\s*["']text\/html/i.test(a)) || urls.find((a) => /json/i.test(a)) || urls[0];
  const t = pick && /template\s*=\s*["']([^"']+)/i.exec(pick)?.[1];
  return t ? t.replace(/&amp;/g, "&").replace(/\{searchTerms\}/g, "{q}").replace(/[?&][a-zA-Z]+=\{[a-zA-Z:]+\?\}/g, "") : null;
}

/** Whether a page is a WordPress site (its REST search then works). */
export const isWordPress = (html) => /wp-content\/|wp-includes\/|api\.w\.org|\/wp-json\//i.test(String(html || ""));

/** Server / mirror buttons on a page: [{ label, url }] (data-* links, base64 ones decoded, iframes). */
export function extractMirrors({ html = "", mirrors = [], iframes = [] } = {}, base, { site } = {}) {
  const raw = [...mirrors];
  for (const m of String(html).matchAll(/<(\w+)\b([^>]*\bdata-(?:embed|link|video|iframe|url|src|source|file|server|hash)\s*=\s*["'][^"']{6,}["'][^>]*)>([\s\S]{0,200}?)<\/\1>/gi)) {
    if (/^(?:img|script)$/i.test(m[1])) continue;
    const v = /\bdata-(?:embed|link|video|iframe|url|src|source|file|server|hash)\s*=\s*["']([^"']{6,})["']/i.exec(m[2])?.[1];
    raw.push({ label: stripTags(m[3]).slice(0, 40), value: v });
  }
  for (const m of String(html).matchAll(/<option\b[^>]*\bvalue\s*=\s*["']([^"']{8,})["'][^>]*>([^<]{0,60})/gi)) raw.push({ label: stripTags(m[2]), value: m[1] });
  for (const m of String(html).matchAll(/<iframe\b[^>]*\b(?:data-)?src\s*=\s*["']([^"']+)["']/gi)) iframes.push(m[1]);
  const out = [];
  const seen = new Set();
  const add = (u, label) => {
    const a = absUrl(u, base);
    if (!a || !/^https?:/i.test(a) || seen.has(a)) return;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js)(?:[?#]|$)/i.test(a)) return;
    if (/doubleclick|googlesyndication|facebook\.com\/plugins|twitter\.com\/widgets|disqus|recaptcha|youtube\.com\/embed\/(?!.*\b(?:movie|film)\b)/i.test(a)) return;
    // A link back to an ordinary page of the site is navigation, not a server.
    let host = "";
    try {
      host = new URL(a).hostname;
    } catch {
      return;
    }
    const onSite = site && isOnSite(host, site);
    if (onSite && !/(?:^|[/_.-])(?:embed|player|play|stream|video|watch|iframe|ajax|api|server|source|e|v)(?:[/_.?=-]|$)/i.test(new URL(a).pathname + new URL(a).search)) return;
    seen.add(a);
    out.push({ label: label || host, url: a, kind: mediaKind(a) });
  };
  for (const r of raw) {
    let v = String(r.value || "").trim();
    if (!/^(?:https?:)?\/\//i.test(v) && !v.startsWith("/")) {
      // base64 link (data-hash="aHR0c…").
      try {
        const d = typeof atob === "function" ? atob(v) : Buffer.from(v, "base64").toString("binary");
        if (/^(?:https?:)?\/\//i.test(d)) v = d;
        else {
          const iframe = /<iframe[^>]+src=["']([^"']+)/i.exec(d)?.[1];
          if (iframe) v = iframe;
          else continue;
        }
      } catch {
        continue;
      }
    }
    if (/^</.test(v)) continue;
    add(v, r.label);
  }
  for (const f of iframes) if (f) add(f, null);
  return out.slice(0, 12);
}

// ── Titles ──────────────────────────────────────────────────────────────

const NAV_WORDS = new Set(["category", "categories", "tag", "tags", "genre", "genres", "page", "author", "search", "login", "register", "signup", "account", "user", "feed", "rss", "contact", "about", "privacy", "dmca", "terms", "faq", "help", "country", "year", "release", "cast", "director", "actor", "actors", "star", "wp-admin", "wp-login.php", "wp-content", "cdn-cgi", "comments", "home", "index", "az-list", "a-z", "list", "lists", "filter", "sort", "top", "trending", "popular", "latest", "new", "request", "donate", "app", "apps", "blog", "news", "studio", "network", "type", "language", "lang"]);

/** A link's path as segments ("/movies/inception-2010/" -> ["movies", "inception-2010"]). */
const segments = (url) => {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return [];
  }
};

/**
 * The URL shape most of a site's title links share, as a regexp source
 * over the path ("^/movies/[^/]+/?$"), learned from the links on a page.
 * Null when no shape covers at least three links.
 */
export function learnTitlePattern(urls, home) {
  const site = siteDomain(home);
  const groups = new Map();
  for (const u of urls) {
    let host;
    try {
      host = new URL(u).hostname;
    } catch {
      continue;
    }
    if (site && !isOnSite(host, site)) continue;
    const segs = segments(u);
    if (!segs.length || segs.length > 4) continue;
    if (segs.some((s) => NAV_WORDS.has(s.toLowerCase()))) continue;
    const last = segs[segs.length - 1];
    // A title slug: words joined by dashes, or an id-slug; not a bare number or file.
    if (!/[a-z]/i.test(last) || /\.(?:css|js|png|jpg|xml|json)$/i.test(last)) continue;
    if (!/[-_+]|\d/.test(last) && segs.length === 1) continue;
    const key = segs.length + "|" + segs.slice(0, -1).map((s) => (/^\d+$/.test(s) ? "\\d+" : s)).join("/");
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(new URL(u).origin + new URL(u).pathname);
  }
  let best = null;
  for (const [key, set] of groups) if (set.size >= 3 && (!best || set.size > best[1].size)) best = [key, set];
  if (!best) return null;
  const prefix = best[0].split("|")[1];
  const esc = prefix ? prefix.split("/").map((s) => (s === "\\d+" ? s : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "/" : "";
  return `^/${esc}[^/]+/?$`;
}

/** Whether a link is a title page by the learned shape. */
export function isTitleUrl(url, pattern, home) {
  if (!pattern) return false;
  try {
    const u = new URL(url);
    if (home && !isOnSite(u.hostname, siteDomain(home))) return false;
    return new RegExp(pattern, "i").test(decodeURIComponent(u.pathname));
  } catch {
    return false;
  }
}

const YEAR_RE = /(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/;

/** Title and year a search hit names: from its text, else from its slug. */
export function titleOf(link) {
  let text = stripTags(link.text || link.title || "");
  const slug = segments(link.href || link.url || "").pop() || "";
  const fromSlug = slug.replace(/\.[a-z]{2,5}$/i, "").replace(/^\d+[-_]/, "").replace(/[-_+]+/g, " ");
  if (!text || text.length < 2 || /^(?:watch|play|more|details|view|read more|\d+)$/i.test(text)) text = fromSlug;
  const year = Number(YEAR_RE.exec(text)?.[1] || YEAR_RE.exec(slug)?.[1]) || null;
  const title = text
    .replace(/\((?:19|20)\d{2}\)/g, " ")
    .replace(/\b(?:watch|online|free|full movie|full|movie|hd|1080p|720p|480p|stream(?:ing)?|english sub(?:bed)?|subbed|dubbed)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { title, year };
}

/** 0..1: how well a hit's title fits the wanted one (word overlap both ways, year). */
export function scoreMatch(want, hit) {
  const w = titleWords(want.title).filter((x) => x !== "the" && x !== "a");
  const h = titleWords(hit.title).filter((x) => x !== "the" && x !== "a" && !(hit.year && x === String(hit.year)));
  if (!w.length || !h.length) return 0;
  const hs = new Set(h);
  const ws = new Set(w);
  const recall = w.filter((x) => hs.has(x)).length / w.length;
  const precision = h.filter((x) => ws.has(x)).length / h.length;
  let s = recall && precision ? (2 * recall * precision) / (recall + precision) : 0;
  if (want.year && hit.year) s += want.year === hit.year ? 0.15 : Math.abs(want.year - hit.year) <= 1 ? 0 : -0.35;
  return Math.max(0, Math.min(1, s));
}

/** The best hit for a title, or null when none is close enough. */
export function pickBest(hits, want, min = MIN_MATCH) {
  let best = null;
  for (const h of hits || []) {
    const s = scoreMatch(want, h);
    if (s >= min && (!best || s > best.score)) best = { ...h, score: s };
  }
  return best;
}

/** Words to search a site for a title with (short: many old sites search by phrase). */
export function searchQuery(title, words = QUERY_WORDS) {
  const w = String(title || "").replace(/[:(].*$/, "").trim().split(/\s+/).filter(Boolean);
  return (w.length > words ? w.slice(0, words) : w).join(" ") || String(title || "");
}

// ── Episodes ────────────────────────────────────────────────────────────

/** The link of one episode on a series page, or null. */
export function findEpisode(links, season, episode) {
  const s = Number(season) || 1;
  const e = Number(episode) || 1;
  const pats = [
    new RegExp(`(?:^|[^a-z0-9])s0*${s}[-_ .]?e0*${e}(?![0-9])`, "i"),
    new RegExp(`season[-_ /]*0*${s}[-_ /]+(?:episode|ep|e)[-_ /]*0*${e}(?![0-9])`, "i"),
    new RegExp(`(?:^|[^a-z0-9])0*${s}x0*${e}(?![0-9])`, "i"),
    new RegExp(`(?:^|/)0*${s}/0*${e}/?$`),
  ];
  const single = [new RegExp(`(?:episode|ep|e)[-_ /.]*0*${e}(?![0-9])`, "i")];
  const hay = (l) => {
    let p = l.href;
    try {
      p = decodeURIComponent(new URL(l.href).pathname + new URL(l.href).search);
    } catch {
      // keep as is
    }
    return [p, l.text || ""];
  };
  for (const re of pats) {
    const hit = links.find((l) => hay(l).some((h) => re.test(h)));
    if (hit) return hit.href;
  }
  // No season in any link: one-season shows / anime count episodes alone.
  const hasSeasons = links.some((l) => /season[-_ /]*\d|(?:^|[^a-z])s\d{1,2}e\d/i.test(hay(l).join(" ")));
  if (s === 1 || !hasSeasons) {
    for (const re of single) {
      const hit = links.find((l) => hay(l).some((h) => re.test(h)));
      if (hit) return hit.href;
    }
  }
  return null;
}

// ── Search ──────────────────────────────────────────────────────────────

/** The request one search method makes for `q`. */
export function searchRequest(search, q, { apiKey = null } = {}) {
  const enc = encodeURIComponent(q);
  const headers = {};
  let url = String(search.url || "").replace(/\{q\}/g, enc);
  let body = search.body ? String(search.body).replace(/\{q\}/g, enc) : null;
  if (apiKey && (search.type === "wp" || search.type === "api")) {
    headers["X-API-Key"] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
    if (search.keyParam) url = url.replace(new RegExp(`([?&]${search.keyParam}=)[^&]*`), `$1${encodeURIComponent(apiKey)}`);
  }
  if (search.type === "wp" || search.type === "api") headers.Accept = "application/json, text/plain, */*";
  if (body && search.contentType) headers["Content-Type"] = search.contentType;
  return { url, method: search.method || "GET", body, headers };
}

/** Objects in a JSON value that look like titles: [{ url, title, year }]. */
export function jsonTitles(value, base) {
  const out = [];
  const walk = (v, depth) => {
    if (!v || depth > 7 || out.length > 200) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v !== "object") return;
    const t = v.title?.rendered ?? v.title ?? v.name ?? v.post_title ?? v.original_title ?? v.label;
    const link = v.url ?? v.link ?? v.permalink ?? v.href ?? v.path ?? v.watch_url ?? v.page;
    if (typeof t === "string" && typeof link === "string" && link.length > 1) {
      const url = absUrl(link, base);
      if (url && /^https?:/.test(url)) {
        const y = Number(v.year ?? String(v.release_date ?? v.date ?? v.first_air_date ?? "").slice(0, 4)) || null;
        const { title, year } = titleOf({ text: stripTags(t), href: url });
        out.push({ url, title, year: (y >= 1900 && y <= 2100 ? y : null) || year });
      }
    }
    for (const k of Object.keys(v)) if (typeof v[k] === "object") walk(v[k], depth + 1);
  };
  walk(value, 0);
  return out;
}

const parseJson = (text) => {
  try {
    return JSON.parse(String(text).replace(/^\)\]\}',?\s*/, ""));
  } catch {
    return undefined;
  }
};

/** Search hits from a response: [{ url, title, year }] (title pages only when the shape is known). */
export function parseSearchResults(text, base, { pattern = null, home = null, links = null } = {}) {
  const json = /^\s*[[{]/.test(String(text || "")) ? parseJson(text) : undefined;
  if (json !== undefined) {
    const hits = jsonTitles(json, base);
    if (hits.length) return dedupeHits(hits);
    // JSON carrying an HTML fragment (many AJAX searches).
    const html = JSON.stringify(json).replace(/\\"/g, '"').replace(/\\\//g, "/");
    return parseSearchResults(html.replace(/^"|"$/g, ""), base, { pattern, home });
  }
  const all = links || extractLinks(text, base);
  const site = home ? siteDomain(home) : null;
  const hits = all
    .filter((l) => {
      try {
        if (site && !isOnSite(new URL(l.href).hostname, site)) return false;
      } catch {
        return false;
      }
      return pattern ? isTitleUrl(l.href, pattern, home) : segments(l.href).length > 0 && !segments(l.href).some((s) => NAV_WORDS.has(s.toLowerCase()));
    })
    .map((l) => ({ url: l.href.split("#")[0], ...titleOf(l) }))
    .filter((h) => h.title);
  return dedupeHits(hits);
}

function dedupeHits(hits) {
  const by = new Map();
  for (const h of hits) {
    const prev = by.get(h.url);
    // Keep the most descriptive text for a link that appears twice (poster + caption).
    if (!prev || (h.title.length > prev.title.length && h.title.length < 120)) by.set(h.url, { ...prev, ...h, year: h.year ?? prev?.year ?? null });
  }
  return [...by.values()];
}

/** Title links in a sitemap (or the child sitemaps of a sitemap index). */
export function sitemapLocs(xml) {
  return [...String(xml || "").matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+)/gi)].map((m) => m[1].trim().replace(/&amp;/g, "&"));
}

/** Sitemap entries that match a query, as hits. */
export function searchSitemap(locs, q, pattern, home) {
  const words = titleWords(q);
  return locs
    .filter((u) => !pattern || isTitleUrl(u, pattern, home))
    .map((u) => ({ url: u, ...titleOf({ href: u }) }))
    .filter((h) => {
      const t = new Set(titleWords(h.title));
      return words.every((w) => t.has(w));
    });
}

// ── Discovery ───────────────────────────────────────────────────────────

/** The steps the progress shows, in order. */
export const DISCOVERY_STEPS = Object.freeze([
  { id: "site", label: "Opening the site" },
  { id: "search", label: "Finding its search" },
  { id: "title", label: "Matching a title" },
  { id: "player", label: "Finding the player" },
  { id: "stream", label: "Checking the stream" },
]);

class StepError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}

const settleFirst = (jobs) =>
  new Promise((resolve) => {
    // First job (in priority order) that succeeds; later ones only win when
    // every earlier one failed.
    const results = new Array(jobs.length);
    let done = 0;
    const check = () => {
      for (let i = 0; i < jobs.length; i++) {
        if (results[i] === undefined) return;
        if (results[i]) return resolve(results[i]);
      }
      resolve(null);
    };
    if (!jobs.length) resolve(null);
    jobs.forEach((j, i) =>
      Promise.resolve()
        .then(j)
        .then(
          (r) => (results[i] = r || null),
          () => (results[i] = null),
        )
        .finally(() => {
          done++;
          check();
        }),
    );
  });

/** Every frame's text a page showed (HTML + inline scripts), for the decoders. */
const pageTexts = (r) => (r?.frames || []).map((f) => ({ url: f.url, text: `${f.html || ""}\n${f.scripts || ""}` }));

/** Streams a rendered page gave: captured requests first, then decoded links. */
export function streamsOf(render, base) {
  const out = [];
  const seen = new Set();
  const add = (url, page, how) => {
    if (!url || seen.has(url)) return;
    const kind = mediaKind(url) || (how === "manifest" ? "hls" : null);
    if (!kind || kind === "dash") return;
    seen.add(url);
    out.push({ url, page: page || base, kind, how });
  };
  for (const m of render?.media || []) add(m.url, m.page, m.how);
  for (const a of render?.api || []) for (const u of playableUrls(findMediaUrls(a.body, a.url))) add(u.url, a.page, "api");
  for (const p of pageTexts(render)) for (const u of playableUrls(findMediaUrls(p.text, p.url))) add(u.url, p.url, "decoded");
  return out;
}

/** Headers a stream needs: the page it came from as Referer / Origin, the web view's cookies and User-Agent. */
export function streamHeaders(page, { cookie = null, userAgent = null } = {}) {
  const h = {};
  const o = originOf(page);
  if (o) {
    h.Referer = o + "/";
    h.Origin = o;
  }
  if (cookie) h.Cookie = cookie;
  if (userAgent) h["User-Agent"] = userAgent;
  return h;
}

/**
 * Fetch a stream the way the player will (same headers): its playlist, the
 * best variant, an AES-128 key if any, and the first bytes of the first
 * segment. Refuses DRM-protected streams.
 * @returns {{ ok, kind, variants?, protected?, bytes?, error? }}
 */
export async function verifyStream(net, stream, headers) {
  if (stream.kind === "mp4" || stream.kind === "webm") {
    const r = await net.fetch(stream.url, { headers: { ...headers, Range: "bytes=0-2047" }, timeoutMs: 12000, bytes: 2048 });
    const n = r?.bytes ?? String(r?.text || "").length;
    return r?.ok && n > 0 ? { ok: true, kind: stream.kind, bytes: n } : { ok: false, error: `The video answered HTTP ${r?.status || "error"}` };
  }
  const m = await net.fetch(stream.url, { headers, timeoutMs: 12000 });
  if (!m?.ok || !/^#EXTM3U/.test(String(m.text || "").trim())) return { ok: false, error: `The stream answered ${m?.ok ? "something that isn't a playlist" : `HTTP ${m?.status || "error"}`}` };
  if (isProtectedManifest(m.text)) return { ok: false, protected: true, error: "Protected (DRM) stream" };
  const base = m.url || stream.url;
  const variants = masterVariants(m.text, base);
  let media = { text: m.text, url: base };
  if (variants.length) {
    const v = await net.fetch(variants[variants.length > 1 ? variants.length - 1 : 0].url, { headers, timeoutMs: 12000 });
    if (!v?.ok) return { ok: false, error: `A quality of the stream answered HTTP ${v?.status || "error"}` };
    if (isProtectedManifest(v.text)) return { ok: false, protected: true, error: "Protected (DRM) stream" };
    media = { text: v.text, url: v.url || variants[variants.length - 1].url };
  }
  for (const k of aesKeyUris(media.text, media.url)) {
    const r = await net.fetch(k, { headers, timeoutMs: 10000, bytes: 64 });
    if (!r?.ok) return { ok: false, error: `The stream's AES key answered HTTP ${r?.status || "error"}` };
  }
  const seg = firstSegment(media.text, media.url);
  if (!seg) return { ok: false, error: "The playlist has no segments" };
  const s = await net.fetch(seg, { headers: { ...headers, Range: "bytes=0-2047" }, timeoutMs: 12000, bytes: 2048 });
  const n = s?.bytes ?? String(s?.text || "").length;
  if (!s?.ok || !n) return { ok: false, error: `The first segment answered HTTP ${s?.status || "error"}` };
  return { ok: true, kind: "hls", variants: variants.map((v) => ({ height: v.height, bandwidth: v.bandwidth })), bytes: n };
}

/** A fresh, minimal recipe. */
export function normalizeRecipe(r) {
  if (!r || typeof r !== "object" || !originOf(r.home)) return null;
  const search = r.search && typeof r.search === "object" && typeof r.search.url === "string" ? { ...r.search } : null;
  if (!search) return null;
  return {
    v: RECIPE_VERSION,
    home: originOf(r.home) + "/",
    site: siteDomain(r.home),
    render: !!r.render,
    search,
    pattern: typeof r.pattern === "string" ? r.pattern : null,
    sample: r.sample && typeof r.sample === "object" ? { url: String(r.sample.url || ""), title: String(r.sample.title || ""), year: Number(r.sample.year) || null } : null,
    player: { mode: ["direct", "sniff", "mirror"].includes(r.player?.mode) ? r.player.mode : "sniff" },
    api: Array.isArray(r.api) ? r.api.slice(0, 12).filter((a) => a && typeof a.url === "string").map((a) => ({ role: String(a.role || ""), url: a.url })) : [],
    apiKey: typeof r.apiKey === "string" && r.apiKey ? r.apiKey : null,
    quality: Array.isArray(r.quality) ? r.quality.slice(0, 8) : [],
  };
}

/** Get a page as text: native HTTP first, the hidden web view when Cloudflare (or the site) needs a browser. */
async function getPage(net, url, { render = false, play = false, search = null, timeoutMs = 15000, headers = {} } = {}) {
  if (!render) {
    const r = await net.fetch(url, { headers, timeoutMs }).catch((e) => ({ ok: false, error: e?.message }));
    if (r?.ok && !isChallenge(r)) return { via: "fetch", url: r.url || url, html: r.text || "", res: r };
    if (r && !isChallenge(r) && r.status && r.status !== 403 && r.status !== 503 && r.status !== 429) return { via: "fetch", url, html: "", res: r, error: `HTTP ${r.status}` };
  }
  let rr = await net.render(url, { play, search, timeoutMs: Math.max(timeoutMs, 15000) });
  if (rr?.challenge && net.interactive) {
    const pass = await net.interactive(url);
    if (pass?.ok) rr = await net.render(url, { play, search, timeoutMs: Math.max(timeoutMs, 15000) });
  }
  if (rr?.challenge) return { via: "render", url, html: "", res: rr, error: "challenge" };
  const top = (rr?.frames || []).find((f) => f.top) || rr?.frames?.[0];
  return { via: "render", url: rr?.url || url, html: top?.html || "", links: top?.links, forms: top?.forms, render: rr, res: rr };
}

/**
 * Work out a site from its home page link.
 * @param {string} link the pasted link (any page of the site)
 * @param {{ net, apiKey?, onStep?: (id, state, detail) => void }} opts
 * @returns {Promise<{ ok: true, recipe, name, ms } | { ok: false, step, error }>}
 */
export async function discoverSite(link, { net, apiKey = null, onStep = () => {} } = {}) {
  const t0 = Date.now();
  const origin = originOf(link);
  if (!origin) return { ok: false, step: "site", error: "Paste the site's link, starting with http:// or https://" };
  const home = origin + "/";
  let step = "site";
  const go = (id, detail) => {
    step = id;
    onStep(id, "run", detail);
  };
  const ok = (id, detail) => onStep(id, "ok", detail);
  try {
    // 1. Home page (Cloudflare's browser check passes in the hidden web view).
    go("site");
    let page = await getPage(net, home, {});
    let render = page.via === "render";
    if (page.error === "challenge") throw new StepError("site", "The site's security check didn't finish. Open the site once in Safari, then try again.");
    if (!page.html && !page.links) throw new StepError("site", page.error ? `The site answered ${page.error}.` : "The site didn't load.");
    let links = page.links || extractLinks(page.html, page.url);
    // A JavaScript-built home page: render it to see its links.
    if (!render && links.length < 10) {
      const r = await getPage(net, home, { render: true });
      if (r.links?.length > links.length) {
        links = r.links;
        page = r;
        render = true;
      }
    }
    const pastedPath = (() => {
      try {
        return new URL(link).pathname.length > 1 ? new URL(link).href : null;
      } catch {
        return null;
      }
    })();
    let pattern = learnTitlePattern(links.map((l) => l.href).concat(pastedPath ? [pastedPath] : []), home);
    ok("site", page.via === "render" ? "Loaded in the browser" : "Loaded");

    // 2. Search: every method at once, the first that finds a title on the site wins.
    go("search");
    const titles = parseSearchResults("", page.url, { pattern, home, links }).filter(
      (h) => titleWords(h.title).length && (pattern || /[-_+]/.test(segments(h.url).pop() || "")),
    );
    const samples = (pastedPath && isTitleUrl(pastedPath, pattern, home) ? [{ url: pastedPath, ...titleOf({ href: pastedPath }) }] : []).concat(titles).slice(0, 4);
    if (!samples.length) throw new StepError("search", "Couldn't find any movie or show pages on the site.");
    const sample = samples.find((s) => titleWords(s.title).length >= 1 && s.title.length >= 3) || samples[0];
    const q = searchQuery(sample.title);
    const html = page.html || "";
    const found = (hits) => {
      const best = pickBest(hits, sample, 0.6);
      return best && (best.url.replace(/\/$/, "") === sample.url.replace(/\/$/, "") || best.score >= 0.85) ? best : null;
    };
    const run = async (search) => {
      const req = searchRequest(search, q, { apiKey });
      const r = search.render ? null : await net.fetch(req.url, { headers: req.headers, method: req.method, body: req.body, timeoutMs: 12000 });
      if (r && isChallenge(r)) {
        const p = await getPage(net, req.url, { render: true });
        const hits = parseSearchResults(p.html, p.url, { pattern, home, links: p.links });
        return found(hits) ? { search: { ...search, render: true }, hits } : null;
      }
      const text = search.render ? (await getPage(net, req.url, { render: true })).html : r?.ok ? r.text : "";
      const hits = parseSearchResults(text, req.url, { pattern, home });
      return found(hits) ? { search, hits } : null;
    };
    const methods = [];
    if (apiKey || isWordPress(html)) methods.push(() => run({ type: "wp", url: `${origin}/wp-json/wp/v2/search?search={q}&per_page=20&subtype=any` }));
    const os = openSearchLink(html, page.url);
    if (os) {
      methods.push(async () => {
        const d = await net.fetch(os, { timeoutMs: 8000 });
        const tpl = d?.ok && parseOpenSearch(d.text);
        return tpl ? run({ type: "opensearch", url: absUrl(tpl, os) }) : null;
      });
    }
    const form = searchFormTemplate(page.forms || extractForms(html, page.url));
    if (form) methods.push(() => run({ type: "form", url: form, render }));
    // Common search links of old sites, tried in parallel.
    for (const path of ["/?s={q}", "/search?q={q}", "/search/{q}", "/search?keyword={q}"]) {
      const url = origin + path;
      if (url !== form) methods.push(() => run({ type: "form", url, render }));
    }
    if (!apiKey && !isWordPress(html)) methods.push(() => run({ type: "wp", url: `${origin}/wp-json/wp/v2/search?search={q}&per_page=20&subtype=any` }));
    let hit = await settleFirst(methods);
    // The site's own API: type the query into its search box and keep the
    // JSON request it makes.
    let api = [];
    if (!hit) {
      const r = await net.render(home, { search: q, timeoutMs: 15000 });
      const enc = [q, encodeURIComponent(q), q.replace(/ /g, "+"), q.replace(/ /g, "-")].map((x) => x.toLowerCase());
      const call = (r?.api || []).find((a) => enc.some((e) => (a.url + " " + (a.reqBody || "")).toLowerCase().includes(e)) && jsonTitles(parseJson(a.body), a.url).length);
      if (call) {
        const enq = enc.find((e) => call.url.toLowerCase().includes(e));
        const url = enq ? call.url.replace(new RegExp(enq.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "{q}") : call.url;
        const body = !enq && call.reqBody ? call.reqBody.replace(new RegExp(enc.find((e) => call.reqBody.toLowerCase().includes(e)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "{q}") : null;
        const keyParam = /[?&](api_?key|key|token|apikey)=/i.exec(url)?.[1] || null;
        const search = { type: "api", url, method: call.method || "GET", ...(body ? { body, contentType: /^\s*[{[]/.test(body) ? "application/json" : "application/x-www-form-urlencoded" } : {}), ...(keyParam ? { keyParam } : {}) };
        const hits = jsonTitles(parseJson(call.body), call.url);
        if (found(hits)) hit = { search, hits };
        api.push({ role: "search", url });
      }
      const top = (r?.frames || []).find((f) => f.top);
      if (!hit && top && top.url && top.url !== home) {
        const hits = parseSearchResults(top.html, top.url, { pattern, home, links: top.links });
        if (found(hits)) {
          const tplUrl = top.url.replace(encodeURIComponent(q), "{q}").replace(q.replace(/ /g, "+"), "{q}");
          if (tplUrl.includes("{q}")) hit = { search: { type: "form", url: tplUrl, render: true }, hits };
        }
      }
    }
    // Sitemap: no search at all.
    if (!hit) {
      const locs = await sitemapFor(net, origin);
      if (locs.length) {
        if (!pattern) pattern = learnTitlePattern(locs.slice(0, 3000), home);
        const hits = searchSitemap(locs, q, pattern, home);
        if (found(hits)) hit = { search: { type: "sitemap", url: `${origin}/sitemap.xml` }, hits };
      }
    }
    if (!hit) throw new StepError("search", "Couldn't find a way to search this site.");
    ok("search", { wp: "WordPress search", opensearch: "Site search", form: "Site search", api: "The site's API", sitemap: "Site map" }[hit.search.type]);

    // 3. Title.
    go("title");
    const best = found(hit.hits);
    ok("title", best.title + (best.year ? ` (${best.year})` : ""));

    // 4. Player: load the title page in the hidden web view, play it, and
    // take the first stream it gives (captured, decoded, or behind a mirror).
    go("player");
    let tp = await getPage(net, best.url, { render: true, play: true, timeoutMs: 20000 });
    let r = tp.render;
    if (r?.drm) throw new StepError("player", "This site's videos are protected (DRM), so it can't be added.");
    if (tp.error === "challenge") throw new StepError("player", "The site's security check didn't finish on the title page.");
    const top = (r?.frames || []).find((f) => f.top);
    const cookie = r?.cookie || null;
    const userAgent = r?.userAgent || null;
    // Episode pages: a series page plays nothing until an episode is opened.
    let streams = streamsOf(r, best.url);
    let pageUrl = best.url;
    if (!streams.length && top) {
      const ep = findEpisode(top.links || [], 1, 1);
      if (ep && ep !== best.url) {
        tp = await getPage(net, ep, { render: true, play: true, timeoutMs: 20000 });
        r = tp.render;
        if (r?.drm) throw new StepError("player", "This site's videos are protected (DRM), so it can't be added.");
        streams = streamsOf(r, ep);
        pageUrl = ep;
      }
    }
    const frames = r?.frames || [];
    const mirrors = frames.flatMap((f) => extractMirrors(f, f.url, { site: siteDomain(home) }));
    let mode = streams.length ? (streams.some((s) => s.how === "decoded" || s.how === "api") && !streams.some((s) => s.how !== "decoded" && s.how !== "api") ? "direct" : "sniff") : null;
    if (!streams.length && mirrors.length) {
      // Each server button, in parallel; the first that plays wins.
      const tries = mirrors.slice(0, 4).map((m) => async () => {
        const mr = await net.render(m.url, { play: true, timeoutMs: 15000 });
        if (mr?.drm) return { drm: true };
        const s = streamsOf(mr, m.url);
        return s.length ? { streams: s, render: mr } : null;
      });
      const won = await settleFirst(tries);
      if (won?.drm) throw new StepError("player", "This site's videos are protected (DRM), so it can't be added.");
      if (won) {
        streams = won.streams;
        mode = "mirror";
        r = { ...r, cookie: won.render.cookie || cookie, userAgent: won.render.userAgent || userAgent };
      }
    }
    if (!streams.length) {
      if (frames.some((f) => f.password)) throw new StepError("player", "The site wants you to sign in to watch, and Super Player doesn't get around logins.");
      throw new StepError("player", "Couldn't find a video on the site's title page.");
    }
    for (const a of r?.api || []) {
      const body = a.body || "";
      if (playableUrls(findMediaUrls(body, a.url)).length || /"(?:embed|iframe|server|servers|sources|mirrors)"/i.test(body)) api.push({ role: "sources", url: a.url });
      else if (/"episodes?"/i.test(body)) api.push({ role: "episodes", url: a.url });
    }
    ok("player", `${streams.length} stream${streams.length === 1 ? "" : "s"}${mirrors.length ? ` · ${mirrors.length} server${mirrors.length === 1 ? "" : "s"}` : ""}`);

    // 5. Stream: fetch it like the player and downloader will.
    go("stream");
    let verified = null;
    let lastErr = null;
    for (const s of streams.slice(0, 4)) {
      const v = await verifyStream(net, s, streamHeaders(s.page, { cookie: r?.cookie || cookie, userAgent: r?.userAgent || userAgent }));
      if (v.protected) throw new StepError("stream", "This site's videos are protected (DRM), so it can't be added.");
      if (v.ok) {
        verified = { ...v, stream: s };
        break;
      }
      lastErr = v.error;
    }
    if (!verified) throw new StepError("stream", lastErr ? `Found a video, but ${lastErr.charAt(0).toLowerCase()}${lastErr.slice(1)}.` : "Found a video, but it didn't load.");
    ok("stream", verified.kind === "hls" ? (verified.variants?.length ? `HLS · ${verified.variants.map((v) => (v.height ? `${v.height}p` : "auto")).join(", ")}` : "HLS") : verified.kind.toUpperCase());

    const recipe = normalizeRecipe({
      home,
      render: render || !!hit.search.render,
      search: hit.search,
      pattern,
      sample: { url: pageUrl, title: best.title, year: best.year },
      player: { mode },
      api,
      apiKey,
      quality: verified.variants || [],
    });
    let name = siteDomain(home);
    const t = top?.title || /<title[^>]*>([^<]{2,60})/i.exec(html)?.[1];
    if (t && !/just a moment/i.test(t)) name = stripTags(t).split(/\s+[|\-–—:·]\s+/)[0].slice(0, 40) || name;
    return { ok: true, recipe, name, ms: Date.now() - t0, stream: verified };
  } catch (e) {
    return { ok: false, step: e?.step || step, error: e instanceof StepError ? e.message : `Something went wrong while ${DISCOVERY_STEPS.find((s) => s.id === step)?.label.toLowerCase() || "adding the site"}: ${e?.message || e}` };
  }
}

const sitemapCache = new Map();
/** Every page link in a site's sitemap(s) (robots.txt Sitemap: lines, sitemap indexes followed a little). */
export async function sitemapFor(net, origin) {
  if (sitemapCache.has(origin)) return sitemapCache.get(origin);
  const p = (async () => {
    const roots = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`];
    const robots = await net.fetch(`${origin}/robots.txt`, { timeoutMs: 6000 }).catch(() => null);
    for (const m of String(robots?.ok ? robots.text : "").matchAll(/^\s*sitemap:\s*(\S+)/gim)) roots.unshift(m[1]);
    const locs = [];
    const seen = new Set();
    const queue = [...new Set(roots)];
    let fetched = 0;
    while (queue.length && fetched < 12 && locs.length < 50000) {
      const u = queue.shift();
      if (seen.has(u)) continue;
      seen.add(u);
      fetched++;
      const r = await net.fetch(u, { timeoutMs: 8000 }).catch(() => null);
      if (!r?.ok || !/<(?:urlset|sitemapindex)\b/i.test(r.text || "")) continue;
      const list = sitemapLocs(r.text);
      if (/<sitemapindex\b/i.test(r.text)) {
        // Title sitemaps first (post / movie / tv), skip tags and authors.
        list.sort((a, b) => /movie|film|tv|series|show|post|episode/i.test(b) - /movie|film|tv|series|show|post|episode/i.test(a));
        queue.push(...list.filter((x) => !/tag|author|categor|genre|user/i.test(x)));
      } else locs.push(...list);
    }
    return locs;
  })();
  sitemapCache.set(origin, p);
  return p;
}

// ── Playing a title ─────────────────────────────────────────────────────

const resolveCache = new Map(); // key -> { at, promise }
const RESOLVE_TTL_MS = 10 * 60_000;

/**
 * The site's links for one title.
 * @param {object} recipe a saved recipe
 * @param {{ title, year?, type?: "movie"|"tv", season?, episode? }} want
 * @returns {Promise<{ ok, page?, direct?: {url, headers}[], mirrors?: {label,url}[], error? }>}
 */
export function resolveSite(recipe, want, { net, now = Date.now } = {}) {
  const key = JSON.stringify([recipe.home, want.title, want.year, want.type, want.season, want.episode]);
  const hit = resolveCache.get(key);
  if (hit && now() - hit.at < RESOLVE_TTL_MS) return hit.promise;
  const promise = resolveUncached(recipe, want, net).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  resolveCache.set(key, { at: now(), promise });
  promise.then((r) => !r.ok && resolveCache.delete(key));
  while (resolveCache.size > 60) resolveCache.delete(resolveCache.keys().next().value);
  return promise;
}

export const clearSiteCache = () => {
  resolveCache.clear();
  sitemapCache.clear();
};

async function resolveUncached(recipe, want, net) {
  const home = recipe.home;
  const origin = originOf(home);
  // Search: the learned method; a shorter query when the long one finds nothing.
  let hits = [];
  for (const q of [...new Set([want.title, searchQuery(want.title)])]) {
    if (recipe.search.type === "sitemap") {
      hits = searchSitemap(await sitemapFor(net, origin), q, recipe.pattern, home);
    } else {
      const req = searchRequest(recipe.search, q, { apiKey: recipe.apiKey });
      const p = recipe.search.render
        ? await getPage(net, req.url, { render: true })
        : await net.fetch(req.url, { headers: req.headers, method: req.method, body: req.body, timeoutMs: 10000 }).then(async (r) => (isChallenge(r) ? getPage(net, req.url, { render: true }) : { html: r?.ok ? r.text : "", url: r?.url || req.url }));
      hits = parseSearchResults(p.html, p.url || req.url, { pattern: recipe.pattern, home, links: p.links });
    }
    if (pickBest(hits, want)) break;
  }
  const best = pickBest(hits, want);
  if (!best) return { ok: false, error: `"${want.title}" isn't on ${recipe.site}` };
  let pageUrl = best.url;
  let page = await getPage(net, pageUrl, { render: recipe.render });
  if (want.type === "tv") {
    const links = page.links || extractLinks(page.html, page.url || pageUrl);
    let ep = findEpisode(links, want.season, want.episode);
    if (!ep && !page.render) {
      // Episode lists the page builds with JavaScript.
      const rendered = await getPage(net, pageUrl, { render: true });
      ep = findEpisode(rendered.links || extractLinks(rendered.html, pageUrl), want.season, want.episode);
    }
    if (!ep) return { ok: false, error: `No S${want.season}E${want.episode} on ${recipe.site}` };
    pageUrl = ep;
    page = await getPage(net, pageUrl, { render: recipe.render });
  }
  const html = page.html || "";
  const direct = playableUrls(findMediaUrls(html, page.url || pageUrl)).map((s) => ({ url: s.url, kind: s.kind, page: pageUrl }));
  const mirrors = extractMirrors({ html, mirrors: [], iframes: [] }, page.url || pageUrl, { site: recipe.site });
  return { ok: true, page: pageUrl, title: best.title, year: best.year, direct, mirrors };
}
