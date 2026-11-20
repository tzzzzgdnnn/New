// Dev-only: custom servers, Direct mode and smart add. Request templates and
// response paths learned from what a page did, endpoints found in scripts,
// title checks, embed families and slug styles. Not bundled.
import assert from "node:assert/strict";
import { test } from "node:test";

const D = await import("../src/utils/customServers/direct.js");
const F = await import("../src/utils/customServers/families.js");
const T = await import("../src/utils/customServers/template.js");

const inception = { tmdb: 27205, imdb: "tt1375666", title: "Inception", year: 2010, season: 1, episode: 1, lang: "sub" };
const got = { tmdb: 1399, imdb: "tt0944947", title: "Game of Thrones", year: 2011, season: 2, episode: 5, lang: "sub" };
const onePiece = { anilist: 21, mal: 21, title: "One Piece", year: 1999, season: 1, episode: 7, lang: "dub" };
const STREAM = "https://cdn.example/hls/abc123/master.m3u8?t=99";

// ── Response paths ───────────────────────────────────────────────────────

test("findPath / getPath: dot and index paths", () => {
  const json = { data: { sources: [{ file: "x" }, { file: STREAM }] } };
  const path = D.findPath(json, (s) => s === STREAM);
  assert.equal(path, "data.sources.1.file");
  assert.equal(D.getPath(json, path), STREAM);
  assert.equal(D.getPath(json, "data.nope.0"), undefined);
  assert.deepEqual(D.splitPath("a.0.b"), ["a", 0, "b"]);
});

test("extractorFor: JSON path to the played stream, escaped slashes, other tokens", () => {
  const text = JSON.stringify({ ok: true, result: { url: STREAM.replace("t=99", "t=100") } });
  assert.deepEqual(D.extractorFor(text, STREAM), { type: "path", path: "result.url" });
  const escaped = '{"stream":"https:\\/\\/cdn.example\\/hls\\/abc123\\/master.m3u8"}';
  assert.deepEqual(D.extractorFor(escaped, STREAM), { type: "path", path: "stream" });
  // Not JSON: regex.
  assert.equal(D.extractorFor(`var src = "${STREAM}";`, STREAM).type, "regex");
  // A list of sources when the played stream isn't known.
  assert.deepEqual(D.extractorFor(JSON.stringify({ sources: [{ label: "1080p", src: "https://c/a.m3u8" }] }), null), { type: "path", path: "sources.0.src" });
  assert.equal(D.extractorFor('{"error":"not found"}', STREAM), null);
});

test("extractStream: path, regex, relative links, broken regex", () => {
  const api = "https://api.example/v1/source/27205";
  assert.equal(D.extractStream('{"data":{"file":"/hls/x/master.m3u8"}}', { type: "path", path: "data.file" }, api), "https://api.example/hls/x/master.m3u8");
  assert.equal(D.extractStream(`<script>p("${STREAM}")</script>`, { type: "regex", pattern: D.DEFAULT_STREAM_PATTERN }, api), STREAM);
  assert.equal(D.extractStream("file: 'https://c/x.mp4'", { type: "regex", pattern: "file:\\s*'([^']+)'" }, api), "https://c/x.mp4");
  assert.equal(D.extractStream("x", { type: "regex", pattern: "([" }, api), null);
  assert.equal(D.extractStream('{"data":{"file":42}}', { type: "path", path: "data.file" }, api), null);
});

// ── Request templates ────────────────────────────────────────────────────

test("templatizeRequest: ids, season / episode in path and query", () => {
  const tv = D.templatizeRequest({ url: "https://api.site.tv/api/source/1399?s=2&e=5", page: "https://embed.site.tv/tv/1399/2/5" }, got, "tv");
  assert.equal(tv.url, "https://api.site.tv/api/source/{tmdb}?s={season}&e={episode}");
  assert.equal(tv.headers.Referer, "https://embed.site.tv/");
  assert.equal(tv.headers.Origin, "https://embed.site.tv");
  const mv = D.templatizeRequest({ url: "https://site.tv/ajax/movie/tt1375666/sources", method: "get" }, inception, "movie");
  assert.equal(mv.url, "https://site.tv/ajax/movie/{imdb}/sources");
  assert.equal(mv.method, "GET");
  const no = D.templatizeRequest({ url: "https://site.tv/api/config" }, inception, "movie");
  assert.match(no.error, /id/);
});

