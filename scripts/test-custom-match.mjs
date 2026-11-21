// Dev-only: custom servers, link parsing + title / id matching. Bugs seen on
// the iPhone (bingebang TV / movie), sites keyed on other ids (IMDb, TVDB,
// AniList, MAL, Kitsu, the site's own number), absolute episode numbering,
// split seasons, page facts, never a dead end.
import assert from "node:assert/strict";
import { test } from "node:test";

const T = await import("../src/utils/customServers/template.js");
const I = await import("../src/utils/customServers/idmap.js");
const E = await import("../src/utils/customServers/episodes.js");
const { matchSample } = await import("../src/utils/customServers/match.js");

/** A fake TMDB: exact paths, then prefixes. */
const fakeTmdb = (routes) => async (path) => {
  if (path in routes) return typeof routes[path] === "function" ? routes[path]() : routes[path];
  for (const [k, v] of Object.entries(routes)) if (k.endsWith("*") && path.startsWith(k.slice(0, -1))) return v;
  const e = new Error("404 not found");
  e.status = 404;
  throw e;
};
const FAMILY_GUY = { id: 1434, name: "Family Guy", first_air_date: "1999-01-31" };
const ENDGAME = { id: 299534, title: "Avengers: Endgame", release_date: "2019-04-24" };

test("bingebang TV: Family Guy S1E1, 1/1 is {season}/{episode}, never Pride / {tmdb}", async () => {
  const calls = [];
  const routes = fakeTmdb({
    "/tv/1": { id: 1, name: "Pride", first_air_date: "2004-04-13" },
    "/movie/1": { id: 1, title: "Pride", release_date: "2004-01-01" },
    "/search/multi*": { results: [{ media_type: "tv", ...FAMILY_GUY }, { media_type: "movie", id: 1, title: "Pride", release_date: "2004-01-01" }] },
    "/tv/1434": { ...FAMILY_GUY, seasons: [{ season_number: 1, episode_count: 7 }, { season_number: 2, episode_count: 21 }] },
  });
  const tmdb = (p) => (calls.push(p), routes(p));
  const r = await matchSample("https://bingebang.sx/tv/play/family-guy-y6bs3k/1/1", { tmdb });
  assert.equal(r.ok, true);
  assert.equal(r.match.ids.tmdb, 1434);
  assert.equal(r.match.title, "Family Guy");
  assert.equal(r.detected.template, "https://bingebang.sx/tv/play/{site}/{season}/{episode}");
  assert.ok(!r.detected.template.includes("{tmdb}"));
  assert.ok(!calls.includes("/tv/1") && !calls.includes("/movie/1"), "small trailing numbers are never ids");
  // The movie guess is the site's real movie route.
  assert.equal(T.deriveTemplate(r.detected.template, "tv", "movie"), "https://bingebang.sx/movie/play/{site}");
  assert.equal(T.buildUrl(r.detected.template, { site: "family-guy-y6bs3k", season: 1, episode: 1 }), "https://bingebang.sx/tv/play/family-guy-y6bs3k/1/1");
});

test("bingebang movie: 5iu40l stripped, 2019 the year filter, Avengers: Endgame 299534", async () => {
  const tmdb = fakeTmdb({
    "/search/movie?query=avengers%20endgame&year=2019": { results: [ENDGAME] },
    "/search/multi*": { results: [{ media_type: "movie", id: 24428, title: "The Avengers", release_date: "2012-04-25" }, { media_type: "movie", ...ENDGAME }] },
  });
  const r = await matchSample("https://bingebang.sx/movie/play/avengers-endgame-2019-5iu40l", { tmdb });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.match.ids.tmdb, 299534);
  assert.equal(r.detected.template, "https://bingebang.sx/movie/play/{site}");
  assert.equal(T.deriveTemplate(r.detected.template, "movie", "tv"), "https://bingebang.sx/tv/play/{site}/{season}/{episode}");
});

test("typo in the slug still matches (fuzzy), extra words dropped", async () => {
  const tmdb = fakeTmdb({ "/search/*": { results: [{ media_type: "movie", ...ENDGAME }] } });
  const r = await matchSample("https://x.example/movie/play/avengers-endgam-2019-5iu40l", { tmdb });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.match.ids.tmdb, 299534);
  const searched = [];
  const tmdb2 = async (p) => {
    searched.push(decodeURIComponent(p));
    return p.includes("query=inception%20") || p.endsWith("query=inception") ? { results: [{ media_type: "movie", id: 27205, title: "Inception", release_date: "2010-07-15" }] } : { results: [] };
  };
  const r2 = await matchSample("https://x.example/movie/inception-full-hdrip-k9k9k9", { tmdb: tmdb2 });
  assert.ok(r2.ok || r2.guesses?.some((g) => g.ids.tmdb === 27205), r2.error);
});

