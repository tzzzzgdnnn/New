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

// ── Site adder: decoders ─────────────────────────────────────────────────

const D = await import("../src/utils/customServers/decode.js");
const S = await import("../src/utils/customServers/site.js");

/** Dean Edwards-style packer (what sites ship), for building fixtures. */
function pack(src, radix = 62) {
  const words = [...new Set(src.match(/\b\w+\b/g))];
  const enc = (c) => (c < radix ? "" : enc(Math.floor(c / radix))) + ((c = c % radix) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
  const index = new Map(words.map((w, i) => [w, enc(i)]));
  const p = src.replace(/\b\w+\b/g, (w) => index.get(w)).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('${p}',${radix},${words.length},'${words.join("|")}'.split('|'),0,{}))`;
}

test("decode: packer unpacks exactly like running it", () => {
  const src = `jwplayer("vplayer").setup({sources:[{file:"https://cdn.example.org/hls/abc/master.m3u8",label:"720p"}],image:"https://cdn.example.org/p.jpg"});`;
  const packed = pack(src);
  assert.ok(D.isPacked(packed));
  // The real packer function, run, gives the same text.
  let ran = null;
  new Function("eval", packed)((x) => (ran = x));
  assert.equal(ran, src);
  assert.equal(D.unpackAll(packed)[0], src);
  const urls = D.findMediaUrls(`<script>${packed}</script>`, "https://site.example/watch/x");
  assert.equal(urls[0].url, "https://cdn.example.org/hls/abc/master.m3u8");
  assert.equal(urls[0].player, "jwplayer");
  assert.equal(urls[0].label, "720p");
});

test("decode: radix 36 / 10 packers and nested packers inside base64", () => {
  for (const radix of [10, 36]) {
    const src = `var player=new Clappr.Player({source:"https://v.example.net/movie/out.mp4",parentId:"#p"});`;
    assert.equal(D.unpackAll(pack(src, radix))[0], src);
  }
  const inner = pack(`var s="https://deep.example.com/x/index.m3u8";`);
  const outer = pack(`eval(atob("${Buffer.from(inner).toString("base64")}"))`);
  const urls = D.findMediaUrls(outer, "https://a.example/");
  assert.deepEqual(urls.map((u) => u.url), ["https://deep.example.com/x/index.m3u8"]);
});

test("decode: base64, rot13, hex, \\u, char codes, reversed, JSON.parse, %-encoding", () => {
  const u = "https://cdn.example.com/v/master.m3u8";
  const cases = {
    base64: `var src = atob("${Buffer.from(u).toString("base64")}");`,
    bareBase64: `player.load("${Buffer.from(u).toString("base64")}")`,
    rot13: `var s = "${D.rot13(u)}";`,
    hex: `var s = "${[...u].map((c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")}";`,
    unicode: `var s = "${[...u].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}";`,
    charCodes: `var s = String.fromCharCode(${[...u].map((c) => c.charCodeAt(0)).join(",")});`,
    reversed: `var s = "${[...u].reverse().join("")}".split("").reverse().join("");`,
    reversedBare: `var s = "${[...u].reverse().join("")}";`,
    jsonParse: `var cfg = JSON.parse('{"file":"${u.replace(/\//g, "\\\\/")}"}');`,
    uriEncoded: `var s = decodeURIComponent("${encodeURIComponent(u)}");`,
    base64OfRot13: `var s = atob("${Buffer.from(`x="${D.rot13(u)}"`).toString("base64")}");`,
  };
  for (const [name, js] of Object.entries(cases)) {
    assert.deepEqual(D.findMediaUrls(js, "https://p.example/").map((x) => x.url), [u], name);
  }
});