test("templatizeBody: JSON and form bodies, keyed season / episode only", () => {
  assert.equal(D.templatizeBody('{"id":1399,"season":"2","episode":5,"page":2}', got, "tv"), '{"id":{tmdb},"season":"{season}","episode":{episode},"page":2}');
  assert.equal(D.templatizeBody("id=27205&type=movie&y=2010", inception, "movie"), "id={tmdb}&type=movie&y={year}");
  assert.equal(D.templatizeBody("", inception, "movie"), null);
});

test("buildDirectRequest fills url and body; a missing value gives null", () => {
  const def = { url: "https://api/x/{tmdb}", method: "POST", headers: { Referer: "https://s/" }, body: '{"id":{tmdb},"s":{season},"e":{episode},"q":"{title}"}' };
  const r = D.buildDirectRequest(def, { ...got, title: 'Say "Hi"' });
  assert.equal(r.url, "https://api/x/1399");
  assert.equal(r.body, '{"id":1399,"s":2,"e":5,"q":"Say \\"Hi\\""}');
  assert.equal(D.buildDirectRequest({ url: "https://api/{imdb}" }, { tmdb: 1 }), null);
});

test("signedReason / looksEncrypted: tokens, auth headers and sealed answers", () => {
  assert.match(D.signedReason({ url: "https://a/api/1399?vrf=abcdefgh123" }), /signs/);
  assert.match(D.signedReason({ url: "https://a/api/1399", headers: { Authorization: "Bearer x" } }), /Authorization/);
  assert.match(D.signedReason({ url: "https://a/api/1399?k=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA" }), /token/);
  assert.equal(D.signedReason({ url: "https://a/api/tt1375666?s=1&e=2" }), null);
  const blob = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7919) % 251)).toString("base64");
  assert.equal(D.looksEncrypted(JSON.stringify({ data: blob })), true);
  assert.equal(D.looksEncrypted(JSON.stringify({ file: STREAM })), false);
});

test("learnFromLog: picks the answer that held the stream, skips assets", () => {
  const log = {
    requests: [
      { url: "https://embed.site.tv/app.js", status: 200, text: `x="${STREAM}"` },
      { url: "https://embed.site.tv/api/config", status: 200, text: '{"theme":"dark"}' },
      { url: "https://embed.site.tv/api/source/1399/2/5", method: "GET", status: 200, page: "https://embed.site.tv/tv/1399/2/5", text: JSON.stringify({ data: { playlist: STREAM } }) },
    ],
  };
  const r = D.learnFromLog(log, { stream: STREAM, values: got, kind: "tv" });
  assert.equal(r.ok, true);
  assert.equal(r.matched, "stream");
  assert.equal(r.def.url, "https://embed.site.tv/api/source/{tmdb}/{season}/{episode}");
  assert.deepEqual(r.def.extract, { type: "path", path: "data.playlist" });
  // Replay for another title.
  const req = D.buildDirectRequest(r.def, { ...got, tmdb: 1396, season: 1, episode: 3 });
  assert.equal(req.url, "https://embed.site.tv/api/source/1396/1/3");
});

