// Site servers on iPhone: the user pastes a site's link; discoverSite() runs
// against the native connector below (hidden WKWebView + collector.js via
// sbSiteRender), each stream is confirmed with the AVPlayer PlayabilityCheck,
// and the result is saved as a "site" server whose streams are resolved at
// play time. Challenges, captchas, logins and DRM are never bypassed; cookies /
// UA are carried over only from a final page that is not a challenge.
import { collectorScript } from "../../utils/customServers/collector";
import { siteDomain } from "../../utils/customServers/template";
import { methodOf } from "../../utils/customServers/method";
import { discoverSite, resolveSite, streamHeaders, normalizeRecipe, isChallenge } from "../../utils/customServers/site";

const bridge = () => window.webkit?.messageHandlers?.sbSiteRender || null;
export const canAddSites = () => !!bridge();
/** Guard: the site adder is unfinished (no Settings UI yet, native bridge not device-tested), so it stays
 * off unless turned on for testing with localStorage "sbSiteAdder" = "1". */
export const siteAdderEnabled = () => {
  try {
    return canAddSites() && globalThis.localStorage?.getItem("sbSiteAdder") === "1";
  } catch {
    return false;
  }
};

/** The `net` discoverSite / resolveSite expect, backed by the native bridge. */
export function nativeNet({ waitMs = 0 } = {}) {
  const b = bridge();
  if (!b) throw new Error("Site adding needs the iPhone app");
  let carry = { cookie: null, userAgent: null };
  return {
    /** The site's per-link wait: site.js never gives a hidden page less. */
    waitMs: Number(waitMs) || 0,
    async fetch(url, { headers = {}, method = "GET", body = null, timeoutMs = 12000, bytes = null } = {}) {
      const h = { ...headers };
      if (carry.userAgent && !h["User-Agent"]) h["User-Agent"] = carry.userAgent;
      return b.postMessage({ op: "fetch", url, method, headers: h, body, timeoutMs, bytes });
    },
    async render(url, { play = false, search = null, timeoutMs = Math.max(15000, Number(waitMs) || 0) } = {}) {
      const r = await b.postMessage({ op: "render", url, script: collectorScript({ play, search }), timeoutMs });
      const top = (r?.frames || []).find((f) => f.top);
      const challenge = !!r?.challenge || (top && isChallenge({ status: 200, text: top.html }));
      // Carry-over only when the final page is a real page.
      if (!challenge && (r?.cookie || r?.userAgent)) carry = { cookie: r.cookie || null, userAgent: r.userAgent || null };
      return { ...r, challenge, cookie: challenge ? null : r?.cookie, userAgent: challenge ? null : r?.userAgent };
    },
    /** AVPlayer check: does the stream actually start? */
    test: (url, headers) => b.postMessage({ op: "test", url, headers }),
    carried: () => ({ ...carry }),
  };
}

/** Discover a site and confirm its stream plays. One saved server per passing source. */
export async function addSiteFromLink(link, { apiKey = null, onStep } = {}) {
  if (!siteAdderEnabled()) return { ok: false, step: "site", error: "Adding whole sites isn't available yet." };
  const net = nativeNet();
  const res = await discoverSite(link, { net, apiKey, onStep });
  if (!res.ok) return res;
  const hdr = streamHeaders(res.stream.stream.page, net.carried());
  const play = await net.test(res.stream.stream.url, hdr);
  if (!play?.ok) return { ok: false, step: "stream", error: `Found a video, but it didn't play: ${play?.detail || "unknown error"}` };
  const servers = [siteServer(res, null)];
  for (const m of res.mirrors || []) servers.push(siteServer(res, m));
  const st = res.stream.stream;
  const method = methodOf({ kind: st.kind, url: st.url, how: st.how, streamPage: st.page, site: res.recipe?.home }).label;
  return { ok: true, servers, detail: play.detail, method };
}

const siteServer = (res, mirror) => ({
  kind: "site",
  name: mirror ? `${res.name} · ${mirror.label}` : res.name,
  recipe: res.recipe,
  mirror: mirror ? mirror.label : null,
  lists: { movies: true, tv: true, anime: false },
});

/** Normalize a saved "site" server (null when broken). */
export function normalizeSiteServer(s, idPrefix) {
  const recipe = normalizeRecipe(s?.recipe);
  if (!recipe) return null;
  return {
    id: typeof s.id === "string" ? s.id : `${idPrefix}${Math.random().toString(36).slice(2, 10)}`,
    kind: "site",
    name: String(s.name || recipe.site || "Site").slice(0, 60),
    site: recipe.site || new URL(recipe.home).hostname,
    recipe,
    mirror: s.mirror || null,
    lists: { anime: !!s.lists?.anime, movies: s.lists?.movies !== false, tv: s.lists?.tv !== false },
    templates: {},
    test: s.test || null,
  };
}

/** Play time: search the site for this title and return the page / stream to play. */
export async function resolveSiteServer(s, ctx) {
  const want = { title: ctx.title || ctx.name, year: ctx.year, type: ctx.type === "tv" ? "tv" : "movie", season: ctx.season, episode: ctx.episode };
  if (!want.title || !siteAdderEnabled()) return null;
  const net = nativeNet({ waitMs: s.linkWaitMs });
  const r = await resolveSite(s.recipe, want, { net });
  if (!r.ok) return null;
  if (s.mirror) {
    const m = (r.mirrors || []).find((x) => x.label === s.mirror);
    return m ? { url: m.url, page: r.page } : null;
  }
  const d = r.direct?.[0];
  return d ? { url: d.url, page: r.page, direct: true, headers: playHeaders(d.url, r.page, net.carried()) } : { url: r.page, page: r.page };
}

/** Headers the native player sends for a stream the page gave: Referer / Origin and the
 * page's User-Agent; the page's cookies only when the stream is on the same site. */
export function playHeaders(streamUrl, page, carried = {}) {
  const h = streamHeaders(page, carried);
  if (h.Cookie && siteDomain(streamUrl) !== siteDomain(page)) delete h.Cookie;
  return h;
}
