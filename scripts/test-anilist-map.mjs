// Dev-only: AniList lookup for TV pages (format filter, accent-free search)
// and TMDB season/episode -> AniList entry + episode (issue #11). Not bundled.
import assert from "node:assert/strict";
import { test } from "node:test";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const api = await import("../src/utils/api.js");
const { anilistSearchTitles, fetchAnilistData, fetchAnilistChain, tmdbAbsoluteEpisode, mapAbsoluteToAnilist, ANILIST_TV_FORMATS } = api;

const S = (...counts) => counts.map((n, i) => ({ season_number: i + 1, episode_count: n }));
const AOT_TMDB = S(25, 12, 22, 28);
const AOT_CHAIN = [
  { id: 16498, episodes: 25 }, { id: 20958, episodes: 12 }, { id: 99147, episodes: 12 },
  { id: 104578, episodes: 10 }, { id: 110277, episodes: 16 }, { id: 131681, episodes: 12 },
];
const NARUTO_TMDB = S(52, 52, 54, 62);
const SHIPPUDEN_TMDB = S(32, 21, 18, 17, 24, 31, 8, 24, 21, 25, 21, 33, 20, 25, 28, 13, 11, 21, 20, 87);
const map = (tmdb, chain, s, e) => mapAbsoluteToAnilist(chain, tmdbAbsoluteEpisode(tmdb, s, e));

test("search titles: accent-free spelling first (Shippūden)", () => {
  assert.deepEqual(anilistSearchTitles("Naruto Shippūden"), ["Naruto Shippuden", "Naruto Shippuuden", "Naruto Shippūden"]);
  assert.deepEqual(anilistSearchTitles("Naruto"), ["Naruto"]);
});

test("TV lookup sends a TV/TV_SHORT/ONA format filter and never keeps a movie", async () => {
  const sent = [];
  globalThis.fetch = async (_u, o) => {
    const v = JSON.parse(o.body).variables;
    sent.push(v);
    // AniList's unfiltered answer for the accented title is a movie.
    const media = v.formats ? { id: 1735, format: "TV", episodes: 500, title: { romaji: "NARUTO: Shippuuden" } } : { id: 10589, format: "MOVIE", episodes: 1 };
    return { json: async () => ({ data: { Page: { media: [media] } } }) };
  };
  const d = await fetchAnilistData("Naruto Shippūden", "ANIME", 31910, { kind: "tv", formats: ANILIST_TV_FORMATS });
  assert.equal(d.id, 1735);
  assert.deepEqual(sent[0].formats, ["TV", "TV_SHORT", "ONA"]);
  assert.equal(sent[0].search, "Naruto Shippuden");
});

test("a cached movie for a TV page is dropped and looked up again", async () => {
  mem.clear();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { json: async () => ({ data: { Page: { media: [calls === 1 ? { id: 10589, format: "MOVIE" } : { id: 1735, format: "TV" }] } } }) };
  };
  // First answer is a movie without a filter (desktop "any" kind)...
  await fetchAnilistData("X", "ANIME", 1, { kind: "tv" });
  // ...the TV page with its filter refuses the cached movie.
  const d = await fetchAnilistData("X", "ANIME", 1, { kind: "tv", formats: ANILIST_TV_FORMATS });
  assert.equal(d.id, 1735);
});

test("TV and movie pages with the same TMDB id don't share a cache entry", async () => {
  mem.clear();
  globalThis.fetch = async (_u, o) => {
    const f = JSON.parse(o.body).variables.formats;
    return { json: async () => ({ data: { Page: { media: [f?.includes("MOVIE") ? { id: 2, format: "MOVIE" } : { id: 1, format: "TV" }] } } }) };
  };
  assert.equal((await fetchAnilistData("Same", "ANIME", 77, { kind: "tv", formats: ANILIST_TV_FORMATS })).id, 1);
  assert.equal((await fetchAnilistData("Same", "ANIME", 77, { kind: "movie", formats: api.ANILIST_MOVIE_FORMATS })).id, 2);
});

