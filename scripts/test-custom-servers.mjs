// Dev-only: custom servers. URL-template detection and building, matching a
// pasted link to a title (fake TMDB / AniList), and where custom servers
// land in the play order. Not bundled.
import assert from "node:assert/strict";
import { test } from "node:test";

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
const { matchSample } = await import("../src/utils/customServers/match.js");
const CS = await import("../src/platform/ios/customServers.js");

const inception = { kind: "movie", ids: { tmdb: 27205, imdb: "tt1375666" }, title: "Inception", year: 2010 };
const got = { kind: "tv", ids: { tmdb: 1399 }, title: "Game of Thrones", year: 2011 };
const onePiece = { kind: "anime", ids: { anilist: 21, mal: 21 }, title: "One Piece", year: 1999 };

const detect = (url, m) => T.detectTemplate(url, m);

test("movie by TMDB id", () => {
  const d = detect("https://vidsrc.example/embed/movie/27205", inception);
  assert.equal(d.ok, true);
  assert.equal(d.template, "https://vidsrc.example/embed/movie/{tmdb}");
});

test("movie by IMDb id with query string", () => {
  assert.equal(detect("https://x.to/play?imdb=tt1375666&autoplay=1", inception).template, "https://x.to/play?imdb={imdb}&autoplay=1");
});

test("movie by slug and year", () => {
  assert.equal(detect("https://site.tv/watch/inception-2010", inception).template, "https://site.tv/watch/{slug}-{year}");
});

test("title as text in a query", () => {
  assert.equal(detect("https://site.tv/search?q=Game%20of%20Thrones&s=2&e=5", got).template, "https://site.tv/search?q={title}&s={season}&e={episode}");
});

test("series: positional season and episode after the id", () => {
  const d = detect("https://embed.site/tv/1399/2/5", got);
  assert.equal(d.template, "https://embed.site/tv/{tmdb}/{season}/{episode}");
  assert.deepEqual(d.warnings, []);
});

test("series: s01e05 and 1x05 and labelled forms", () => {
  assert.equal(detect("https://a.io/show/1399/s02e05", got).template, "https://a.io/show/{tmdb}/s{season}e{episode}");
  assert.equal(detect("https://a.io/game-of-thrones-2x05", got).template, "https://a.io/{slug}-{season}x{episode}");
  assert.equal(detect("https://a.io/tv/1399/season-2/episode-5", got).template, "https://a.io/tv/{tmdb}/season-{season}/episode-{episode}");
  assert.equal(detect("https://a.io/tv?id=1399&season=1&episode=1", got).template, "https://a.io/tv?id={tmdb}&season={season}&episode={episode}");
});

test("series id never matched inside a longer number", () => {
  const d = detect("https://a.io/tv/913990/1/1", got);
  assert.equal(d.ok, false);
});

test("anime: AniList id, episode, sub/dub; http LAN address kept", () => {
  const d = detect("http://192.168.1.20:8080/anime/21/ep-12/dub", onePiece);
  assert.equal(d.template, "http://192.168.1.20:8080/anime/{anilist}/ep-{episode}/{lang}");
  assert.equal(detect("https://ani.site/watch/one-piece/1071", onePiece).template, "https://ani.site/watch/{slug}/{episode}");
});

test("a link with nothing of the title fails with a reason", () => {
  const d = detect("https://site.tv/watch/random", inception);
  assert.equal(d.ok, false);
  assert.match(d.error, /title/);
});

test("buildUrl fills every placeholder and encodes values", () => {
  assert.equal(T.buildUrl("https://a/{tmdb}/{season}/{episode}", { tmdb: 1, season: 3, episode: 4 }), "https://a/1/3/4");
  assert.equal(T.buildUrl("https://a/{slug}-{year}?q={title}", { title: "Spider-Man: No Way Home", year: 2021 }), "https://a/spider-man-no-way-home-2021?q=Spider-Man%3A%20No%20Way%20Home");
  assert.equal(T.buildUrl("https://a/{anilist}/{episode}/{lang}", { anilist: 21, episode: 2, lang: "dub" }), "https://a/21/2/dub");
  assert.equal(T.buildUrl("https://a/{imdb}", { tmdb: 1 }), null, "missing value -> null");
});