test("learnFromLog: signed and encrypted APIs say so", () => {
  const signed = D.learnFromLog({ requests: [{ url: "https://s/api/1399/2/5?token=abcdefghijklmnopqrstuvwxyz123", status: 200, text: JSON.stringify({ u: STREAM }) }] }, { stream: STREAM, values: got, kind: "tv" });
  assert.equal(signed.ok, false);
  assert.equal(signed.signed, true);
  const blob = Buffer.from(Array.from({ length: 400 }, (_, i) => (i * 7919) % 251)).toString("base64");
  const enc = D.learnFromLog({ requests: [{ url: "https://s/api/1399", status: 200, text: JSON.stringify({ data: blob }) }] }, { stream: STREAM, values: got, kind: "tv" });
  assert.equal(enc.encrypted, true);
  assert.match(enc.reason, /encrypts/);
  assert.match(D.learnFromLog({ requests: [] }, { stream: STREAM, values: got, kind: "tv" }).reason, /no API calls/);
});

// ── Script endpoints ─────────────────────────────────────────────────────

test("scanEndpoints: template literals, concatenation, trailing slash", () => {
  const js = [
    "fetch(`/api/tv/${a.id}/${s}/${e}`)",
    'n.get("/ajax/sources/"+t.id+"/"+r+"/"+i)',
    'const B="https://api.site.tv/v2/movie/";',
    'loadScript("/static/app.css")',
  ].join(";");
  const p = D.scanEndpoints(js);
  assert.ok(p.includes("/api/tv/\0/\0/\0"));
  assert.ok(p.includes("/ajax/sources/\0/\0/\0"));
  assert.ok(p.includes("https://api.site.tv/v2/movie/\0"));
  assert.equal(p.some((x) => x.includes("app.css")), false);
});

test("endpointCandidates: fills holes per kind, keeps the right kind", () => {
  const pats = ["/api/tv/\0/\0/\0", "https://api.site.tv/v2/movie/\0", "/api/\0/\0"];
  const tv = D.endpointCandidates(pats, ["https://site.tv"], "tv", got);
  assert.ok(tv.includes("https://site.tv/api/tv/{tmdb}/{season}/{episode}"));
  assert.equal(tv.some((u) => u.includes("/movie/")), false);
  const mv = D.endpointCandidates(pats, ["https://site.tv"], "movie", inception);
  assert.ok(mv.includes("https://api.site.tv/v2/movie/{tmdb}"));
  assert.ok(mv.includes("https://api.site.tv/v2/movie/{imdb}"));
  assert.ok(mv.includes("https://site.tv/api/movie/{tmdb}"));
  assert.ok(mv.length <= D.MAX_SCRIPT_CANDIDATES);
  assert.equal(D.scanWorthy("https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"), false);
  assert.equal(D.scanWorthy("https://site.tv/assets/player.4f2a.js"), true);
});

// ── Title checks ─────────────────────────────────────────────────────────

test("checkTitle: match, mismatch and generic page titles", () => {
  const want = { title: "Inception", year: 2010 };
  assert.equal(D.checkTitle("Watch Inception (2010) Online Free - VidSite", want, ["vidsite"]), "match");
  assert.equal(D.checkTitle("Watch The Dark Knight Rises Online", want), "mismatch");
  assert.equal(D.checkTitle("VidSite Player", want, ["VidSite"]), "unknown");
  assert.equal(D.checkTitle("", want), "unknown");
  assert.equal(D.checkTitle("Game of Thrones S2E5 - The Ghost of Harrenhal", { title: "Game of Thrones" }), "match");
});

test("checkAnswer: ids first, then a movie's title", () => {
  const want = { kind: "movie", tmdb: 27205, imdb: "tt1375666", title: "Inception" };
  assert.equal(D.checkAnswer(JSON.stringify({ tmdb_id: 27205, file: STREAM }), want), "match");
  assert.equal(D.checkAnswer(JSON.stringify({ data: { tmdbId: "155" } }), want), "mismatch");
  assert.equal(D.checkAnswer(JSON.stringify({ imdb: "tt0468569" }), want), "mismatch");
  assert.equal(D.checkAnswer(JSON.stringify({ title: "The Dark Knight Rises Extended" }), want), "mismatch");
  assert.equal(D.checkAnswer(JSON.stringify({ file: STREAM }), want), "unknown");
  assert.equal(D.checkAnswer("not json", want), "unknown");
});

