// Dev-only: smart add end to end on a saved site (7movies.ac): homepage ->
// crawl -> TMDB match (fake TMDB) -> templates for every kind -> lists and
// summary; plus the background tries with a fake native page. Not bundled.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
globalThis.window = globalThis;
window.addEventListener = () => {};
window.dispatchEvent = () => true;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};
globalThis.document = { addEventListener: () => {}, visibilityState: "visible" };

const { matchSample } = await import("../src/utils/customServers/match.js");
const { smartAdd, isSiteLink } = await import("../src/platform/ios/customSmartAdd.js");
const { setDirectHttp, clearDirectCache } = await import("../src/platform/ios/customDirect.js");
const CS = await import("../src/platform/ios/customServers.js");

// Read from the repo root (the runner bundles tests into node_modules/.cache).
const FIX = new URL("scripts/fixtures/custom-sites/7movies/", `file://${process.cwd()}/`);
const fixture = (name) => fs.readFileSync(new URL(name, FIX), "utf8");
const http = async (url) => {
  const u = new URL(url);
  const page = (text) => ({ status: 200, text, url });
  if (u.pathname === "/") return page(fixture("home.html"));
  if (u.pathname === "/robots.txt") return page(fixture("robots.txt"));
  if (u.pathname === "/sitemap.xml") return u.hostname === "7movies.ws" ? page(fixture("sitemap.xml")) : { status: 404, text: "" };
  if (/^\/tv\/\d+$/.test(u.pathname)) return page(fixture("tv-1421.html"));
  if (/^\/movie\/\d+\/watch$/.test(u.pathname)) return page(fixture("movie-27205-watch.html"));
  if (u.pathname.endsWith(".js")) return page(fixture("bundle-excerpt.js"));
  return { status: 404, text: "Not found" };
};
// Fake TMDB: the titles 7movies links on its homepage and show pages.
const TMDB = {
  "/movie/1368337": { id: 1368337, title: "The Odyssey", release_date: "2026-07-17" },
  "/tv/1421": { id: 1421, name: "Modern Family", first_air_date: "2009-09-23" },
  "/tv/5920": { id: 5920, name: "The Mentalist", first_air_date: "2008-09-23" },
  "/tv/2190": { id: 2190, name: "South Park", first_air_date: "1997-08-13" },
};
const tmdb = async (path) => {
  const key = path.split("?")[0];
  if (TMDB[key]) return TMDB[key];
  if (key.startsWith("/search/")) return { results: [] };
  const e = new Error("404 not found");
  e.status = 404;
  throw e;
};
const analyze = (url, prefer) =>
  matchSample(url, { tmdb, anilist: async () => ({}), prefer, timeoutMs: 2000 }).then((r) => (r.ok ? { ...r, templates: { [r.detected.kind]: r.detected.template } } : r));

test("isSiteLink: homepages and list pages vs title links", () => {
  assert.equal(isSiteLink("https://7movies.ac/"), true);
  assert.equal(isSiteLink("https://7movies.ac/movies"), true);
  assert.equal(isSiteLink("https://7movies.ac/movie/27205/watch"), false);
  assert.equal(isSiteLink("https://site.tv/watch/the-dark-knight"), false);
});