test("decode: player setups (JWPlayer, Video.js, Plyr, Clappr, DPlayer, JSON-in-script, <source>)", () => {
  const base = "https://site.example/watch/movie-1/";
  const pick = (t) => D.findMediaUrls(t, base).map((x) => x.url);
  assert.deepEqual(pick(`jwplayer('p').setup({ playlist: [{ sources: [{ file: "/hls/1/master.m3u8", label: "1080p" }, { file: "/v/1-480.mp4", label: "480p" }] }] })`), [
    "https://site.example/hls/1/master.m3u8",
    "https://site.example/v/1-480.mp4",
  ]);
  assert.deepEqual(pick(`var p = videojs('v', {}); p.src({ type: 'application/x-mpegURL', src: 'https://c.example/a/playlist.m3u8' });`), ["https://c.example/a/playlist.m3u8"]);
  assert.deepEqual(pick(`player.source = { type: 'video', sources: [{ src: 'https://c.example/b.mp4', type: 'video/mp4', size: 720 }] };`), ["https://c.example/b.mp4"]);
  assert.deepEqual(pick(`new Clappr.Player({ source: "https://c.example/c/index.m3u8", parentId: "#player" })`), ["https://c.example/c/index.m3u8"]);
  assert.deepEqual(pick(`new DPlayer({ container: el, video: { url: 'https://c.example/d.m3u8', type: 'hls' } })`), ["https://c.example/d.m3u8"]);
  assert.deepEqual(pick(`<script type="application/json" id="cfg">{"streams":[{"url":"https:\\/\\/c.example\\/e\\/master.m3u8","quality":"auto"}]}</script>`), ["https://c.example/e/master.m3u8"]);
  assert.deepEqual(pick(`<video controls><source src="/media/f.mp4" type="video/mp4" label="HD"></video>`), ["https://site.example/media/f.mp4"]);
  const cfgs = D.extractPlayerConfigs(`jwplayer("a").setup({file:"x.m3u8", tracks:[{file:"y.vtt"}]}); new Plyr('#p', {});`);
  assert.equal(cfgs[0].player, "jwplayer");
  assert.match(cfgs[0].config, /^\{file:"x\.m3u8"/);
});

test("decode: HLS ranked over MP4, DASH last, ad links last", () => {
  const t = `a="https://x.example/v.mpd" b="https://x.example/ads/preroll.m3u8" c="https://x.example/v.mp4" d="https://x.example/hls/master.m3u8"`;
  assert.deepEqual(D.findMediaUrls(t).map((x) => x.url), ["https://x.example/hls/master.m3u8", "https://x.example/v.mp4", "https://x.example/v.mpd", "https://x.example/ads/preroll.m3u8"]);
  assert.deepEqual(D.playableUrls(D.findMediaUrls(t)).map((x) => x.kind), ["hls", "mp4", "hls"]);
});

test("decode: DRM manifests are spotted, AES-128 is not DRM", () => {
  assert.ok(D.isProtectedManifest('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery"\n'));
  assert.ok(D.isProtectedManifest('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"'));
  assert.ok(D.isProtectedManifest('<MPD><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></MPD>'));
  const aes = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/keys/k1.key",IV=0x1\n#EXTINF:6,\nseg0.ts\n';
  assert.equal(D.isProtectedManifest(aes), false);
  assert.deepEqual(D.aesKeyUris(aes, "https://c.example/hls/720/index.m3u8"), ["https://c.example/keys/k1.key"]);
  assert.equal(D.firstSegment(aes, "https://c.example/hls/720/index.m3u8"), "https://c.example/hls/720/seg0.ts");
});

test("decode: master variants best first", () => {
  const m = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n1080.m3u8\n";
  assert.deepEqual(D.masterVariants(m, "https://c.example/h/master.m3u8").map((v) => [v.height, v.url]), [
    [1080, "https://c.example/h/1080.m3u8"],
    [360, "https://c.example/h/360.m3u8"],
  ]);
});

// ── Site adder: recipe matching ──────────────────────────────────────────

test("site: title pattern learned from a page's links", () => {
  const home = "https://old.example/";
  const urls = [
    "https://old.example/movies/the-general-1926/",
    "https://old.example/movies/nosferatu-1922/",
    "https://old.example/movies/metropolis-1927/",
    "https://old.example/genre/horror/",
    "https://old.example/category/silent/",
    "https://other.example/movies/x-1/",
  ];
  const p = S.learnTitlePattern(urls, home);
  assert.equal(p, "^/movies/[^/]+/?$");
  assert.ok(S.isTitleUrl("https://old.example/movies/sherlock-jr-1924", p, home));
  assert.ok(!S.isTitleUrl("https://old.example/genre/horror/", p, home));
  assert.ok(!S.isTitleUrl("https://other.example/movies/a-b/", p, home));
  // WordPress date permalinks.
  const wp = S.learnTitlePattern(["/2019/05/a-b/", "/2019/06/c-d/", "/2020/01/e-f/"].map((x) => "https://w.example" + x), "https://w.example/");
  assert.ok(S.isTitleUrl("https://w.example/2021/12/night-of-the-living-dead/", wp, "https://w.example/"));
});

test("site: titles from link text or slug, fuzzy match with year", () => {
  assert.deepEqual(S.titleOf({ href: "https://a/movies/night-of-the-living-dead-1968/", text: "" }), { title: "night of the living dead", year: 1968 });
  assert.deepEqual(S.titleOf({ href: "https://a/watch/123", text: "Watch The General (1926) Full Movie Online Free" }), { title: "The General", year: 1926 });
  const hits = [
    { url: "u1", title: "The General", year: 1926 },
    { url: "u2", title: "The General's Daughter", year: 1999 },
    { url: "u3", title: "General Hospital", year: null },
  ];
  assert.equal(S.pickBest(hits, { title: "The General", year: 1926 }).url, "u1");
  assert.equal(S.pickBest(hits, { title: "The General's Daughter", year: 1999 }).url, "u2");
  assert.equal(S.pickBest(hits, { title: "Metropolis", year: 1927 }), null);
  assert.equal(S.pickBest([{ url: "x", title: "Nosferatu", year: 1979 }], { title: "Nosferatu", year: 1922 }), null, "wrong year is not a match");
  assert.ok(S.scoreMatch({ title: "Sherlock, Jr." }, { title: "sherlock jr 1924", year: 1924 }) >= S.MIN_MATCH);
});

test("site: search detection (form, OpenSearch, WordPress) and results", () => {
  const html = `<html><head><link rel="search" type="application/opensearchdescription+xml" href="/os.xml"><link rel="https://api.w.org/" href="/wp-json/"></head>
    <body><form action="/search" method="get"><input type="hidden" name="type" value="movie"><input name="keyword" placeholder="Search movies"></form></body></html>`;
  const base = "https://s.example/";
  assert.equal(S.searchFormTemplate(S.extractForms(html, base)), "https://s.example/search?type=movie&keyword={q}");
  assert.equal(S.openSearchLink(html, base), "https://s.example/os.xml");
  assert.equal(S.parseOpenSearch('<OpenSearchDescription><Url type="text/html" template="https://s.example/?s={searchTerms}&amp;post_type=movie"/></OpenSearchDescription>'), "https://s.example/?s={q}&post_type=movie");
  assert.ok(S.isWordPress(html));
  const wp = JSON.stringify([{ id: 1, title: "Nosferatu (1922)", url: "https://s.example/movies/nosferatu/", type: "post" }]);
  assert.deepEqual(S.parseSearchResults(wp, base), [{ url: "https://s.example/movies/nosferatu/", title: "Nosferatu", year: 1922 }]);
  const req = S.searchRequest({ type: "api", url: "https://s.example/api/search?q={q}&api_key=old", keyParam: "api_key" }, "the general", { apiKey: "K1" });
  assert.equal(req.url, "https://s.example/api/search?q=the%20general&api_key=K1");
  assert.equal(req.headers["X-API-Key"], "K1");
});

test("site: episodes, mirrors and Cloudflare pages", () => {
  const links = [
    { href: "https://t.example/show/x/season-1/episode-1/", text: "Ep 1" },
    { href: "https://t.example/show/x/season-2/episode-3/", text: "Ep 3" },
  ];
  assert.equal(S.findEpisode(links, 2, 3), "https://t.example/show/x/season-2/episode-3/");
  assert.equal(S.findEpisode([{ href: "https://t.example/a/one-piece-episode-12", text: "" }], 1, 12), "https://t.example/a/one-piece-episode-12");
  assert.equal(S.findEpisode(links, 3, 1), null);
  const page = `<ul><li data-link="${Buffer.from("https://embed.one/e/abc").toString("base64")}">Server 1</li><li data-video="//embed.two/v/xyz">Mirror</li></ul><iframe src="https://embed.three/p/1"></iframe><a data-src="https://t.example/genre/x">Genre</a>`;
  assert.deepEqual(S.extractMirrors({ html: page }, "https://t.example/m/", { site: "t.example" }).map((m) => [m.label, m.url]), [
    ["Server 1", "https://embed.one/e/abc"],
    ["Mirror", "https://embed.two/v/xyz"],
    ["embed.three", "https://embed.three/p/1"],
  ]);
  assert.ok(S.isChallenge({ status: 403, text: "<html><head><title>Just a moment...</title></head><body>cf-chl-</body></html>" }));
  assert.ok(S.isInteractiveChallenge({ status: 403, text: "<title>Just a moment...</title><div class=cf-turnstile></div>" }));
  assert.ok(!S.isChallenge({ status: 200, text: "<title>Old Movies</title>" }));
});

test("site: recipes are normalized and need a search", () => {
  assert.equal(S.normalizeRecipe({ home: "https://a.example/x" }), null);
  const r = S.normalizeRecipe({ home: "https://a.example/x", search: { type: "form", url: "https://a.example/?s={q}" }, player: { mode: "bogus" } });
  assert.equal(r.home, "https://a.example/");
  assert.equal(r.player.mode, "sniff");
});

test("site: the site's own no-reuse / no-AI rules are respected", () => {
  assert.equal(S.reusePolicy({ robots: "User-agent: *\nDisallow: /admin\nSitemap: https://a/s.xml", html: "<p>Watch free</p>" }), null);
  assert.match(S.reusePolicy({ robots: "User-agent: *\nDisallow: /" }), /all automated tools/);
  assert.match(S.reusePolicy({ robots: "User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /" }), /AI agents/);
  assert.equal(S.reusePolicy({ robots: "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /" }), null);
  assert.match(S.reusePolicy({ robots: "User-agent: *\nContent-Signal: search=yes, ai-train=no, ai-input=no\nAllow: /" }), /ai-input=no/);
  assert.match(S.reusePolicy({ html: '<meta name="tdm-reservation" content="1">' }), /data mining/);
  assert.match(S.reusePolicy({ html: "<footer>Scraping and AI agents are not authorized to access this site.</footer>" }), /aren't authorized/);
  assert.match(S.reusePolicy({ html: "<p>We prohibit reuse of our streams.</p>" }), /aren't authorized/);
  assert.equal(S.reusePolicy({ html: "<p>Our AI picks are great. Bots love us.</p>" }), null);
});

test("iPhone site connector: carry-over only from non-challenge pages; site servers saved and resolved", async () => {
  const SS = await import("../src/platform/ios/siteServers.js");
  const calls = [];
  const frame = (html, title = "") => ({ kind: "frame", top: true, url: "https://ex.test/", title, html, links: [], forms: [] });
  let next = { frames: [frame("<h1>Just a moment...</h1><div class=cf-turnstile></div>", "Just a moment...")], challenge: true, cookie: "cf_clearance=x", userAgent: "UA-1" };
  globalThis.window = globalThis.window || {};
  window.webkit = { messageHandlers: { sbSiteRender: { postMessage: async (m) => { calls.push(m); return m.op === "render" ? next : { ok: true, status: 200, text: "", url: m.url }; } } } };
  assert.equal(SS.canAddSites(), true);
  const net = SS.nativeNet();
  const r1 = await net.render("https://ex.test/");
  assert.equal(r1.challenge, true);
  assert.equal(r1.cookie, null, "no cookie from a challenge page");
  assert.deepEqual(net.carried(), { cookie: null, userAgent: null });
  assert.match(calls[0].script, /sbCollect/, "collector.js injected");
  next = { frames: [frame("<h1>Home</h1>", "Films")], challenge: false, cookie: "cf_clearance=ok", userAgent: "UA-2" };
  const r2 = await net.render("https://ex.test/");
  assert.equal(r2.cookie, "cf_clearance=ok");
  assert.deepEqual(net.carried(), { cookie: "cf_clearance=ok", userAgent: "UA-2" });
  await net.fetch("https://ex.test/x");
  assert.equal(calls.at(-1).headers["User-Agent"], "UA-2");
  // A page the bridge didn't flag but that is a challenge still gives nothing.
  next = { frames: [frame('<script>window._cf_chl_opt={}</script><div class="cf-turnstile"></div>', "Just a moment...")], challenge: false, cookie: "c=1", userAgent: "UA-3" };
  const r3 = await net.render("https://ex.test/");
  assert.equal(r3.challenge, true);
  assert.equal(r3.cookie, null);
  // Saved "site" kind.
  const s = SS.normalizeSiteServer({ kind: "site", name: "Ex", recipe: { home: "https://ex.test/", search: { type: "wp", url: "https://ex.test/wp-json/wp/v2/search?search={q}" } } }, "custom-");
  assert.ok(s && s.kind === "site" && s.id.startsWith("custom-") && s.lists.movies && s.lists.tv && !s.lists.anime);
  assert.equal(SS.normalizeSiteServer({ kind: "site", recipe: {} }, "custom-"), null);
  delete window.webkit;
  assert.equal(SS.canAddSites(), false);
});

// ── Issue #27: bingebang / flystream / movy (offline fixtures, scripts/site-corpus) ──

const { smartAdd, builtInFor } = await import("../src/platform/ios/customSmartAdd.js");
const fs27 = await import("node:fs");
const corpus = (dir, extra = {}) => {
  const base = `${process.cwd()}/scripts/site-corpus/fixtures/${dir}/`;
  const routes = { ...JSON.parse(fs27.readFileSync(base + "routes.json", "utf8")), ...extra };
  const seen = [];
  const http = async (url) => {
    seen.push(url);
    const u = new URL(url);
    const key = u.pathname + u.search;
    const r = routes[`${u.protocol}${key}`] || routes[key] || routes[key.toLowerCase()];
    if (!r) return { status: 404, text: "" };
    return { status: r.status, text: r.text ?? fs27.readFileSync(base + r.file, "utf8"), url };
  };
  return { http, seen };
};
const FG = { id: 1434, name: "Family Guy", first_air_date: "1999-01-31" };
const EG = { id: 299534, title: "Avengers: Endgame", release_date: "2019-04-24" };
const tmdb27 = (calls) => async (path) => {
  calls.push(path);
  const k = path.split("?")[0];
  const q = decodeURIComponent((/query=([^&]*)/.exec(path) || [])[1] || "").toLowerCase();
  const ids = {
    "/tv/1": { id: 1, name: "Pride", first_air_date: "2004-04-13" },
    "/movie/1": { id: 1, title: "Pride", release_date: "2004-01-01" },
    "/tv/1434": FG,
    "/tv/1399": { id: 1399, name: "Game of Thrones", first_air_date: "2011-04-17" },
    "/movie/27205": { id: 27205, title: "Inception", release_date: "2010-07-15" },
  };
  if (ids[k]) return ids[k];
  if (k.startsWith("/search/")) {
    if (q.startsWith("family guy")) return { results: [{ media_type: "tv", ...FG }] };
    if (q.startsWith("avengers")) return { results: [{ media_type: "movie", ...EG }] };
    return { results: [] };
  }
  const e = new Error("404 not found");
  e.status = 404;
  throw e;
};
const add27 = async (link, site) => {
  const calls = [];
  const tmdb = tmdb27(calls);
  const analyze = (url, prefer) =>
    matchSample(url, { tmdb, anilist: async () => ({}), prefer, timeoutMs: 2000 }).then((r) => (r.ok ? { ...r, templates: { [r.detected.kind]: r.detected.template } } : r));
  const r = await smartAdd(link, { deps: { http: site.http, siteHttp: site.http, analyze, native: false } });
  return { r, calls };
};

test("#27 bingebang: Family Guy 1/1 is {site}/{season}/{episode}, never Pride or {tmdb}", async () => {
  const { r, calls } = await add27("https://bingebang.sx/tv/play/family-guy-y6bs3k/1/1", corpus("bingebang"));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.draft.match.title, "Family Guy");
  assert.equal(r.draft.templates.tv, "https://bingebang.sx/tv/play/{site}/{season}/{episode}");
  assert.ok(!Object.values(r.draft.templates).some((t) => t.includes("{tmdb}")));
  assert.ok(!calls.includes("/tv/1") && !calls.includes("/movie/1"), "1/1 is never looked up as an id");
  assert.equal(r.draft.lists.tv, true);
});

test("#27 bingebang: Avengers: Endgame matches, site search found with plain words", async () => {
  const site = corpus("bingebang");
  const { r } = await add27("https://bingebang.sx/movie/play/avengers-endgame-2019-5iu40l", site);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.draft.match.ids.tmdb, 299534);
  assert.equal(r.draft.templates.movie, "https://bingebang.sx/movie/play/{site}");
  assert.ok(site.seen.some((u) => u.endsWith("/api/search/movie?query=avengers%20endgame&page=1")), "no colon in the search");
  // Its play page is a human check: its title is never matched as a film.
  assert.ok(CS.CHECK_PAGE_TITLE.test("Quick check · BingeBang"));
  assert.ok(!CS.CHECK_PAGE_TITLE.test("Avengers: Endgame (2019)"));
});

test("#27 flystream: a verified TV link turns TV on in storage and in the open sheet, and Save keeps it", async () => {
  for (const s of CS.listCustomServers()) await CS.deleteCustomServer(s.id);
  const draft = {
    name: "Flystream",
    sample: "https://flystream.net/movie/27205",
    templates: { movie: "https://flystream.net/movie/{tmdb}", tv: "https://flystream.net/tv/{tmdb}/{season}/{episode}" },
    guessed: { tv: true },
    lists: { anime: false, movies: true, tv: false },
    match: { kind: "movie", ids: { tmdb: 27205 }, title: "Inception", year: 2010 },
  };
  const s = await CS.saveCustomServer(draft);
  await CS.recordRecipe(s.id, { verified: ["movie", "tv"] });
  const stored = CS.listCustomServers().find((x) => x.id === s.id);
  assert.equal(stored.lists.tv, true);
  assert.ok(!stored.guessed?.tv);
  // The sheet's copy (what the TV switch shows and what Save writes back).
  const sheet = { ...s, ...CS.withVerified(s, ["movie", "tv"]) };
  assert.deepEqual(sheet.lists, { anime: false, movies: true, tv: true });
  const saved = await CS.saveCustomServer(sheet);
  assert.equal(saved.lists.tv, true);
  assert.ok(CS.serverFits(saved, { isAnime: false, type: "tv" }));
  assert.deepEqual(CS.withVerified(s, []).lists, s.lists, "nothing verified changes nothing");
  await CS.deleteCustomServer(s.id);
});

test("#27 movy.sx: https first, TV names {season}/{episode}, already built in as Movy", async () => {
  const site = corpus("movy", { "https:/": { status: 200, text: "<html><title>Movy</title></html>" } });
  const { r } = await add27("http://movy.sx/tv/1399", site);
  assert.equal(r.ok, true, r.error);
  assert.ok(site.seen[0].startsWith("https://movy.sx/"), "https is tried first");
  for (const t of Object.values(r.draft.templates)) assert.ok(t.startsWith("https://movy.sx/"), t);
  assert.equal(r.draft.templates.tv, "https://movy.sx/tv/{tmdb}/{season}/{episode}");
  assert.deepEqual(r.builtIn, { id: "movy-direct", label: "Movy" });
  assert.deepEqual(builtInFor("https://www.movy.sx/movie/27205"), { id: "movy-direct", label: "Movy" });
  assert.equal(builtInFor("https://flystream.net/movie/27205"), null);
});

test("techniques: the Test names the method that found each stream", async () => {
  const M = await import("../src/utils/customServers/method.js");
  const embed = M.methodOfTry({ stream: { ok: true, kind: "hls", url: "https://cdn.x/m.m3u8", page: "https://vidplay.site/e/1" }, page: { url: "https://site.tv/watch/1", taps: ["Server 2"] } });
  assert.equal(embed.id, "embed");
  assert.equal(embed.host, "vidplay.site");
  assert.match(embed.label, /^HLS \(m3u8\) · followed the embedded player on vidplay\.site, after pressing “Server 2”$/);
  const own = M.methodOfTry({ stream: { ok: true, kind: "mp4", url: "https://cdn.site.tv/a.mp4", page: "https://www.site.tv/watch/1" }, page: { url: "https://site.tv/watch/1" } });
  assert.equal(own.id, "page");
  assert.equal(own.label, "MP4 · sniffed from the site's own player");
  assert.equal(M.methodOf({ how: "api", url: "https://c/x.m3u8", pageUrl: "https://s.tv/" }).id, "api");
  assert.equal(M.methodOf({ direct: true }).id, "direct");
  assert.equal(M.methodOfTry({ stream: { ok: false } }), null);
  // Page Test step carries it; site servers keep it through normalize.
  const steps = CS.pageSteps({ page: { ok: true, url: "https://site.tv/w" }, stream: { ok: true, kind: "hls", ms: 1200, page: "https://vidplay.site/e" }, playable: { ok: true } }, { title: "X", want: {}, site: "Site" });
  const st = steps.find((s) => s.id === "stream");
  assert.equal(st.method, "embed");
  assert.match(st.detail, /^HLS in 1\.2 s · followed the embedded player on vidplay\.site$/);
  assert.equal(CS.normalizeSiteServers([{ label: "S1", works: true, method: "MP4 · x" }])[0].method, "MP4 · x");
  assert.equal("method" in CS.normalizeSiteServers([{ label: "S1" }])[0], false);
});

test("whole-site play: the page's stream goes to the native player with Referer/UA, cookies only on the same site", async () => {
  const SS = await import("../src/platform/ios/siteServers.js");
  const carried = { cookie: "sid=1", userAgent: "UA-9" };
  const same = SS.playHeaders("https://cdn.site.tv/m.m3u8", "https://site.tv/watch/1", carried);
  assert.deepEqual(same, { Referer: "https://site.tv/", Origin: "https://site.tv", Cookie: "sid=1", "User-Agent": "UA-9" });
  const other = SS.playHeaders("https://cdn.other.net/m.m3u8", "https://site.tv/watch/1", carried);
  assert.equal(other.Cookie, undefined, "never hand the site's cookies to another host");
  assert.equal(other["User-Agent"], "UA-9");
});

test("Test: retest memory keeps links that worked; Stop keeps what works", async () => {
  const opened = [];
  let answer = () => ({ page: { ok: true, url: "https://rt.test/" }, stream: { ok: true, kind: "hls", ms: 10 }, playable: { ok: true } });
  window.webkit = { messageHandlers: { sbServerTest: { postMessage: async (m) => (m.candidate ? (opened.push(m.candidate.url), answer(m)) : { ok: true }) } } };
  const s = await CS.saveCustomServer({ name: "RT", mode: "page", templates: { movie: "https://rt.test/embed/movie/{tmdb}" }, lists: { movies: true } });
  assert.equal(s.learnMs, CS.LEARN_TIME.def);
  assert.equal(s.linkWaitMs, CS.LINK_WAIT.def);
  assert.equal(CS.clampMs(10, CS.LEARN_TIME), CS.LEARN_TIME.min);
  assert.equal(CS.clampMs(9e9, CS.LINK_WAIT), CS.LINK_WAIT.max);
  const r1 = await CS.testServer(s, { retest: false });
  assert.ok(r1.playable && !r1.stopped);
  await CS.recordTestResult(s.id, { ...r1, ok: false, summary: "Works for movie" });
  let saved = CS.listCustomServers().find((x) => x.id === s.id);
  assert.ok(CS.keptKind(saved, "movie"), "worked kind remembered");
  // Retest: the movie link is kept without opening a page.
  opened.length = 0;
  const r2 = await CS.testServer(saved, { retest: true });
  assert.equal(opened.length, 0);
  assert.match(r2.kinds[0].steps.at(-1).detail, /Kept/);
  // Test Everything opens it again.
  await CS.testServer(saved, { retest: true, full: true });
  assert.ok(opened.length > 0);
  // A changed template is new: tried again.
  assert.equal(CS.keptKind({ ...saved, templates: { movie: "https://rt.test/v/{tmdb}" } }, "movie"), false);
  // Stop: the page never answers; the run ends and keeps what worked.
  answer = () => new Promise(() => {});
  const ctl = new AbortController();
  const p = CS.testServer(saved, { retest: false, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  const r3 = await p;
  assert.equal(r3.stopped, "stop");
  assert.equal(r3.summary, "Working · stopped early");
  saved = CS.listCustomServers().find((x) => x.id === s.id);
  assert.ok(CS.keptKind(saved, "movie"), "Stop doesn't forget a working link");
  // A stopped run that found nothing leaves the last result alone.
  const last = saved.lastTest;
  await CS.recordTestResult(s.id, { ok: false, stopped: "stop", summary: "Stopped" });
  assert.deepEqual(CS.listCustomServers().find((x) => x.id === s.id).lastTest, last);
  delete window.webkit;
});

// ── Direct recipes for every title (fmfau-style API) ─────────────────────
// A site API like fmfau.com's /api/sources/leibniz?tmdbId=…&mediaType=…&sub=<server>:
// learned once on one movie, saved as a template, one Sources entry per API
// server, and reused for another movie and for a TV episode. Offline fixture.

const DR = await import("../src/utils/customServers/direct.js");
const { setDirectHttp, clearDirectCache } = await import("../src/platform/ios/customDirect.js");

const FM_API = "https://fmfau.com/api/sources/leibniz";
const FM_TITLES = { 27205: ["Inception", 2010], 155: ["The Dark Knight", 2008], 1399: ["Game of Thrones", 2011] };
const FM_SERVERS = [
  { id: "vortex", name: "Vortex" },
  { id: "nova", name: "Nova" },
  { id: "zen", name: "Zen" },
];
const fmAnswer = (q) => {
  const [title, year] = FM_TITLES[q.get("tmdbId")] || ["Unknown", 1900];
  const ep = q.get("mediaType") === "tv" ? `/s${q.get("season")}e${q.get("episode")}` : "";
  return JSON.stringify({
    title,
    year,
    servers: FM_SERVERS,
    sources: [{ file: `https://cdn.fmfau.test/hls/${q.get("mediaType")}/${q.get("tmdbId")}${ep}/${q.get("sub")}/master.m3u8`, type: "hls" }],
  });
};
const fmCalls = [];
const fmHttp = async (req) => {
  fmCalls.push(req.url);
  const u = new URL(req.url);
  if (u.origin + u.pathname !== FM_API || !u.searchParams.get("tmdbId") || !u.searchParams.get("sub")) return { status: 404, text: "", url: req.url };
  if (u.searchParams.get("mediaType") === "tv" && !u.searchParams.get("episode")) return { status: 400, text: "{}", url: req.url };
  return { status: 200, text: fmAnswer(u.searchParams), url: req.url };
};
const fmLearnUrl = `${FM_API}?tmdbId=27205&mediaType=movie&title=Inception&year=2010&imdbId=tt1375666&sub=vortex&audioPreference=sub`;
const fmLog = {
  requests: [
    { url: fmLearnUrl, method: "GET", headers: { Accept: "application/json" }, status: 200, contentType: "application/json", text: fmAnswer(new URL(fmLearnUrl).searchParams), page: "https://fmfau.com/movie/27205" },
  ],
};
const fmValues = { tmdb: 27205, imdb: "tt1375666", title: "Inception", year: 2010 };

test("direct recipe: fmfau-style API call becomes a template for every title", () => {
  const r = DR.learnFromLog(fmLog, { stream: "https://cdn.fmfau.test/hls/movie/27205/vortex/master.m3u8", values: fmValues, kind: "movie" });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.def.url, `${FM_API}?tmdbId={tmdb}&mediaType=movie&title={title}&year={year}&imdbId={imdb}&sub=vortex&audioPreference={lang}`);
  assert.equal(r.def.extract.type, "path");
  assert.deepEqual(r.def.server, { param: "sub", current: "vortex", list: ["vortex", "nova", "zen"] }, "every server the API offers");
  // the TV call from the movie one: kind switched, season/episode added
  const tv = DR.deriveDirect(r.def, "movie", "tv");
  assert.equal(tv.url, `${FM_API}?tmdbId={tmdb}&mediaType=tv&title={title}&year={year}&imdbId={imdb}&sub=vortex&audioPreference={lang}&season={season}&episode={episode}`);
  assert.equal(DR.deriveDirect(tv, "tv", "movie").url, r.def.url, "and back");
  assert.equal(DR.deriveDirect({ url: "https://x.site/api/s?id={tmdb}" }, "movie", "tv"), null, "no kind named: no guess");
  // another server picked: same recipe, sub= switched
  assert.match(DR.directServerVariant(r.def, "nova").url, /&sub=nova&/);
  // a title without an IMDb id still gets a request (optional field dropped)
  const req = DR.buildDirectRequest(r.def, { tmdb: 155, title: "The Dark Knight", year: 2008 });
  assert.equal(req.url, `${FM_API}?tmdbId=155&mediaType=movie&title=The%20Dark%20Knight&year=2008&sub=vortex&audioPreference=sub`);
  assert.equal(DR.buildDirectRequest(r.def, { title: "X" }), null, "an id is still needed");
  assert.deepEqual(DR.apiServersFrom({ url: "https://a/api?id=1&sub=dub" }), null, "Sub/Dub isn't a server");
});

test("direct recipe: one Sources entry per API server, used for another movie and a TV episode", async () => {
  for (const s of CS.listCustomServers()) await CS.deleteCustomServer(s.id);
  clearDirectCache();
  setDirectHttp(fmHttp);
  const learned = DR.learnFromLog(fmLog, { stream: null, values: fmValues, kind: "movie" });
  const s = await CS.saveCustomServer({
    name: "fmfau",
    sample: "https://fmfau.com/movie/27205",
    templates: { movie: "https://fmfau.com/movie/{tmdb}", tv: "https://fmfau.com/tv/{tmdb}/{season}/{episode}" },
    lists: { anime: false, movies: true, tv: true },
    match: inception,
    direct: { movie: { ...learned.def, source: "auto" } },
  });
  const stored = CS.listCustomServers().find((x) => x.id === s.id);
  assert.deepEqual(stored.direct.movie.server.list, ["vortex", "nova", "zen"], "servers kept with the recipe");
  const sources = CS.customPlayerSources().filter((x) => CS.baseCustomId(x.id) === s.id);
  assert.deepEqual(sources.map((x) => x.label), ["fmfau", "fmfau · Vortex", "fmfau · Nova", "fmfau · Zen"]);

  // A different movie (no IMDb id known): every server plays from the API, page last.
  const movie = await CS.customCandidates({ type: "movie", tmdbId: 155, title: "The Dark Knight", year: 2008 });
  assert.deepEqual(
    movie.map((c) => c.url),
    [
      "https://cdn.fmfau.test/hls/movie/155/vortex/master.m3u8#sb-direct",
      "https://cdn.fmfau.test/hls/movie/155/vortex/master.m3u8#sb-direct",
      "https://cdn.fmfau.test/hls/movie/155/nova/master.m3u8#sb-direct",
      "https://cdn.fmfau.test/hls/movie/155/zen/master.m3u8#sb-direct",
      "https://fmfau.com/movie/155",
    ],
  );
  assert.deepEqual(movie.slice(1, 4).map((c) => c.id), sources.slice(1).map((x) => x.id), "entries match the Sources ids");

  // A TV episode: the movie recipe switched to TV, season/episode filled, page kept as fallback.
  const tv = await CS.customCandidates({ type: "tv", tmdbId: 1399, tmdbSeason: 3, tmdbEpisode: 7, title: "Game of Thrones", year: 2011 });
  assert.deepEqual(
    tv.filter((c) => c.direct).map((c) => c.url),
    ["vortex", "vortex", "nova", "zen"].map((x) => `https://cdn.fmfau.test/hls/tv/1399/s3e7/${x}/master.m3u8#sb-direct`),
  );
  assert.ok(tv.some((c) => c.url === "https://fmfau.com/tv/1399/3/7"), "page route still there");
  assert.ok(fmCalls.some((u) => /mediaType=tv&.*season=3&episode=7/.test(u)));
  setDirectHttp(null);
  await CS.deleteCustomServer(s.id);
});

test("Test tries every API server, not only the first that works; each that plays is added", async () => {
  for (const s of CS.listCustomServers()) await CS.deleteCustomServer(s.id);
  clearDirectCache();
  // 4 servers: vortex (the page's) works, nova works, zen answers with no stream, echo works.
  const servers = [...FM_SERVERS, { id: "echo", name: "Echo" }];
  const tried = [];
  setDirectHttp(async (req) => {
    const u = new URL(req.url);
    tried.push(u.searchParams.get("sub"));
    if (u.searchParams.get("sub") === "zen") return { status: 200, text: JSON.stringify({ title: "Inception", year: 2010, servers, sources: [] }), url: req.url };
    const r = await fmHttp(req);
    return { ...r, text: r.text.replace(/"servers":\[[^\]]*\]/, `"servers":${JSON.stringify(servers)}`) };
  });
  const log = { requests: [{ ...fmLog.requests[0], text: fmLog.requests[0].text.replace(/"servers":\[[^\]]*\]/, `"servers":${JSON.stringify(servers)}`) }] };
  const s = await CS.saveCustomServer({
    name: "fmfau",
    sample: "https://fmfau.com/movie/27205",
    templates: { movie: "https://fmfau.com/movie/{tmdb}" },
    lists: { anime: false, movies: true, tv: false },
    match: inception,
  });
  const link = { url: "https://fmfau.com/movie/27205", values: fmValues, want: { title: "Inception", year: 2010, kind: "movie" } };
  const page = { stream: { ok: true, url: "https://cdn.fmfau.test/hls/movie/27205/vortex/master.m3u8", headers: {} }, learn: log };
  // the native headless player, stubbed: every stream with a link opens
  window.webkit = { messageHandlers: { sbServerTest: { postMessage: async (m) => (m.playable ? { ok: true } : { ok: false }) } } };
  const d = await CS.directSteps(s, "movie", link, page);
  delete window.webkit;
  assert.ok(d.def, d.note);
  assert.deepEqual(d.def.server.list, ["vortex", "nova", "zen", "echo"]);
  for (const v of ["vortex", "nova", "zen", "echo"]) assert.ok(tried.includes(v), `${v} tried`);
  assert.deepEqual(d.def.server.works, ["vortex", "nova", "echo"], "every working server kept, not just the first");
  const apiSteps = d.steps.filter((x) => x.id.startsWith("api-"));
  assert.deepEqual(apiSteps.map((x) => [x.label, !x.neutral]), [
    ["API server: Vortex", true],
    ["API server: Nova", true],
    ["API server: Zen", false],
    ["API server: Echo", true],
  ], "each server's result in the Test list");
  await CS.recordDirect(s.id, "movie", d.def, d.note);
  const sources = CS.customPlayerSources().filter((x) => CS.baseCustomId(x.id) === s.id).map((x) => x.label);
  assert.deepEqual(sources, ["fmfau", "fmfau · Vortex", "fmfau · Nova", "fmfau · Echo"], "working ones become Sources entries");
  setDirectHttp(null);
  await CS.deleteCustomServer(s.id);
});