test("validateDirect and header lines", () => {
  assert.equal(D.validateDirect({ url: "https://a/api/{tmdb}", extract: { type: "path", path: "data.file" } }), null);
  assert.match(D.validateDirect({ url: "https://a/api", extract: { type: "path", path: "x" } }), /needs/);
  assert.match(D.validateDirect({ url: "https://a/{tmdb}", extract: { type: "regex", pattern: "(" } }), /regex/);
  assert.match(D.validateDirect({ url: "https://a/{tmdb}", extract: { type: "path", path: "" } }), /path/);
  assert.deepEqual(D.parseHeaderLines("Referer: https://a/\nbad line\nX-Requested-With: XMLHttpRequest"), { Referer: "https://a/", "X-Requested-With": "XMLHttpRequest" });
  assert.equal(D.headerLines({ A: "1", B: "2" }), "A: 1\nB: 2");
  assert.deepEqual(D.safeHeaders({ Cookie: "x", Accept: "application/json", Authorization: "y" }), { Accept: "application/json" });
});

// ── Embed families (smart add) ───────────────────────────────────────────

test("embedFamily: path and query layouts", () => {
  assert.deepEqual(F.embedFamily("https://vidsrc.xyz/embed/movie/{tmdb}"), { family: "path", kind: "movie", at: 2 });
  assert.equal(F.embedFamily("https://v.tv/embed/tv/{tmdb}/{season}/{episode}").kind, "tv");
  assert.equal(F.embedFamily("https://v.tv/embed?tmdb={tmdb}&type=movie").family, "query");
  assert.equal(F.embedFamily("https://v.tv/embed/tv?id={tmdb}&s={season}&e={episode}").family, "query");
  assert.equal(F.embedFamily("https://v.tv/watch/{slug}-{year}"), null);
});

test("familyTemplate: vidsrc-style path links for every kind", () => {
  const mv = "https://vidsrc.xyz/embed/movie/{tmdb}";
  assert.equal(F.familyTemplate(mv, "tv"), "https://vidsrc.xyz/embed/tv/{tmdb}/{season}/{episode}");
  assert.equal(F.familyTemplate(mv, "anime"), "https://vidsrc.xyz/embed/anime/{anilist}/{episode}/{lang}");
  assert.equal(F.familyTemplate("https://v.tv/movies/{imdb}", "tv"), "https://v.tv/series/{imdb}/{season}/{episode}");
  assert.equal(F.familyTemplate("https://v.tv/embed/tv/{tmdb}/{season}/{episode}?autoplay=1", "movie"), "https://v.tv/embed/movie/{tmdb}?autoplay=1");
  assert.equal(F.familyTemplate("https://v.tv/anime/{anilist}/{episode}/{lang}", "movie"), "https://v.tv/movie/{tmdb}");
  assert.equal(F.familyTemplate("https://v.tv/anime/{anilist}/{episode}/{lang}", "tv"), "https://v.tv/tv/{tmdb}/{season}/{episode}");
});

test("familyTemplate: ?s=&e= query links", () => {
  assert.equal(F.familyTemplate("https://v.tv/embed?tmdb={tmdb}&type=movie", "tv"), "https://v.tv/embed?tmdb={tmdb}&type=tv&season={season}&episode={episode}");
  assert.equal(F.familyTemplate("https://v.tv/embed/tv?id={tmdb}&s={season}&e={episode}", "movie"), "https://v.tv/embed/movie?id={tmdb}");
  assert.equal(F.familyTemplate("https://v.tv/embed?id={tmdb}&type=tv&s={season}&e={episode}", "anime"), "https://v.tv/embed?id={anilist}&type=anime&e={episode}&lang={lang}");
});