test("Hunter x Hunter: the TMDB year picks 2011 over the 1999 series", async () => {
  mem.clear();
  // AniList's real search order for "Hunter x Hunter" (TV formats).
  const page = [
    { id: 136, format: "TV", episodes: 62, seasonYear: 1999, startDate: { year: 1999 } },
    { id: 11061, format: "TV", episodes: 148, seasonYear: 2011, startDate: { year: 2011 } },
  ];
  globalThis.fetch = async () => ({ json: async () => ({ data: { Page: { media: page } } }) });
  const opts = { kind: "tv", formats: ANILIST_TV_FORMATS };
  assert.equal((await fetchAnilistData("Hunter x Hunter", "ANIME", 46298, { ...opts, year: "2011" })).id, 11061);
  assert.equal((await fetchAnilistData("Hunter x Hunter", "ANIME", 45952, { ...opts, year: "1999" })).id, 136);
  // A cached 1999 entry for the 2011 page is thrown away.
  mem.clear();
  await fetchAnilistData("Hunter x Hunter", "ANIME", 46298, opts); // no year -> search order (1999)
  assert.equal((await fetchAnilistData("Hunter x Hunter", "ANIME", 46298, { ...opts, year: "2011" })).id, 11061);
  // No candidate near the year: keep AniList's order.
  assert.equal(api.pickAnilistMatch(page, { year: 2020 }).id, 136);
});

test("AoT: season 3 maps to Season 3 / Season 3 Part 2, not Season 1", () => {
  assert.deepEqual(map(AOT_TMDB, AOT_CHAIN, 3, 1), { anilistId: 99147, episode: 1 });
  assert.deepEqual(map(AOT_TMDB, AOT_CHAIN, 3, 12), { anilistId: 99147, episode: 12 });
  assert.deepEqual(map(AOT_TMDB, AOT_CHAIN, 3, 13), { anilistId: 104578, episode: 1 });
  assert.deepEqual(map(AOT_TMDB, AOT_CHAIN, 3, 22), { anilistId: 104578, episode: 10 });
  assert.deepEqual(map(AOT_TMDB, AOT_CHAIN, 2, 1), { anilistId: 20958, episode: 1 });
  assert.deepEqual(map(AOT_TMDB, AOT_CHAIN, 4, 17), { anilistId: 131681, episode: 1 });
});

test("Naruto and Shippuden: absolute episode inside the single AniList entry", () => {
  const naruto = [{ id: 20, episodes: 220 }, { id: 1735, episodes: 500 }];
  assert.deepEqual(map(NARUTO_TMDB, naruto, 2, 1), { anilistId: 20, episode: 53 });
  assert.deepEqual(map(NARUTO_TMDB, naruto, 4, 62), { anilistId: 20, episode: 220 });
  const ship = [{ id: 1735, episodes: 500 }, { id: 97938, episodes: 293 }];
  assert.deepEqual(map(SHIPPUDEN_TMDB, ship, 1, 1), { anilistId: 1735, episode: 1 });
  assert.deepEqual(map(SHIPPUDEN_TMDB, ship, 2, 1), { anilistId: 1735, episode: 33 });
  assert.deepEqual(map(SHIPPUDEN_TMDB, ship, 20, 87), { anilistId: 1735, episode: 500 });
});

test("past the chain -> null (no wrong episode); unknown count takes the rest", () => {
  assert.equal(mapAbsoluteToAnilist([{ id: 1, episodes: 10 }], 11), null);
  assert.deepEqual(mapAbsoluteToAnilist([{ id: 21, episodes: null }], 1156), { anilistId: 21, episode: 1156 });
  assert.equal(tmdbAbsoluteEpisode(S(10, 10), 2, 0), null);
});

test("chain walks TV sequels only (skips movies/specials), one request per hop", async () => {
  const rel = {
    20: [{ relationType: "SEQUEL", node: { id: 9, type: "ANIME", format: "MOVIE", episodes: 1 } }, { relationType: "SEQUEL", node: { id: 1735, type: "ANIME", format: "TV", episodes: 500 } }],
    1735: [{ relationType: "SEQUEL", node: { id: 21579, type: "ANIME", format: "SPECIAL", episodes: 1 } }],
  };
  let n = 0;
  const fetchImpl = async (_u, o) => {
    n++;
    const id = JSON.parse(o.body).variables.id;
    return { json: async () => ({ data: { Media: { id, relations: { edges: rel[id] || [] } } } }) };
  };
  const chain = await fetchAnilistChain({ id: 20, episodes: 220, relations: { edges: rel[20] } }, { fetchImpl });
  assert.deepEqual(chain, [{ id: 20, episodes: 220 }, { id: 1735, episodes: 500 }]);
  assert.equal(n, 1);
});