test("detect then build round-trips the sample", () => {
  const cases = [
    ["https://embed.site/tv/1399/2/5", got, { season: 2, episode: 5 }],
    ["https://site.tv/watch/inception-2010", inception, {}],
    ["http://nas.local:8096/anime/21/ep-12/dub", onePiece, { episode: 12, lang: "dub" }],
  ];
  for (const [url, m, extra] of cases) {
    const d = detect(url, m);
    assert.equal(T.buildUrl(d.template, { ...m.ids, title: m.title, year: m.year, ...extra }), url);
  }
});

test("deriveTemplate: movie <-> tv for the usual embed layout", () => {
  assert.equal(T.deriveTemplate("https://e.site/embed/movie/{tmdb}", "movie", "tv"), "https://e.site/embed/tv/{tmdb}/{season}/{episode}");
  assert.equal(T.deriveTemplate("https://e.site/embed/tv/{tmdb}/{season}/{episode}", "tv", "movie"), "https://e.site/embed/movie/{tmdb}");
  assert.equal(T.deriveTemplate("https://e.site/a/{anilist}", "anime", "tv"), null);
  assert.equal(T.deriveTemplate("https://e.site/watch/{slug}", "movie", "tv"), null, "no kind word: no guess");
});

test("validateTemplate", () => {
  assert.equal(T.validateTemplate("https://a/{tmdb}"), null);
  assert.match(T.validateTemplate("ftp://a/{tmdb}"), /http/);
  assert.match(T.validateTemplate("https://a/{foo}"), /Unknown/);
  assert.match(T.validateTemplate("https://a/{season}"), /tmdb/);
});

test("siteDomain / isOnSite / isLocalAddress", () => {
  assert.equal(T.siteDomain("https://embed.player.site.tv/x"), "site.tv");
  assert.equal(T.siteDomain("https://a.b.co.uk/x"), "b.co.uk");
  assert.equal(T.siteDomain("http://192.168.1.20:8080/x"), "192.168.1.20");
  assert.equal(T.siteDomain("http://nas/x"), "nas");
  assert.ok(T.isOnSite("cdn.site.tv", "site.tv"));
  assert.ok(!T.isOnSite("evilsite.tv", "site.tv"));
  assert.ok(T.isLocalAddress("http://10.0.0.5/a") && T.isLocalAddress("http://nas.local/a") && !T.isLocalAddress("http://example.com/a"));
});

test("analyzeUrl reads kind, ids and a title guess", () => {
  const a = T.analyzeUrl("https://site.tv/movie/27205-inception-2010");
  assert.equal(a.kind, "movie");
  assert.ok(a.numbers.includes(27205));
  assert.equal(a.yearGuess, 2010);
  assert.equal(a.titleGuess, "inception");
  assert.equal(T.analyzeUrl("not a link").ok, false);
});

// ── Matching (fake lookups) ─────────────────────────────────────────────

const fakeTmdb = async (path) => {
  if (path === "/movie/27205") return { id: 27205, title: "Inception", release_date: "2010-07-15" };
  if (path === "/tv/1399") return { id: 1399, name: "Game of Thrones", first_air_date: "2011-04-17" };
  if (path.startsWith("/find/tt1375666")) return { movie_results: [{ id: 27205, title: "Inception", release_date: "2010-07-15" }], tv_results: [] };
  if (path.startsWith("/search/multi")) return { results: [{ media_type: "movie", id: 27205, title: "Inception", release_date: "2010-07-15" }] };
  const e = new Error("not found");
  e.status = 404;
  throw e;
};
const fakeAnilist = async (q, v) => {
  const op = { id: 21, idMal: 21, format: "TV", seasonYear: 1999, title: { romaji: "ONE PIECE", english: "ONE PIECE" } };
  if (v.ids) return { byId: { media: v.ids.includes(21) ? [op] : [] }, byMal: { media: [] } };
  return { Page: { media: [op] } };
};

test("match: TMDB movie id", async () => {
  const r = await matchSample("https://vidsrc.example/embed/movie/27205", { tmdb: fakeTmdb, anilist: fakeAnilist });
  assert.equal(r.ok, true);
  assert.equal(r.match.title, "Inception");
  assert.equal(r.detected.template, "https://vidsrc.example/embed/movie/{tmdb}");
});

test("match: TV link picks the series", async () => {
  const r = await matchSample("https://embed.site/tv/1399/1/1", { tmdb: fakeTmdb, anilist: fakeAnilist });
  assert.equal(r.match.kind, "tv");
  assert.equal(r.detected.template, "https://embed.site/tv/{tmdb}/{season}/{episode}");
});