// ── fmfau.com: the API lists a removed 2160p first (lightspeed.st answers 404 "Removed") ──

test("fmfau Direct: a 404 on the API's first stream moves on to its next one, with the headers the API names", async () => {
  const D = await import("../src/utils/customServers/direct.js");
  const CD = await import("../src/platform/ios/customDirect.js");
  const hls = (q) => `https://lightspeed.st/hls/0ef437a0-dcfb-4720-91a1-2a342408ef45/1/${q}/playlist.m3u8`;
  const cdn = { Referer: "https://cinejoy.pk/", Origin: "https://cinejoy.pk", "User-Agent": "Chrome/122" };
  // The shape fmfau's /api/sources/leibniz answered on 2026-11-21 (trimmed).
  const answer = JSON.stringify({
    ok: true,
    provider: "direct",
    streams: [
      { url: hls("2160p"), quality: 2160, type: "hls", headers: { ...cdn, Cookie: "x=1" }, name: "Vortex 01" },
      { url: hls("1080p"), quality: 1080, type: "hls", headers: cdn, name: "Vortex 01" },
    ],
    audioOptions: [{ id: "lang-en", url: "https://img1.fcxmb.com/hls/abc/720/index_266.m3u8", headers: { Referer: "https://player.vidzee.wtf/" } }],
  });
  // Learned from the page: the stream it played is the first one, read at streams.0.url.
  const extract = D.extractorFor(answer, hls("2160p"));
  assert.deepEqual(extract, { type: "path", path: "streams.0.url" });

  const def = {
    url: "https://fmfau.com/api/sources/leibniz?tmdbId={tmdb}&mediaType=movie",
    method: "GET",
    headers: { Referer: "https://fmfau.com/", Origin: "https://fmfau.com" },
    extract,
    streamHeaders: { Referer: "https://fmfau.com/", Origin: "https://fmfau.com", "User-Agent": CD.SAFARI_UA },
  };
  CD.setDirectHttp(async (req) => ({ status: 200, text: answer, url: req.url }));
  const tried = [];
  // lightspeed.st: 2160p is gone whatever the headers; 1080p opens.
  const playable = async (url, headers) => {
    tried.push({ url, headers });
    return /2160p/.test(url) ? { ok: false, error: "The requested URL was not found on this server." } : { ok: true, detail: "Ready to play (92 min)" };
  };
  try {
    const t = await CD.testDirect(def, { tmdb: 1560520 }, null, { playable });
    const step = (id) => t.steps.find((s) => s.id === id);
    assert.equal(step("d-stream").ok, true);
    assert.equal(step("d-playable").ok, true, step("d-playable").detail);
    assert.match(step("d-playable").detail, /1080p.*1 earlier stream failed: The requested URL was not found/);
    assert.equal(t.ok, true);
    assert.equal(t.stream, hls("1080p"), "Test reports the stream that played");
    assert.deepEqual(tried.map((x) => x.url), [hls("2160p"), hls("1080p")]);
    // The check uses play's headers: the API's for its CDN over the page's.
    assert.equal(tried[1].headers.Referer, "https://cinejoy.pk/");
    assert.equal(tried[1].headers["User-Agent"], "Chrome/122");
    // Play gets the same streams and headers, in the same order.
    const r = await CD.resolveDirect(def, { tmdb: 1560520 });
    assert.deepEqual(r.streams.map((s) => [s.url, s.headers.Referer]), tried.map((x) => [x.url, x.headers.Referer]));
    // Nothing opens: one clear failure naming each stream's error.
    const none = await CD.testDirect(def, { tmdb: 1560520 }, null, { playable: async () => ({ ok: false, error: "HTTP 404" }) });
    assert.match(none.steps.at(-1).detail, /None of the API's 2 streams opened: HTTP 404; HTTP 404/);
  } finally {
    CD.setDirectHttp(null);
  }
  const streams = D.extractStreams(answer, extract, "https://fmfau.com/api/sources/leibniz");
  assert.deepEqual(streams.map((s) => s.url), [hls("2160p"), hls("1080p")], "the API's streams in order, no audio track");
  assert.deepEqual(streams[0].headers, cdn, "the API's per-stream headers, never its Cookie");
  // Other extract shapes keep working: one stream, no list.
  assert.deepEqual(D.extractStreams(`{"file":"${hls("720p")}"}`, { type: "path", path: "file" }, "https://x.test/"), [{ url: hls("720p"), headers: {} }]);
  assert.deepEqual(D.extractStreams(`src: "${hls("720p")}"`, { type: "regex" }, "https://x.test/"), [{ url: hls("720p"), headers: {} }]);
});

test("API servers learned from the site's own scripts (no list in the answer), learn time up to 15 min", async () => {
  assert.equal(CS.LEARN_TIME.max, 15 * 60000);
  assert.equal(CS.LEARN_TIME.def, 5 * 60000);
  assert.equal(CS.LINK_WAIT.max, 5 * 60000);
  assert.equal(CS.LINK_WAIT.def, 45000);
  clearDirectCache();
  // The answer names no other servers; the player bundle does (generic: any site, any key name).
  setDirectHttp(async (req) => {
    const u = new URL(req.url);
    const sub = u.searchParams.get("sub");
    return { status: 200, url: req.url, text: JSON.stringify({ title: "Inception", year: 2010, sources: [{ file: `https://cdn.x.test/${u.searchParams.get("tmdbId")}/${sub}/index.m3u8` }] }) };
  });
  const url = `${FM_API}?tmdbId=27205&mediaType=movie&title=Inception&year=2010&sub=vortex`;
  const log = {
    requests: [{ url, method: "GET", headers: {}, status: 200, text: JSON.stringify({ title: "Inception", year: 2010, sources: [{ file: "https://cdn.x.test/27205/vortex/index.m3u8" }] }), page: "https://fmfau.com/movie/27205" }],
    scripts: [{ text: 'var a=1;const PROVIDERS=[{id:"vortex",label:"Vortex"},{id:"nebula",label:"Nebula"},{id:"solara",label:"Solara"}];const Q=["orbit","orbitbak","solis"];' }],
  };
  const { learnDirect } = await import("../src/platform/ios/customDirect.js");
  const r = await learnDirect({ kind: "movie", values: fmValues, want: null, stream: "https://cdn.x.test/27205/vortex/index.m3u8", log, page: "https://fmfau.com/movie/27205" });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.def.server.list.slice(0, 3), ["vortex", "nebula", "solara"]);
  assert.ok(!r.def.server.list.includes("orbit"), "a list without the current server isn't the server list");
  setDirectHttp(null);
});