test("7movies.ac homepage: movie and TV links learned (no native app)", async () => {
  const steps = [];
  const r = await smartAdd("https://7movies.ac/", { onStep: (id, state, detail) => steps.push([id, state, detail]), deps: { http, analyze, native: false } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.draft.templates.movie, "https://7movies.ac/movie/{tmdb}/watch");
  assert.equal(r.draft.templates.tv, "https://7movies.ac/tv/{tmdb}/watch?season={season}&episode={episode}");
  assert.equal(r.draft.name, "7Movies");
  assert.deepEqual(r.draft.lists, { movies: true, tv: true, anime: false });
  assert.match(r.summary, /TMDB ids/);
  assert.ok(steps.some(([id, state]) => id === "match" && state === "done"));
  // The saved server builds the right link from TMDB data.
  const s = CS.normalizeServer({ ...r.draft, id: "custom-7m" });
  assert.equal(CS.testLinkFor(s, "tv").url.startsWith("https://7movies.ac/tv/"), true);
});

test("a pasted episode link is a strong hint and still works", async () => {
  const r = await smartAdd("https://7movies.ac/tv/1421/watch?season=1&episode=3", { deps: { http, analyze, native: false } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.draft.match.title, "Modern Family");
  assert.equal(r.draft.templates.tv, "https://7movies.ac/tv/{tmdb}/watch?season={season}&episode={episode}");
  assert.equal(r.draft.templates.movie, "https://7movies.ac/movie/{tmdb}/watch");
});

test("with the app: tries pick the lists, Direct when learnable, mismatched titles flagged", async () => {
  const tried = [];
  const tryPage = async (server, url) => {
    tried.push(url);
    const isMovie = url.includes("/movie/");
    const isAnime = url.includes("/tv/37854/");
    if (url.includes("/anime/")) return { page: { ok: false, status: 404 }, stream: { ok: false }, playable: { ok: false }, ads: { filter: true } };
    if (isAnime) return { page: { ok: true, title: "Watch One Piece — 7Movies" }, stream: { ok: false }, playable: { ok: false }, ads: { filter: true } };
    return {
      page: { ok: true, title: isMovie ? "Watch The Odyssey — 7Movies" : "Breaking Bad — 7Movies" },
      stream: { ok: true, url: "https://cdn.x/master.m3u8", headers: { Referer: "https://embed.vidrift.net/" } },
      playable: { ok: true },
      ads: { filter: true, popups: 0, redirects: [] },
      learn: { requests: [], scripts: [] },
    };
  };
  const learn = async (server, kind) => (kind === "movie" ? { def: { url: "https://7movies.ac/api/m/{tmdb}", method: "GET", headers: {}, extract: { type: "path", path: "u" } }, steps: [] } : { def: null, note: "The site signs its API requests.", steps: [] });
  const r = await smartAdd("https://7movies.ac/", { deps: { http, analyze, native: true, tryPage, learn } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.draft.lists, { movies: true, tv: true, anime: false });
  assert.equal(r.draft.mode, "auto");
  assert.ok(r.draft.direct.movie);
  assert.match(r.summary, /^Movies ✓ TV ✓ Anime ✗ · TMDB ids · Direct API found · ads blocked$/);
  assert.ok(tried.some((u) => u.includes("/tv/37854/watch?season=1&episode=1")), "anime tried through the TV link");
  // A page showing another title than TMDB's is flagged.
  const wrong = async (server, url) => ({ ...(await tryPage(server, url)), page: { ok: true, title: "Watch Paddington Bear Adventures Online" } });
  const bad = await smartAdd("https://7movies.ac/", { deps: { http, analyze, native: true, tryPage: wrong, learn } });
  assert.match(bad.ok ? bad.summary : bad.error, /title mismatch|Couldn't find/);
});

test("Direct at play: stream first (#sb-direct, with headers), page after; wrong title skips the site", async () => {
  mem.clear();
  clearDirectCache();
  const s = await CS.saveCustomServer({
    name: "7Movies",
    templates: { movie: "https://7movies.ac/movie/{tmdb}/watch" },
    lists: { movies: true },
    mode: "auto",
    direct: { movie: { url: "https://7movies.ac/api/m/{tmdb}", method: "GET", headers: { Referer: "https://7movies.ac/" }, extract: { type: "path", path: "data.file" }, streamHeaders: { Referer: "https://embed.vidrift.net/" } } },
  });
  setDirectHttp(async ({ url }) => ({ status: 200, url, text: JSON.stringify({ data: { file: "https://cdn.x/27205/master.m3u8", tmdb_id: url.endsWith("/27205") ? 27205 : 1 } }) }));
  const ctx = { type: "movie", tmdbId: 27205, title: "Inception", year: 2010 };
  const list = await CS.customCandidates(ctx);
  assert.deepEqual(list.map((c) => c.url), ["https://cdn.x/27205/master.m3u8#sb-direct", "https://7movies.ac/movie/27205/watch"]);
  assert.deepEqual(list[0].headers, { Referer: "https://embed.vidrift.net/" });
  assert.equal(list[0].id, s.id);
  // Direct streams sit with the other direct sources.
  const order = CS.withCustom([{ id: "cinejoy-direct", url: "https://c/x.m3u8#sb-direct" }, { id: "vidfast", url: "https://v/1" }], list);
  assert.deepEqual(order.map((c) => c.id), ["cinejoy-direct", s.id, s.id, "vidfast"]);
  // The API answers for another title: the site is skipped.
  clearDirectCache();
  setDirectHttp(async ({ url }) => ({ status: 200, url, text: JSON.stringify({ tmdb_id: 155, file: "https://cdn.x/155.m3u8" }) }));
  assert.deepEqual(await CS.customCandidates(ctx), []);
  // Page mode: never calls the API.
  await CS.saveCustomServer({ ...CS.listCustomServers()[0], mode: "page" });
  clearDirectCache();
  setDirectHttp(async () => {
    throw new Error("must not be called");
  });
  assert.deepEqual((await CS.customCandidates(ctx)).map((c) => c.url), ["https://7movies.ac/movie/27205/watch"]);
  setDirectHttp(null);
  await CS.deleteCustomServer(s.id);
});