test("never a hard fail: page title, then the closest titles to pick from", async () => {
  const tmdb = fakeTmdb({
    "/search/multi?query=zz%20qq%20xx": { results: [] },
    "/search/multi*": { results: [{ media_type: "movie", ...ENDGAME }] },
    "/search/movie*": { results: [ENDGAME] },
  });
  const html = `<html><head><title>Watch Avengers: Endgame (2019) Online Free - BingeBang</title></head></html>`;
  const r = await matchSample("https://bb.example/movie/play/zz-qq-xx-5iu40l", { tmdb, page: async () => html });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.match.ids.tmdb, 299534);
  assert.equal(r.via, "page title");
  assert.equal(r.detected.template, "https://bb.example/movie/play/{site}");
  const none = await matchSample("https://bb.example/movie/play/zz-qq-xx-5iu40l", { tmdb: fakeTmdb({ "/search/*": { results: [] } }) });
  assert.equal(none.ok, false);
  assert.ok(!/^No title matched/.test(none.error));
});

test("flystream: /movie/{tmdb} and the TV guess /tv/{tmdb}/{season}/{episode}", async () => {
  const tmdb = fakeTmdb({ "/movie/27205": { id: 27205, title: "Inception", release_date: "2010-07-15" } });
  const r = await matchSample("https://flystream.net/movie/27205", { tmdb });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.detected.template, "https://flystream.net/movie/{tmdb}");
  assert.equal(T.deriveTemplate(r.detected.template, "movie", "tv"), "https://flystream.net/tv/{tmdb}/{season}/{episode}");
});

test("m-zone: /details/movie/1300968/rn-6665a44c is TMDB 1300968, the token is no title", async () => {
  const a = T.analyzeUrl("https://m-zone.cc/details/movie/1300968/rn-6665a44c");
  assert.equal(a.titleGuess, "");
  assert.deepEqual(a.idNumbers, [1300968]);
  const tmdb = fakeTmdb({ "/movie/1300968": { id: 1300968, title: "The Hunger Games: Sunrise on the Reaping", release_date: "2026-11-20" } });
  const r = await matchSample("https://m-zone.cc/details/movie/1300968/rn-6665a44c", { tmdb });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.match.ids.tmdb, 1300968);
  assert.equal(r.detected.template, "https://m-zone.cc/details/movie/{tmdb}/rn-6665a44c");
});

test("IMDb id in the link: TMDB /find, template {imdb}", async () => {
  const tmdb = fakeTmdb({ "/find/tt0816692?external_source=imdb_id": { movie_results: [{ id: 157336, title: "Interstellar", release_date: "2014-11-05" }] } });
  const r = await matchSample("https://vs.example/embed/movie/tt0816692", { tmdb });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.match.ids.tmdb, 157336);
  assert.equal(r.detected.template, "https://vs.example/embed/movie/{imdb}");
});

const ONE_PIECE_AL = { id: 21, idMal: 21, format: "TV", episodes: null, seasonYear: 1999, title: { romaji: "ONE PIECE", english: "ONE PIECE", native: "ONE PIECE" } };

test("AniList / MAL labelled ids: only looked up as that kind", async () => {
  const seen = [];
  const anilist = async (q, v) => {
    seen.push(v);
    if (v.id === 21 || v.mal === 21) return { Media: ONE_PIECE_AL };
    return { byId: { media: [] }, byMal: { media: [] } };
  };
  const tmdbCalls = [];
  const tmdb = async (p) => (tmdbCalls.push(p), { results: [] });
  const r = await matchSample("https://an.example/watch/anilist/21/5", { tmdb, anilist });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.match.ids.anilist, 21);
  assert.equal(r.detected.template, "https://an.example/watch/anilist/{anilist}/{episode}");
  assert.ok(!tmdbCalls.some((p) => p === "/tv/21" || p === "/movie/21"), "a labelled AniList id is not a TMDB id");
  const m = await matchSample("https://an.example/anime/watch?mal=21&ep=5", { anilist });
  assert.equal(m.ok, true, m.error);
  assert.equal(m.detected.template, "https://an.example/anime/watch?mal={mal}&ep={episode}");
});