// ── A Cinejoy-shaped API (POST, server picked in the body, server list only in the player bundle,
//    per-stream headers in the answer), fully mapped by the generic learner. Plain JSON stands in for
//    Cinejoy's sealed requests, which the learner rightly refuses (encrypted answers).
test("generic learner maps a Cinejoy-shaped API: body server, bundle list, every server tried, recipe for all titles", async () => {
  for (const s of CS.listCustomServers()) await CS.deleteCustomServer(s.id);
  clearDirectCache();
  const API = "https://api.cine.test/g";
  const names = { 27205: ["Inception", 2010], 1399: ["Game of Thrones", 2011], 603: ["The Matrix", 1999] };
  const answer = (b) => {
    const [title, year] = names[b.tmdb] || ["?", 0];
    if (b.server === "Polaris") return { status: 500, text: "{}" };
    if (b.server === "Sirius") return { status: 200, text: JSON.stringify({ title, year, streams: [] }) };
    const ep = b.type === "tv" ? `/${b.season}x${b.episode}` : "";
    return { status: 200, text: JSON.stringify({ title, year, streams: [{ url: `https://edge.cine.test/${b.type}/${b.tmdb}${ep}/${b.server.toLowerCase()}/1080.m3u8`, headers: { Referer: "https://cine.test/", Origin: "https://cine.test" } }] }) };
  };
  const calls = [];
  setDirectHttp(async (req) => {
    const b = JSON.parse(req.body || "{}");
    calls.push(b);
    return { url: req.url, ...answer(b) };
  });
  const body = JSON.stringify({ path: "/sources", tmdb: 27205, type: "movie", server: "Light" });
  const log = {
    requests: [{ url: API, method: "POST", headers: { "Content-Type": "application/json" }, body, status: 200, text: answer(JSON.parse(body)).text, page: "https://cine.test/movie/27205" }],
    scripts: [{ text: 'const UPSTREAMS=["Light","Nebula","Sirius","Rigel","Polaris"];function pick(i){return UPSTREAMS[i]}' }],
  };
  const values = { tmdb: 27205, title: "Inception", year: 2010 };
  const s = await CS.saveCustomServer({
    name: "Cine",
    sample: "https://cine.test/movie/27205",
    templates: { movie: "https://cine.test/movie/{tmdb}", tv: "https://cine.test/tv/{tmdb}/{season}/{episode}" },
    lists: { anime: false, movies: true, tv: true },
    match: inception,
  });
  window.webkit = { messageHandlers: { sbServerTest: { postMessage: async (m) => (m.playable ? { ok: true } : { ok: false }) } } };
  const d = await CS.directSteps(s, "movie", { url: "https://cine.test/movie/27205", values, want: { title: "Inception", year: 2010, kind: "movie" } }, {
    stream: { ok: true, url: "https://edge.cine.test/movie/27205/light/1080.m3u8", headers: {} },
    learn: log,
  });
  delete window.webkit;
  assert.ok(d.def, d.note);
  assert.equal(d.def.body, '{"path":"/sources","tmdb":{tmdb},"type":"movie","server":"Light"}', "a template for every title");
  assert.deepEqual(d.def.server.list, ["Light", "Nebula", "Sirius", "Rigel", "Polaris"], "server list read from the bundle");
  for (const v of d.def.server.list) assert.ok(calls.some((c) => c.server === v), `${v} tried`);
  assert.deepEqual(d.def.server.works, ["Light", "Nebula", "Rigel"], "every working server, not only the first");
  await CS.recordDirect(s.id, "movie", d.def, d.note);
  assert.deepEqual(CS.customPlayerSources().filter((x) => CS.baseCustomId(x.id) === s.id).map((x) => x.label), ["Cine", "Cine · Light", "Cine · Nebula", "Cine · Rigel"]);
  const stored = CS.listCustomServers().find((x) => x.id === s.id);
  assert.equal(CS.serverCountText(CS.serverCount(stored)), "3 of 5 servers work", "count for the Test summary and the site row");
  assert.equal(CS.serverCountText(CS.serverCount({ ...stored, siteServers: [{ label: "A", works: true }, { label: "B", works: false }] })), "4 of 7 servers work", "site buttons counted too");
  // Another movie and a TV episode from the same recipe, with the API's own per-stream headers.
  const movie = await CS.customCandidates({ type: "movie", tmdbId: 603, title: "The Matrix", year: 1999 });
  assert.deepEqual(movie.filter((c) => c.direct).map((c) => c.url.split("/").slice(3, 7).join("/")), ["movie/603/light/1080.m3u8#sb-direct", "movie/603/light/1080.m3u8#sb-direct", "movie/603/nebula/1080.m3u8#sb-direct", "movie/603/rigel/1080.m3u8#sb-direct"]);
  assert.equal(movie[0].headers.Referer, "https://cine.test/");
  const tv = await CS.customCandidates({ type: "tv", tmdbId: 1399, tmdbSeason: 2, tmdbEpisode: 4, title: "Game of Thrones", year: 2011 });
  assert.ok(tv.some((c) => c.url === "https://edge.cine.test/tv/1399/2x4/nebula/1080.m3u8#sb-direct"), "TV from the movie recipe (body type switched, season/episode added)");
  setDirectHttp(null);
  await CS.deleteCustomServer(s.id);
});

