// Dev-only: ani.pm resolver (title matcher, episode -> HLS chain, Sub/Dub)
// and its place in the native player's candidate list. Not bundled.
import assert from "node:assert/strict";
import { test } from "node:test";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.window = globalThis;
window.addEventListener = () => {};
globalThis.document = { addEventListener: () => {}, visibilityState: "visible" };
globalThis.fetch = async () => ({ type: "opaque", status: 0 });

const { matchTitle, normalizeTitle, resolveAnipm } = await import("../src/utils/servers/anipm.js");
const anipm = await import("../src/platform/ios/anipm.js");
const { withAnipm } = await import("../src/platform/ios/webview.js");
const { setAutoPick } = await import("../src/platform/ios/autoServer.js");

// Real /api/anime/search items (trimmed) for "attack on titan".
const AOT = [
  { id: 1631, source: "settlar", title: "Attack on Titan", native: "進撃の巨人", year: 2013, type: "TV", episodeCount: 25, anilistId: 16498, malId: 16498 },
  { id: 2916, source: "settlar", title: "Attack on Titan: Junior High", native: "進撃!巨人中学校", year: 2015, type: "TV", episodeCount: 12, anilistId: 21281 },
  { id: 1385, source: "settlar", title: "Attack on Titan Season 2", native: "進撃の巨人 Season2", year: 2017, type: "TV", episodeCount: 12, anilistId: 20958 },
  { id: 9001, source: "settlar", title: "Attack on Titan", native: "進撃の巨人", year: 2015, type: "Movie", episodeCount: 1, anilistId: 20491 },
];

test("matcher: normalizes titles", () => {
  assert.equal(normalizeTitle("  Attack on Titan: Final Season, Part 1 "), "attack on titan final season part 1");
  assert.equal(normalizeTitle("Pokémon"), "pokemon");
});

test("matcher: AniList / MAL id wins outright", () => {
  assert.equal(matchTitle(AOT, { title: "whatever", anilistId: 20958 }).id, 1385);
  assert.equal(matchTitle(AOT, { malId: 16498 }).id, 1631);
});

test("matcher: exact title, then year and type decide", () => {
  assert.equal(matchTitle(AOT, { title: "Attack on Titan", year: 2013, type: "TV" }).id, 1631);
  assert.equal(matchTitle(AOT, { title: "Attack on Titan", year: 2015, type: "Movie" }).id, 9001);
  assert.equal(matchTitle(AOT, { title: "attack on titan season 2" }).id, 1385);
  assert.equal(matchTitle(AOT, { title: "進撃の巨人", year: 2013 }).id, 1631);
});

test("matcher: no match for an unrelated title", () => {
  assert.equal(matchTitle(AOT, { title: "Bluey" }), null);
  assert.equal(matchTitle([], { title: "Attack on Titan" }), null);
});