test("fillFromFamily fills missing kinds and marks them guessed; idScheme in words", () => {
  const r = F.fillFromFamily({ movie: "https://vidsrc.xyz/embed/movie/{tmdb}" });
  assert.equal(r.templates.tv, "https://vidsrc.xyz/embed/tv/{tmdb}/{season}/{episode}");
  assert.deepEqual(r.guessed, { tv: true, anime: true });
  assert.ok(r.family);
  assert.equal(F.fillFromFamily({ movie: "https://v.tv/watch/{slug}" }).family, null);
  assert.equal(F.idScheme({ movie: "https://a/{tmdb}", anime: "https://a/{anilist}/{episode}" }), "TMDB + AniList ids");
  assert.equal(F.idScheme({ movie: "https://a/{slug}-{year}" }), "titles in the link");
  assert.equal(F.hasLang("https://a/{anilist}/{episode}/{lang}"), true);
});

// ── TMDB ids and slugs ───────────────────────────────────────────────────

test("slug styles are learned from the sample and reused for other titles", () => {
  assert.deepEqual(T.slugStyleFrom("the-dark-knight"), { sep: "-", case: "lower" });
  assert.deepEqual(T.slugStyleFrom("The_Dark_Knight"), { sep: "_", case: "title" });
  assert.deepEqual(T.slugStyleFrom("THE+DARK+KNIGHT"), { sep: "+", case: "upper" });
  assert.equal(T.slugify("Spider-Man: No Way Home", { sep: "_", case: "title" }), "Spider_Man_No_Way_Home");
  assert.equal(T.slugify("Amélie", { sep: ".", case: "lower" }), "amelie");
  assert.equal(T.slugify("Ocean's Eleven"), "oceans-eleven");
  const d = T.detectTemplate("https://site.tv/watch/The_Dark_Knight_2008", { kind: "movie", ids: { tmdb: 155 }, title: "The Dark Knight", year: 2008 });
  assert.equal(d.template, "https://site.tv/watch/{slug}_{year}");
  assert.deepEqual(d.slugStyle, { sep: "_", case: "title" });
  assert.equal(T.buildUrl(d.template, { title: "Inception", year: 2010, slugStyle: d.slugStyle }), "https://site.tv/watch/Inception_2010");
});

test("TMDB ids fill every id placeholder; {absolute} for absolute episode numbering", () => {
  const tpl = "https://a/{tmdb}/{imdb}/{season}/{episode}";
  assert.equal(T.buildUrl(tpl, got), "https://a/1399/tt0944947/2/5");
  assert.equal(T.buildUrl("https://a/anime/{anilist}/{mal}/{episode}/{lang}", onePiece), "https://a/anime/21/21/7/dub");
  assert.equal(T.buildUrl("https://a/tv/{tmdb}/{absolute}", { tmdb: 37854, absolute: 1000, episode: 3 }), "https://a/tv/37854/1000");
  assert.equal(T.buildUrl("https://a/tv/{tmdb}/{absolute}", { tmdb: 37854, episode: 3 }), "https://a/tv/37854/3");
  assert.equal(T.validateTemplate("https://a/tv/{tmdb}/{absolute}"), null);
});

// ── Crawling a site from its homepage (saved 7movies.ac pages) ───────────

const C = await import("../src/utils/customServers/crawl.js");
const fs = await import("node:fs");
// Read from the repo root (the runner bundles tests into node_modules/.cache).
const FIX = new URL("scripts/fixtures/custom-sites/7movies/", `file://${process.cwd()}/`);
const fixture = (name) => fs.readFileSync(new URL(name, FIX), "utf8");