// ── Engine: per-site wait everywhere, stream bodies validated, generic page titles ──
test("engine: every hidden page of a site waits its per-link setting (no hard-coded 15 s)", async () => {
  const { readFileSync } = await import("node:fs");
  const s = { id: "custom-wait", name: "Slow", site: "slow.test", linkWaitMs: 90000, templates: { movie: "https://slow.test/m/{tmdb}" } };
  assert.equal(CS.linkWaitOf(s), 90000);
  assert.equal(CS.linkWaitOf({}), CS.LINK_WAIT.def, "no setting: the default wait");
  assert.equal(CS.candidateFor(s, "https://slow.test/m/1").timeoutMs, 90000, "playback candidates use the site's wait");
  let sent = null;
  window.webkit = { messageHandlers: { sbServerTest: { postMessage: async (m) => ((sent = m), { page: { ok: true, status: 200, title: "Slow" }, stream: { ok: false }, playable: { ok: false } }) } } };
  const r = await CS.nativeTry(s, "https://slow.test/m/1");
  delete window.webkit;
  assert.equal(sent.candidate.timeoutMs, 90000, "Test / smart add pages get the site's wait");
  const st = CS.pageSteps(r, { title: "X", want: { title: "X", kind: "movie" }, site: "Slow" }).find((x) => x.id === "stream");
  assert.match(st.detail, /within 90 s/, "the message names the wait actually used");
  assert.doesNotMatch(st.detail, /15 s/);
  const SITE = await import("../src/utils/customServers/site.js");
  assert.equal(SITE.pageWait({ waitMs: 300000 }, 20000), 300000, "site.js renders: the site's wait, up to 5 min");
  assert.equal(SITE.pageWait({}, 20000), 20000);
  const siteSrc = readFileSync("src/utils/customServers/site.js", "utf8");
  assert.doesNotMatch(siteSrc, /net\.render\([^)]*timeoutMs:\s*\d/, "no literal render timeouts in site.js");
});