test("Kitsu and TVDB links: converted through ARM / TMDB /find", async () => {
  const arm = async (url) => {
    assert.ok(url.includes("source=kitsu&id=12"));
    return { anilist: 21, myanimelist: 21, kitsu: 12, themoviedb: 37854, thetvdb: 81797 };
  };
  const anilist = async (q, v) => (v.id === 21 ? { Media: ONE_PIECE_AL } : {});
  const r = await matchSample("https://k.example/anime/kitsu/12/7", { anilist, arm });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.detected.template, "https://k.example/anime/kitsu/{kitsu}/{episode}");
  const tmdb = fakeTmdb({
    "/find/81797?external_source=tvdb_id": { tv_results: [{ id: 37854, name: "One Piece", first_air_date: "1999-10-20" }] },
    "/tv/37854": { id: 37854, name: "One Piece", seasons: [{ season_number: 1, episode_count: 61 }, { season_number: 2, episode_count: 16 }] },
  });
  const t = await matchSample("https://t.example/tv/tvdb/81797/2/3", { tmdb });
  assert.equal(t.ok, true, t.error);
  assert.equal(t.match.ids.tmdb, 37854);
  assert.equal(t.detected.template, "https://t.example/tv/tvdb/{tvdb}/{season}/{episode}");
  assert.equal(T.buildUrl(t.detected.template, { tvdb: 81797, season: 2, episode: 3 }), "https://t.example/tv/tvdb/81797/2/3");
});

test("convertIds: TMDB -> IMDb / TVDB, TMDB -> AniList / MAL / Kitsu per season", async () => {
  const tmdb = fakeTmdb({ "/tv/37854/external_ids": { imdb_id: "tt0388629", tvdb_id: 81797 } });
  const arm = async (url) => {
    assert.ok(url.endsWith("/themoviedb?id=37854"));
    return [
      { anilist: 21, myanimelist: 21, kitsu: 12, themoviedb: 37854, "themoviedb-season": 1 },
      { anilist: 999, myanimelist: 998, kitsu: 997, themoviedb: 37854, "themoviedb-season": 2 },
    ];
  };
  const x = await I.convertIds({ tmdb: 37854, kind: "tv", season: 2 }, ["imdb", "tvdb", "anilist", "mal", "kitsu"], { tmdb, arm });
  assert.deepEqual([x.imdb, x.tvdb, x.anilist, x.mal, x.kitsu], ["tt0388629", 81797, 999, 998, 997]);
  // ARM down: Fribb's list.
  const fribb = async () => [{ anilist_id: 21, mal_id: 21, kitsu_id: 12, themoviedb_id: { tv: 37854 }, tvdb_id: 81797, season: { tmdb: 1 } }];
  const y = await I.convertIds({ anilist: 21 }, ["tmdb", "kitsu"], { arm: async () => null, fribb });
  assert.deepEqual([y.tmdb, y.kitsu], [37854, 12]);
});

test("absolute numbering: /watch/one-piece/1071 on TMDB One Piece is {absolute}", async () => {
  const tmdb = fakeTmdb({
    "/search/*": { results: [{ media_type: "tv", id: 37854, name: "One Piece", first_air_date: "1999-10-20" }] },
    "/tv/37854": { id: 37854, seasons: [{ season_number: 0, episode_count: 30 }, { season_number: 1, episode_count: 61 }, { season_number: 2, episode_count: 16 }, { season_number: 22, episode_count: 1000 }] },
  });
  const r = await matchSample("https://op.example/tv/watch/one-piece/1071", { tmdb });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.numbering, "absolute");
  assert.equal(r.detected.template, "https://op.example/tv/watch/{slug}/{absolute}");
  const counts = E.seasonCounts({ seasons: [{ season_number: 0, episode_count: 3 }, { season_number: 1, episode_count: 61 }, { season_number: 2, episode_count: 16 }] });
  assert.equal(E.toAbsolute(counts, 2, 3), 64);
  assert.deepEqual(E.fromAbsolute(counts, 64), { season: 2, episode: 3 });
  assert.equal(E.toAbsolute(counts, 1, 62), null);
});

