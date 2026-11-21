// Dev-only: custom servers, site discovery. Player-route discovery from SPA
// bundles (m-zone.cc), slug links with per-title site ids (bingebang.sx),
// the site-search lookup recipe, the page nudge (and its Swift copy), site
// servers as their own menu entries, verified links switching lists on.
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

const T = await import("../src/utils/customServers/template.js");
const D = await import("../src/utils/customServers/discover.js");
const L = await import("../src/utils/customServers/lookup.js");
const { matchSample } = await import("../src/utils/customServers/match.js");
const { NUDGE_JS } = await import("../src/utils/customServers/nudge.js");
const { withNudge } = await import("./gen-nudge-swift.mjs");
const CS = await import("../src/platform/ios/customServers.js");
const { setDirectHttp } = await import("../src/platform/ios/customDirect.js");

// m-zone.cc's main bundle, the parts that matter (router + rotating watch prefix).
const MZ_BUNDLE = `const R=[{path:"/games/play/:gameId"},{path:"/:watchPrefix/:type/:id"},{path:"/details/:type/:id/:slug"},
{path:"/embed/:type/:id",element:EP},{path:"/embed/:type/:id/:season/:episode",element:EP}];fetch("/api/player/v2/challenge")`;

test("m-zone: details link -> the site's /embed/ player route (slug dropped)", () => {
  const d = D.discoverCandidates({
    origin: "https://m-zone.cc",
    pasted: { movie: "https://m-zone.cc/details/movie/{tmdb}/rn-6665a44c", tv: "https://m-zone.cc/details/tv/{tmdb}/rn-6665a44c/{season}/{episode}" },
    scriptTexts: [MZ_BUNDLE],
  });
  assert.equal(d.movie[0].tpl, "https://m-zone.cc/embed/movie/{tmdb}");
  assert.equal(d.tv[0].tpl, "https://m-zone.cc/embed/tv/{tmdb}/{season}/{episode}");
  assert.ok(!d.movie.some((c) => /\/details\//.test(c.tpl)), "info routes are never candidates");
  assert.ok(D.looksLikeInfoPage("https://m-zone.cc/details/movie/{tmdb}/rn-6665a44c"));
  assert.ok(!D.looksLikeInfoPage("https://m-zone.cc/embed/movie/{tmdb}"));
});

test("router routes: :type/:id/:season/:episode and literal kinds", () => {
  assert.deepEqual(D.paramRoutes(MZ_BUNDLE).sort(), ["/:watchPrefix/:type/:id", "/details/:type/:id/:slug", "/embed/:type/:id", "/embed/:type/:id/:season/:episode", "/games/play/:gameId"].sort());
  assert.equal(D.routeToTemplates("/watch/movie/:tmdbId", "https://x.to").movie, "https://x.to/watch/movie/{tmdb}");
  assert.equal(D.routeToTemplates("/tv/:id/:season/:episode", "https://x.to").tv, "https://x.to/tv/{tmdb}/{season}/{episode}");
  assert.equal(D.routeToTemplates("/games/play/:gameId", "https://x.to").movie, undefined);
});

test("no routes at all: the usual embed routes, movie and TV", () => {
  const d = D.discoverCandidates({ origin: "https://e.example" });
  assert.equal(d.movie[0].tpl, "https://e.example/embed/movie/{tmdb}");
  assert.ok(d.tv.some((c) => c.tpl === "https://e.example/embed/tv/{tmdb}/{season}/{episode}"));
  assert.ok(d.movie.some((c) => c.tpl.includes("{imdb}")));
});

test("bingebang TV: slug + site id + 1/1 is Family Guy S1E1, never TMDB tv/1 (Pride)", async () => {
  const a = T.analyzeUrl("https://bingebang.sx/tv/play/family-guy-y6bs3k/1/1");
  assert.equal(a.titleGuess, "family guy");
  assert.equal(a.siteId, "y6bs3k");
  assert.deepEqual(a.idNumbers, []);
  const calls = [];
  const tmdb = async (path) => {
    calls.push(path);
    if (path === "/tv/1") return { id: 1, name: "Pride", first_air_date: "2004-04-13" };
    if (path.startsWith("/search/multi")) return { results: [{ media_type: "tv", id: 1434, name: "Family Guy", first_air_date: "1999-01-31" }] };
    return { results: [] };
  };
  const r = await matchSample("https://bingebang.sx/tv/play/family-guy-y6bs3k/1/1", { tmdb });
  assert.equal(r.ok, true);
  assert.equal(r.match.ids.tmdb, 1434);
  assert.equal(r.detected.template, "https://bingebang.sx/tv/play/{site}/{season}/{episode}");
  assert.ok(!calls.includes("/tv/1"), "season / episode numbers are not looked up as ids");
});

test("bingebang movie: site id stripped, year kept as the filter (Avengers: Endgame 2019)", async () => {
  const a = T.analyzeUrl("https://bingebang.sx/movie/play/avengers-endgame-2019-5iu40l");
  assert.equal(a.titleGuess, "avengers endgame");
  assert.equal(a.yearGuess, 2019);
  assert.equal(a.siteId, "5iu40l");
  const tmdb = async (path) => {
    if (path.startsWith("/search/movie") && path.includes("year=2019")) return { results: [{ id: 299534, title: "Avengers: Endgame", release_date: "2019-04-24" }] };
    if (path.startsWith("/search/multi")) return { results: [{ media_type: "movie", id: 299534, title: "Avengers: Endgame", release_date: "2019-04-24" }] };
    return { results: [] };
  };
  const r = await matchSample("https://bingebang.sx/movie/play/avengers-endgame-2019-5iu40l", { tmdb });
  assert.equal(r.ok, true);
  assert.equal(r.match.ids.tmdb, 299534);
  assert.equal(r.detected.template, "https://bingebang.sx/movie/play/{site}");
});

test("no match: never a dead end, the closest titles come back", async () => {
  const tmdb = async (path) => (path.startsWith("/search") ? { results: [{ media_type: "movie", id: 9, title: "Avengers Grimm", release_date: "2015-01-01" }] } : { results: [] });
  const r = await matchSample("https://x.example/movie/play/avengers-grim-q1w2e3", { tmdb });
  assert.equal(r.ok, false);
  assert.ok(!/^No title matched/.test(r.error));
});

test("a title id twice is never a template", () => {
  assert.ok(T.hasDuplicateId("https://bingebang.sx/tv/play/family-guy-y6bs3k/{tmdb}/{tmdb}"));
  assert.ok(T.validateTemplate("https://x.example/tv/{tmdb}/{tmdb}"));
  assert.equal(T.validateTemplate("https://x.example/tv/{tmdb}/{season}/{episode}"), null);
  const d = T.detectTemplate("https://x.example/tv/play/1/1", { kind: "tv", ids: { tmdb: 1 }, title: "Pride", year: 2004 });
  assert.ok(!d.template || !T.hasDuplicateId(d.template));
});

test("site search: learned from the pasted title, then finds any title's {site}", async () => {
  const answers = {
    "family guy": { results: [{ name: "Family Guy", year: 1999, url: "/tv/watch/family-guy-y6bs3k", play_url: "/tv/play/family-guy-y6bs3k" }] },
    inception: { results: [{ title: "Inception", year: 2010, url: "/movie/watch/inception-2010-ab12cd" }, { title: "Inception: The Cobol Job", url: "/movie/watch/inception-the-cobol-job-2010-zz9zz9" }] },
    "breaking bad": { results: [{ name: "Breaking Bad", url: "\/tv\/watch\/breaking-bad-k3j2h1" }] },
  };
  const http = async (url) => {
    const u = new URL(url);
    if (u.pathname !== "/api/search/tv" && u.pathname !== "/api/search/movie") return { status: 404, text: "{}" };
    const q = u.searchParams.get("query").toLowerCase();
    return { status: 200, text: JSON.stringify(answers[q] || { results: [] }) };
  };
  const lk = await L.learnLookup({ origin: "https://bingebang.sx", kind: "tv", title: "Family Guy", siteSegment: "family-guy-y6bs3k", http });
  assert.equal(lk.url, "https://bingebang.sx/api/search/{type}?query={query}&page=1");
  assert.equal(await L.resolveSite(lk, { title: "Breaking Bad", year: 2008, kind: "tv", http }), "breaking-bad-k3j2h1");
  assert.equal(await L.resolveSite({ ...lk, type: "movie" }, { title: "Inception", year: 2010, kind: "movie", http }), "inception-2010-ab12cd");
  assert.equal(await L.resolveSite(lk, { title: "Nope", kind: "tv", http }), null);
});

test("nudge: the Swift copy matches nudge.js", () => {
  const swift = fs.readFileSync("ios/App/App/StreambertPlayer.swift", "utf8");
  assert.equal(withNudge(swift, NUDGE_JS), swift, "run: node scripts/gen-nudge-swift.mjs");
  assert.ok(NUDGE_JS.includes("__sbTapOnly") && NUDGE_JS.includes("'servers'") && NUDGE_JS.includes("'wall'"));
  assert.ok(!/turnstile[^;]*\.click\(/i.test(NUDGE_JS), "human checks are never pressed");
});

test("saved recipe: every title, the site's servers as their own entries, {site} looked up", async () => {
  mem.clear();
  setDirectHttp(async ({ url }) => {
    const q = new URL(url).searchParams.get("query");
    if (q === "The Simpsons") return { status: 200, text: JSON.stringify({ results: [{ name: "The Simpsons", url: "/tv/watch/the-simpsons-7hh2k1" }] }) };
    return { status: 404, text: "" };
  });
  const s = await CS.saveCustomServer({
    name: "BingeBang",
    templates: { tv: "https://bingebang.sx/tv/play/{site}/{season}/{episode}" },
    lists: { tv: true },
    lookup: { tv: { url: "https://bingebang.sx/api/search/{type}?query={query}&page=1", type: "tv" } },
    tap: "Start playback",
    siteServers: [{ label: "Server 1", works: true }, { label: "Server 2", works: false }, { label: "Vidplay", works: true }],
  });
  const c = await CS.customCandidates({ type: "tv", tmdbId: 456, title: "The Simpsons", year: 1989, tmdbSeason: 2, tmdbEpisode: 3 });
  assert.deepEqual(c.map((x) => x.url), Array(3).fill("https://bingebang.sx/tv/play/the-simpsons-7hh2k1/2/3"));
  assert.deepEqual(c.map((x) => x.label), ["BingeBang", "BingeBang · Server 1", "BingeBang · Vidplay"]);
  assert.equal(c[0].tap, "Start playback");
  assert.deepEqual([c[1].tap, c[1].tapOnly], ["Server 1", true]);
  // Player menu + downloads use the same entries.
  const src = CS.customPlayerSources().map((x) => x.id);
  assert.deepEqual(src, [s.id, `${s.id}~server-1`, `${s.id}~vidplay`]);
  assert.ok(CS.sourceFitsTitle({ custom: true, id: `${s.id}~vidplay` }, { isAnime: false, type: "tv" }));
  // Picked by hand: that server first, the site's others next (failover).
  const order = CS.withCustom([{ id: "vidsrc", url: "https://v" }], c, `${s.id}~vidplay`).map((x) => x.id);
  assert.deepEqual(order.slice(0, 3), [`${s.id}~vidplay`, s.id, `${s.id}~server-1`]);
  setDirectHttp(null);
});

test("a link that passed its Test is Verified and its list turns on", async () => {
  mem.clear();
  const s = await CS.saveCustomServer({
    name: "Flystream",
    templates: { movie: "https://flystream.net/movie/{tmdb}", tv: "https://flystream.net/tv/{tmdb}/{season}/{episode}" },
    guessed: { tv: true },
    lists: { movies: true, tv: false },
  });
  await CS.recordRecipe(s.id, { verified: ["movie", "tv"], siteServers: [{ label: "Server 2", works: true }] });
  const after = CS.listCustomServers()[0];
  assert.equal(after.lists.tv, true);
  assert.equal(after.guessed.tv, undefined);
  assert.deepEqual(CS.workingSiteServers(after).map((x) => x.label), ["Server 2"]);
});

test("extra Test titles: 3 movies, TV episodes and an anime one through the TV link", async () => {
  const srv = { templates: { movie: "https://f.example/movie/{tmdb}", tv: "https://f.example/tv/{tmdb}/{season}/{episode}" }, match: null };
  const m = await CS.extraTitlesFor(srv, "movie");
  assert.deepEqual(m.map((x) => x.title), ["Fight Club", "The Matrix"]);
  const t = await CS.extraTitlesFor(srv, "tv");
  assert.deepEqual(t.map((x) => x.title), ["Stranger Things", "One Piece"]);
  assert.equal(t[1].url, "https://f.example/tv/37854/1/1");
});