test("engine: generic page titles are neutral, real other titles still fail", async () => {
  const { checkTitle } = await import("../src/utils/customServers/direct.js");
  const eq2 = { title: "The Equalizer 2", kind: "movie" };
  assert.equal(checkTitle("Fly Stream - Now Playing", eq2, ["Flystream", "flystream"]), "unknown", "site name written apart + Now Playing");
  assert.equal(checkTitle("Now Playing", eq2, []), "unknown");
  assert.equal(checkTitle("Quick check · Site", eq2, ["Site"]), "unknown");
  assert.equal(checkTitle("Watch Stream Player", eq2, []), "unknown");
  assert.equal(checkTitle("Watch Inception (2010) - Fly Stream", { title: "Inception", kind: "movie" }, ["flystream"]), "match", "the title next to the site's name still matches");
  assert.equal(checkTitle("Watch The Dark Knight Rises Online", eq2, []), "mismatch", "a page naming another title still fails");
  // pageSteps adds the page's / link's domain name as a site word.
  const steps = CS.pageSteps({ page: { ok: true, status: 200, title: "Fly Stream - Now Playing", url: "https://flystream.net/movie/345887" }, stream: { ok: true, url: "https://cdn.test/a.m3u8" }, playable: { ok: true } }, { title: "The Equalizer 2", want: eq2, site: "Movies site", link: "https://flystream.net/movie/345887" });
  const t = steps.find((x) => x.id === "title");
  assert.equal(t.ok, true);
  assert.equal(t.neutral, true);
  assert.equal(t.detail, "The page doesn't name the title");
});