/** Fake site: 7movies.ac as saved; every show page lists its episodes. */
const sevenMovies = async (url) => {
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

test("extractLinks: entities decoded, assets and account pages left out", () => {
  const links = C.extractLinks(fixture("tv-1421.html"), "https://7movies.ac/tv/1421");
  assert.ok(links.includes("https://7movies.ac/tv/1421/watch?season=1&episode=1"));
  assert.equal(links.some((l) => /_next|favicon|signin|watchlist/.test(l)), false);
  assert.equal(links.some((l) => !l.startsWith("https://7movies.ac/")), false);
});

test("robots, sitemap and rebasing a mirror domain", () => {
  assert.deepEqual(C.robotsSitemaps(fixture("robots.txt")), ["https://7movies.ws/sitemap.xml"]);
  const locs = C.sitemapLocs(fixture("sitemap.xml"));
  assert.ok(locs.some((l) => /\/movie\/\d+/.test(l)));
  assert.ok(C.rebase(locs, "https://7movies.ac").every((u) => u.startsWith("https://7movies.ac/")));
});

test("classifyLink: play links beat details and list pages", () => {
  const watch = C.classifyLink("https://7movies.ac/movie/1368337/watch");
  const details = C.classifyLink("https://7movies.ac/movie/1368337");
  const list = C.classifyLink("https://7movies.ac/movies/action/2");
  const ep = C.classifyLink("https://7movies.ac/tv/1421/watch?season=1&episode=3");
  assert.equal(watch.kind, "movie");
  assert.ok(watch.plays && !details.plays);
  assert.ok(watch.score > details.score && details.score > list.score);
  assert.ok(ep.episode && ep.kind === "tv");
  assert.equal(C.classifyLink("https://site.tv/anime/21/7/dub").episode, true);
  assert.equal(C.classifyLink("https://site.tv/watch/the-dark-knight-s01e05").episode, true);
});

test("pickSamples: a movie watch link, and a show page to open for its episodes", () => {
  const links = C.extractLinks(fixture("home.html"), "https://7movies.ac/");
  const { samples, follow } = C.pickSamples(links);
  assert.equal(samples.movie, "https://7movies.ac/movie/1368337/watch");
  assert.ok(follow.some((u) => /\/tv\/\d+$/.test(u)));
});

test("siteInfo: name and icon from the head", () => {
  const info = C.siteInfo(fixture("home.html"), "https://7movies.ac/");
  assert.equal(info.name, "7Movies");
  assert.match(info.icon, /^https:\/\/7movies\.ac\/(apple-touch-icon|favicon)/);
});

test("searchTemplate reads a GET search form", () => {
  const html = '<form action="/search" method="get"><input type="search" name="keyword"></form>';
  assert.equal(C.searchTemplate(html, "https://s.tv/"), "https://s.tv/search?keyword={query}");
  assert.equal(C.searchTemplate('<form method="post"><input name="q"></form>', "https://s.tv/"), null);
});

test("scanEndpoints reads bundler .concat() joins (7movies bundle)", () => {
  const p = D.scanEndpoints(fixture("bundle-excerpt.js"));
  assert.ok(p.includes("/api/tv/\0/season/\0"));
  assert.ok(p.includes("/api/downloads?\0"));
  const routes = C.routesFromScripts(['r.push("/movie/".concat(t.id,"/watch"));r.push("/tv/".concat(e,"/watch?season=").concat(s,"&episode=").concat(n))'], "https://x.tv");
  assert.deepEqual(routes.movie, ["https://x.tv/movie/{tmdb}/watch"]);
  assert.deepEqual(routes.tv, ["https://x.tv/tv/{tmdb}/watch?season={season}&episode={episode}"]);
});

test("crawlSite: 7movies.ac from its homepage finds movie and episode links", async () => {
  const steps = [];
  const r = await C.crawlSite("https://7movies.ac/", { http: sevenMovies, onStep: (id, state) => steps.push(`${id}:${state}`) });
  assert.equal(r.samples.movie, "https://7movies.ac/movie/1368337/watch");
  assert.match(r.samples.tv, /^https:\/\/7movies\.ac\/tv\/\d+\/watch\?season=1&episode=\d+$/);
  assert.equal(r.name, "7Movies");
  assert.deepEqual(steps, ["read:running", "read:done", "links:running", "links:done"]);
});
