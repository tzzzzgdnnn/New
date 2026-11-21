// Dev-only: the Custom Servers site adder on ANIME sites (offline). Anime links
// are learned as anime ({anilist} / {mal} / {slug}, {episode}, {lang}), saved
// into the Anime list only (anime Sources, like the built-in anime servers),
// and built at play time for any anime from its AniList id. Not bundled.
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
const { smartAdd } = await import("../src/platform/ios/customSmartAdd.js");
const CS = await import("../src/platform/ios/customServers.js");
const { sourcesForContent } = await import("../src/utils/api.js");

const OP = { id: 21, idMal: 21, format: "TV", episodes: null, seasonYear: 1999, title: { romaji: "ONE PIECE", english: "One Piece", native: null } };
const anilist = async (q, v = {}) => {
  if (/Media\(id/.test(q)) return { Media: v.id == 21 || (v.id == null && v.mal == 21) ? OP : null };
  if (/byId/.test(q)) return { byId: { media: (v.ids || []).includes(21) ? [OP] : [] }, byMal: { media: (v.mal || []).includes(21) ? [OP] : [] } };
  return { Page: { media: /one piece/i.test(v.q || "") ? [OP] : [] } };
};
const tmdb = async (p) => {
  const q = decodeURIComponent((/query=([^&]*)/.exec(p) || [])[1] || "").toLowerCase();
  if (p.startsWith("/search/") && q.startsWith("one piece")) return { results: [{ media_type: "tv", id: 37854, name: "One Piece", first_air_date: "1999-10-20" }] };
  if (p.startsWith("/search/") && q.startsWith("breaking bad")) return { results: [{ media_type: "tv", id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20" }] };
  if (p === "/tv/1396") return { id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20", seasons: [{ season_number: 1, episode_count: 7 }] };
  const e = new Error("404 not found");
  e.status = 404;
  throw e;
};
const match = (u) => matchSample(u, { tmdb, anilist, timeoutMs: 2000 });

test("anime links: AniList / MAL ids, slug + episode, Sub/Dub become anime templates", async () => {
  const cases = {
    "https://a.example/ani/21/1": "https://a.example/ani/{anilist}/{episode}",
    "https://b.example/anime/21/7/dub": "https://b.example/anime/{anilist}/{episode}/{lang}",
    "https://f.example/embed/mal/21/7": "https://f.example/embed/mal/{mal}/{episode}",
    "https://d.example/anime/one-piece/episode/7?audio=dub": "https://d.example/anime/{slug}/episode/{episode}?audio={lang}",
    "https://c.example/watch/one-piece-episode-7": "https://c.example/watch/{slug}-episode-{episode}",
    "https://e.example/watch/one-piece-sub/ep-7": "https://e.example/watch/{slug}-{lang}/ep-{episode}",
  };
  for (const [u, want] of Object.entries(cases)) {
    const r = await match(u);
    assert.equal(r.ok, true, `${u}: ${r.error}`);
    assert.equal(r.detected.kind, "anime", u);
    assert.equal(r.detected.template, want, u);
    assert.ok(r.match.ids.anilist === 21 || r.match.ids.mal === 21, u);
  }
});

test("a show's season-less episode link with no AniList title stays TV", async () => {
  const r = await match("https://g.example/watch/breaking-bad-episode-3");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.detected.kind, "tv");
});

test("ani-pm corpus fixture: /ani/{anilist}/{episode} learned, Anime list only", async () => {
  const base = `${process.cwd()}/scripts/site-corpus/fixtures/ani-pm/`;
  const routes = JSON.parse(fs.readFileSync(base + "routes.json", "utf8"));
  const http = async (arg) => {
    const url = typeof arg === "string" ? arg : arg.url;
    const u = new URL(url);
    if (u.hostname !== "ani.pm") return { status: 0, text: "", url };
    const r = routes[u.pathname + u.search] || routes[u.pathname];
    return r ? { status: r.status, text: fs.readFileSync(base + r.file, "utf8"), url } : { status: 404, text: "", url };
  };
  const analyze = (url, prefer) => matchSample(url, { tmdb, anilist, prefer, timeoutMs: 2000 }).then((r) => (r.ok ? { ...r, templates: { [r.detected.kind]: r.detected.template } } : r));
  const r = await smartAdd("https://ani.pm/ani/21/1", { deps: { http, siteHttp: http, analyze, native: false }, budgetMs: 15000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.draft.templates.anime, "https://ani.pm/ani/{anilist}/{episode}");
  assert.deepEqual(r.draft.lists, { anime: true, movies: false, tv: false }, "anime sites join the Anime list, not Movies / TV");
});

test("saved anime server: Anime Sources only; play time builds any anime from its AniList id, absolute episodes, Sub + Dub + each site server", async () => {
  const s = await CS.saveCustomServer({
    name: "AniSite",
    sample: "https://ani.site/anime/21/1/sub",
    templates: { anime: "https://ani.site/anime/{anilist}/{episode}/{lang}" },
    lists: { anime: true, movies: false, tv: false },
    match: { kind: "anime", ids: { anilist: 21, mal: 21 }, title: "One Piece", year: 1999, episode: 1 },
    siteServers: [{ label: "HD-1", works: true }, { label: "HD-2", works: true }],
  });
  assert.ok(CS.serverFits(s, { isAnime: true, type: "tv" }));
  assert.ok(!CS.serverFits(s, { isAnime: false, type: "tv" }) && !CS.serverFits(s, { isAnime: false, type: "movie" }), "never in the movie / TV list");
  // The Sources split: custom entries carry customFits; anime-only ones list under anime only.
  const src = CS.customPlayerSources().map((x) => ({ ...x, customFits: { anime: true, movie: false, tv: false } }));
  const builtIns = [{ id: "anipm", tag: "anime" }, { id: "vidfast" }];
  assert.ok(sourcesForContent(true, [...builtIns, ...src]).some((x) => x.id === s.id), "with the built-in anime servers");
  assert.ok(!sourcesForContent(false, [...builtIns, ...src]).some((x) => x.custom), "not with movie / TV servers");
  // A different anime (Frieren, AniList 154587), its own episode numbering (one AniList entry per season).
  const ctx = { isAnime: true, type: "tv", tmdbId: 209867, anilistId: 154587, tmdbSeason: 1, tmdbEpisode: 5, anilistEpisode: 5, title: "Frieren: Beyond Journey's End" };
  const sub = await CS.customCandidates({ ...ctx, dubMode: "sub" });
  assert.deepEqual(sub.map((c) => c.url), ["https://ani.site/anime/154587/5/sub", "https://ani.site/anime/154587/5/sub", "https://ani.site/anime/154587/5/sub"]);
  assert.deepEqual(sub.map((c) => c.label), ["AniSite · Sub", "AniSite · HD-1", "AniSite · HD-2"]);
  const dub = await CS.customCandidates({ ...ctx, dubMode: "dub" });
  assert.equal(dub[0].url, "https://ani.site/anime/154587/5/dub");
  assert.equal(dub.length, 3, "Dub has every server too");
  assert.ok(dub.every((c) => /:dub$/.test(c.id)) && sub.every((c) => /:sub$/.test(c.id)), "Sub and Dub are separate Sources entries");
  // One Piece S2E3 on TMDB is AniList episode 64: the anime link uses the AniList number.
  const op = await CS.customCandidates({ isAnime: true, type: "tv", tmdbId: 37854, anilistId: 21, tmdbSeason: 2, tmdbEpisode: 3, anilistEpisode: 64, dubMode: "sub" });
  assert.equal(op[0].url, "https://ani.site/anime/21/64/sub");
  await CS.deleteCustomServer(s.id);
});