test("split seasons: TMDB S1E13 is the site's S2E1 (air dates), titles when dates are missing", () => {
  const tmdbEps = Array.from({ length: 24 }, (_, i) => ({ season: 1, episode: i + 1, airDate: new Date(Date.UTC(2020, 0, 5 + 7 * i)).toISOString().slice(0, 10) }));
  const site = tmdbEps.map((e) => ({ season: e.episode <= 12 ? 1 : 2, number: e.episode <= 12 ? e.episode : e.episode - 12, airDate: e.airDate }));
  const offsets = E.learnOffsets(tmdbEps, site);
  assert.deepEqual(E.fromOffsets(offsets, 1, 5), { season: 1, episode: 5 });
  assert.deepEqual(E.fromOffsets(offsets, 1, 13), { season: 2, episode: 1 });
  assert.deepEqual(E.siteNumbers({ season: 1, episode: 20 }, { offsets }).season, 2);
  const byTitle = E.matchEpisode({ name: "The Day the Earth Stood Stupid" }, [{ number: 4, title: "The Day The Earth Stood Stupid!" }, { number: 5, title: "Something Else" }]);
  assert.equal(byTitle.number, 4);
  assert.equal(E.matchEpisode({ name: "Episode 4" }, [{ number: 4, title: "Episode 4" }]), null, "generic names don't count");
});

test("a site's own number, not TMDB's: checked against the page, becomes {site}", async () => {
  const tmdb = fakeTmdb({
    "/movie/98765": { id: 98765, title: "Some Unrelated Film", release_date: "1987-01-01" },
    "/search/multi*": { results: [{ media_type: "movie", id: 27205, title: "Inception", release_date: "2010-07-15" }] },
    "/search/movie*": { results: [{ id: 27205, title: "Inception", release_date: "2010-07-15" }] },
  });
  const html = `<meta property="og:title" content="Inception (2010)"><meta property="og:type" content="video.movie">`;
  const r = await matchSample("https://own.example/movie/watch/98765", { tmdb, page: async () => html });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.match.ids.tmdb, 27205);
  assert.equal(r.detected.template, "https://own.example/movie/watch/{site}");
  assert.equal(r.siteId, "98765");
  // A page that confirms the number keeps it as {tmdb}.
  const ok = await matchSample("https://own.example/movie/watch/98765", { tmdb, page: async () => `<a href="https://www.themoviedb.org/movie/98765">TMDB</a><title>Watch</title>` });
  assert.equal(ok.detected.template, "https://own.example/movie/watch/{tmdb}");
});

test("page facts: JSON-LD episode, sameAs ids, og:type", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"TVEpisode","name":"Death Has a Shadow","episodeNumber":1,
    "partOfSeason":{"@type":"TVSeason","seasonNumber":1},"partOfSeries":{"@type":"TVSeries","name":"Family Guy","startDate":"1999-01-31",
    "sameAs":["https://www.imdb.com/title/tt0182576/"]}}</script><meta property="og:type" content="video.episode">`;
  const f = I.pageFacts(html);
  assert.equal(f.title, "Family Guy");
  assert.equal(f.kind, "tv");
  assert.equal(f.year, 1999);
  assert.deepEqual([f.season, f.episode, f.episodeTitle], [1, 1, "Death Has a Shadow"]);
  assert.equal(f.ids.imdb, "tt0182576");
  assert.deepEqual(I.idHints("https://x/a/anilist/21/1?mal=30&tvdb=5").labelled.map((l) => `${l.kind}:${l.value}`), ["anilist:21", "mal:30", "tvdb:5"]);
});

test("per-site title map cache survives a reload", () => {
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const c = I.createMappingCache(store);
  c.set("bingebang.sx", "tv", 1434, "family-guy-y6bs3k");
  const again = I.createMappingCache(store);
  assert.equal(again.get("bingebang.sx", "tv", 1434), "family-guy-y6bs3k");
  again.forget("bingebang.sx");
  assert.equal(I.createMappingCache(store).get("bingebang.sx", "tv", 1434), null);
});

test("guessed templates: never a duplicate id, movies never carry episodes", () => {
  assert.equal(T.deriveTemplate("https://x.example/tv/{tmdb}/{tmdb}", "tv", "movie"), null);
  assert.equal(T.deriveTemplate("https://x.example/tv/{tmdb}?e={absolute}", "tv", "movie"), "https://x.example/movie/{tmdb}");
  assert.ok(T.validateTemplate("https://x.example/tv/{kitsu}/{kitsu}"));
  assert.equal(T.validateTemplate("https://x.example/a/{tvdb}/{season}/{episode}"), null);
});