test("engine: sniffed stream bodies are checked (#EXTM3U / media bytes) and the next link is tried", async () => {
  const { readFileSync } = await import("node:fs");
  const cs = readFileSync("ios/App/App/CustomServers.swift", "utf8");
  const sp = readFileSync("ios/App/App/StreambertPlayer.swift", "utf8");
  assert.match(cs, /enum StreamProbe/);
  assert.match(cs, /hasPrefix\("#EXTM3U"\)/, "a playlist must start with #EXTM3U");
  assert.match(cs, /answered with a web page/);
  assert.match(cs, /answered with JSON/);
  assert.match(cs, /1718449215/, "'fmt?' named in words");
  // PlayabilityCheck (Test + Direct checks) probes the body before AVPlayer.
  assert.match(cs, /func run\(url: URL[^]*?StreamProbe\.check\(url/);
  // Test: every link the page fetched is tried in order.
  assert.match(cs, /\[r\.url\] \+ Array\(r\.alternates\.prefix\(\d+\)\)/);
  // Player: the first link whose body is a stream is played.
  assert.match(sp, /StreamProbe\.firstGood\(urls/);
  // Alternates carry every other sniffed link (files too), deduplicated, not only playlists.
  assert.match(sp, /let ordered = hls \+ streams\.filter/);
  // No site names in engine logic.
  for (const name of ["flystream", "basementx", "movy.sx", "fmfau"]) {
    const probe = cs.slice(cs.indexOf("enum StreamProbe"), cs.indexOf("// MARK: - Playability check"));
    assert.ok(!probe.toLowerCase().includes(name), `${name} not in StreamProbe`);
  }
});