// Fake ani.pm + settlar API, shaped like the real answers.
function fakeApi({ dub = true, failAt = null } = {}) {
  const calls = [];
  const http = async (url, headers) => {
    calls.push({ url, headers });
    const u = new URL(url);
    if (failAt && u.pathname.includes(failAt)) throw new Error("HTTP 500");
    if (u.pathname === "/api/anime/search") return { items: AOT };
    if (u.pathname.startsWith("/api/anime/playback-bootstrap/")) {
      const lang = u.searchParams.get("lang");
      const eff = lang === "dub" && !dub ? "sub" : lang;
      return { settlarSelection: `sel-${u.pathname.split("/").slice(-2).join("-")}-${eff}`, effectiveLanguage: eff, availability: { sub: true, dub } };
    }
    if (u.pathname === "/api/anime/settlar/session") {
      return { embedUrl: `https://embed.settlar.io/embed/v1?t=${u.searchParams.get("selection")}.${u.searchParams.get("channel")}`, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    }
    if (u.host === "embed.settlar.io" && u.pathname === "/api/embed/session") {
      return { kind: "hls", source: `https://media.settlar.io/v1/object/${u.searchParams.get("t")}`, audioLang: u.searchParams.get("t").endsWith("dub") ? "en" : "ja", subtitles: [] };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { http, calls };
}

test("resolver: AniList id -> bootstrap -> session -> HLS master, with ani.pm headers", async () => {
  const { http, calls } = fakeApi();
  const r = await resolveAnipm(http, { anilistId: 16498, episode: 3, lang: "dub" });
  assert.equal(r.ok, true);
  assert.equal(r.lang, "dub");
  assert.equal(r.audioLang, "en");
  assert.match(r.source, /^https:\/\/media\.settlar\.io\/v1\/object\/sel-anilist-16498-dub\.dub$/);
  assert.match(calls[0].url, /playback-bootstrap\/anilist\/16498\?ep=3&lang=dub$/);
  assert.match(calls[1].url, /provider=anipm&ep=3&channel=dub/);
  assert.equal(calls[0].headers.Referer, "https://ani.pm/");
  assert.match(calls[0].headers["User-Agent"], /iPhone/);
  assert.equal(calls.length, 3, "no search when the AniList id is known");
});

test("resolver: no AniList id -> title search + match", async () => {
  const { http, calls } = fakeApi();
  const r = await resolveAnipm(http, { title: "Attack on Titan", year: 2013, type: "TV", episode: 1, lang: "sub" });
  assert.equal(r.lang, "sub");
  assert.match(calls[0].url, /\/api\/anime\/search\?q=Attack%20on%20Titan$/);
  assert.match(calls[1].url, /playback-bootstrap\/anilist\/16498\?ep=1&lang=sub$/);
});

test("resolver: Dub missing for the episode is reported as Sub (never mislabelled)", async () => {
  const { http } = fakeApi({ dub: false });
  const r = await resolveAnipm(http, { anilistId: 21, episode: 1180, lang: "dub" });
  assert.equal(r.requestedLang, "dub");
  assert.equal(r.lang, "sub");
  assert.deepEqual(r.availability, { sub: true, dub: false });
});

test("resolver: API failures and unknown titles reject", async () => {
  await assert.rejects(resolveAnipm(fakeApi({ failAt: "settlar/session" }).http, { anilistId: 21, episode: 1 }), /HTTP 500/);
  await assert.rejects(resolveAnipm(fakeApi().http, { title: "Bluey" }), /no match/);
  await assert.rejects(resolveAnipm(fakeApi().http, {}), /AniList id or a title/);
});

const ctx = (over = {}) => ({ isAnime: true, type: "tv", anilistId: 16498, episode: 3, dubMode: "dub", ...over });

test("candidates: direct HLS first, ani.pm embed page as the sniffer fallback", async () => {
  anipm.setAnipmHttp(fakeApi().http);
  anipm.clearAnipmCache();
  const list = await anipm.anipmCandidates(ctx());
  assert.deepEqual(list.map((c) => c.id), ["anipm:dub", "anipm:dub"]);
  assert.match(list[0].url, /^https:\/\/media\.settlar\.io\/.*#sb-direct$/);
  assert.match(list[1].url, /^https:\/\/embed\.settlar\.io\/embed\/v1\?t=/);
  assert.equal(list[0].label, "ani.pm · Dub");
});

test("candidates: prefetch on title open is reused by Play (no second lookup)", async () => {
  const api = fakeApi();
  anipm.setAnipmHttp(api.http);
  anipm.clearAnipmCache();
  await anipm.prefetchAnipm(ctx({ episode: 7 }));
  const n = api.calls.length;
  await anipm.anipmCandidates(ctx({ episode: 7 }));
  assert.equal(api.calls.length, n);
});

test("candidates: Dub asked but only Sub on ani.pm -> none (other servers handle Dub)", async () => {
  anipm.setAnipmHttp(fakeApi({ dub: false }).http);
  anipm.clearAnipmCache();
  assert.deepEqual(await anipm.anipmCandidates(ctx()), []);
  assert.equal((await anipm.anipmCandidates(ctx({ dubMode: "sub" }))).length, 2);
});

test("candidates: not anime, no AniList id, or a failed lookup -> none", async () => {
  anipm.setAnipmHttp(fakeApi({ failAt: "playback-bootstrap" }).http);
  anipm.clearAnipmCache();
  assert.deepEqual(await anipm.anipmCandidates(ctx()), []);
  assert.deepEqual(await anipm.anipmCandidates(ctx({ isAnime: false })), []);
  assert.deepEqual(await anipm.anipmCandidates(ctx({ anilistId: null })), []);
});

test("candidates: a lookup slower than the Play wait is skipped, not waited on", async () => {
  anipm.setAnipmHttp(() => new Promise(() => {}));
  anipm.clearAnipmCache();
  const t = Date.now();
  assert.deepEqual(await anipm.anipmCandidates(ctx({ episode: 99 }), { waitMs: 30 }), []);
  assert.ok(Date.now() - t < 500);
});

const c = (id) => ({ id, label: id, url: `https://${id}.test/` });
const ani = [c("anipm:dub"), { ...c("anipm:dub"), url: "https://embed/" }];

test("order: ani.pm leads the anime list (Auto); others stay as fallbacks in order", () => {
  setAutoPick(true);
  const out = withAnipm([c("vidnest:dub"), c("vidrift:dub")], ani);
  assert.deepEqual(out.map((x) => x.id), ["anipm:dub", "anipm:dub", "vidnest:dub", "vidrift:dub"]);
});

test("order: a server picked by hand stays first, ani.pm right after it", () => {
  setAutoPick(false);
  localStorage.setItem("streambert_playerSource", JSON.stringify("vidrift"));
  const out = withAnipm([c("vidrift:dub"), c("vidnest:dub")], ani);
  assert.deepEqual(out.map((x) => x.id), ["vidrift:dub", "anipm:dub", "anipm:dub", "vidnest:dub"]);
  setAutoPick(true);
  localStorage.removeItem("streambert_playerSource");
});

test("order: no ani.pm candidates -> list unchanged", () => {
  const list = [c("a"), c("b")];
  assert.equal(withAnipm(list, []), list);
});