test("match: IMDb id and slug-only links", async () => {
  assert.equal((await matchSample("https://x.to/e/tt1375666", { tmdb: fakeTmdb })).detected.template, "https://x.to/e/{imdb}");
  assert.equal((await matchSample("https://x.to/watch/inception-2010", { tmdb: fakeTmdb })).detected.template, "https://x.to/watch/{slug}-{year}");
});

test("match: anime link on AniList", async () => {
  const r = await matchSample("https://ani.site/anime/21/episode/3", { tmdb: fakeTmdb, anilist: fakeAnilist });
  assert.equal(r.match.source, "anilist");
  assert.equal(r.detected.template, "https://ani.site/anime/{anilist}/episode/{episode}");
});

test("match: a slow lookup times out instead of hanging", async () => {
  const slow = () => new Promise(() => {});
  const r = await matchSample("https://x.to/movie/27205", { tmdb: slow, timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
});

// ── Store, candidates and play order ─────────────────────────────────────

test("saved servers persist, fit only their lists, and build links", async () => {
  const s = await CS.saveCustomServer({
    name: "My Site",
    sample: "https://embed.site/tv/1399/2/5",
    templates: { tv: "https://embed.site/tv/{tmdb}/{season}/{episode}", movie: "https://embed.site/movie/{tmdb}" },
    lists: { anime: false, movies: false, tv: true },
    match: { ...got, season: 2, episode: 5 },
  });
  assert.equal(CS.listCustomServers().length, 1);
  assert.ok(JSON.parse(mem.get("streambert_customServers")).length === 1, "stored app-wide");
  assert.ok(CS.serverFits(s, { isAnime: false, type: "tv" }));
  assert.ok(!CS.serverFits(s, { isAnime: false, type: "movie" }), "not in Movies");
  assert.ok(!CS.serverFits(s, { isAnime: true, type: "tv" }), "not in Anime");
  const c = await CS.customCandidates({ type: "tv", tmdbId: 1399, tmdbSeason: 3, tmdbEpisode: 7 });
  assert.deepEqual(c.map((x) => x.url), ["https://embed.site/tv/1399/3/7"]);
  assert.equal(c[0].lockHost, "embed.site");
  assert.deepEqual(await CS.customCandidates({ type: "movie", tmdbId: 27205 }), []);
  // The Test rebuilds the pasted link exactly.
  const link = CS.testLinkFor(s, "tv");
  assert.equal(link.url, "https://embed.site/tv/1399/2/5");
  assert.equal(link.expected, link.url);
  await CS.deleteCustomServer(s.id);
  assert.equal(CS.listCustomServers().length, 0);
});

test("anime Dub needs a {lang} template", async () => {
  const s = await CS.saveCustomServer({
    name: "Ani",
    templates: { anime: "https://ani.site/a/{anilist}/{episode}" },
    lists: { anime: true, movies: false, tv: false },
  });
  const ctx = { isAnime: true, type: "tv", tmdbId: 37854, anilistId: 21, anilistEpisode: 9 };
  assert.deepEqual((await CS.customCandidates({ ...ctx, dubMode: "sub" })).map((c) => c.url), ["https://ani.site/a/21/9"]);
  assert.deepEqual(await CS.customCandidates({ ...ctx, dubMode: "dub" }), []);
  await CS.deleteCustomServer(s.id);
});

test("withCustom: after direct streams in Auto, first when picked", () => {
  const list = [
    { id: "movy-direct", url: "https://m/x.m3u8#sb-direct" },
    { id: "vidfast", url: "https://vidfast/1" },
  ];
  const custom = [{ id: "custom-a", url: "https://a/1" }];
  assert.deepEqual(CS.withCustom(list, custom).map((c) => c.id), ["movy-direct", "custom-a", "vidfast"]);
  assert.deepEqual(CS.withCustom(list, custom, "custom-a").map((c) => c.id), ["custom-a", "movy-direct", "vidfast"]);
  assert.deepEqual(CS.withCustom(list, []), list);
});

test("saveProblem explains what is missing", () => {
  assert.match(CS.saveProblem({ lists: {}, templates: {} }), /list/);
  assert.match(CS.saveProblem({ lists: { movies: true }, templates: { tv: "https://a/{tmdb}" } }), /movie link/);
  assert.equal(CS.saveProblem({ lists: { anime: true }, templates: { tv: "https://a/{tmdb}/{season}/{episode}" } }), null);
});
