// Dev-only: Kids profile content filter (rules, TMDB lists, every surface).
// Run: npm run test:ios (bundled with esbuild, uses happy-dom). Not shipped.
import assert from "node:assert/strict";
import fs from "node:fs";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Node", "Event", "KeyboardEvent", "MouseEvent", "localStorage", "sessionStorage", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]) {
  try { globalThis[k] = win[k]; } catch { Object.defineProperty(globalThis, k, { value: win[k], configurable: true }); }
}
globalThis.window = win;
win.electron = undefined;

// ── Fake TMDB: certifications per title, list endpoints, call log ──────────
const MOVIE_CERT = { 1: "G", 2: "PG", 3: "PG-13", 4: "R", 5: "NC-17", 6: "", 7: "NR", 8: null /* no US entry */ };
const TV_CERT = { 11: "TV-Y", 12: "TV-Y7", 13: "TV-G", 14: "TV-PG", 15: "TV-14", 16: "TV-MA", 17: "", 18: null, 19: "TV-Y7-FV" };
const movie = (id) => ({ id, title: `Movie ${id}`, media_type: "movie", poster_path: `/m${id}.jpg`, backdrop_path: `/mb${id}.jpg`, genre_ids: [16] });
const show = (id) => ({ id, name: `Show ${id}`, media_type: "tv", poster_path: `/t${id}.jpg`, backdrop_path: `/tb${id}.jpg`, genre_ids: [16] });
const ALL_MOVIES = Object.keys(MOVIE_CERT).map(Number).map(movie);
const ALL_SHOWS = Object.keys(TV_CERT).map(Number).map(show);
const strip = (list) => list.map(({ media_type, ...r }) => r);

const urls = [];
function body(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/^\/3/, "");
  let m;
  if ((m = p.match(/^\/movie\/(\d+)\/release_dates$/))) {
    const c = MOVIE_CERT[m[1]];
    return { id: +m[1], results: c === null ? [{ iso_3166_1: "GB", release_dates: [{ type: 3, certification: "U" }] }] : [{ iso_3166_1: "US", release_dates: [{ type: 4, certification: "" }, { type: 3, certification: c }] }] };
  }
  if ((m = p.match(/^\/tv\/(\d+)\/content_ratings$/))) {
    const c = TV_CERT[m[1]];
    return { id: +m[1], results: c === null ? [{ iso_3166_1: "DE", rating: "0" }] : [{ iso_3166_1: "US", rating: c }] };
  }
  if (p === "/search/multi") return { results: [...ALL_MOVIES, ...ALL_SHOWS, { id: 99, name: "Some Actor", media_type: "person" }] };
  if (/^\/(trending\/movie\/week|movie\/popular|movie\/top_rated|movie\/now_playing|discover\/movie|movie\/\d+\/recommendations)$/.test(p)) return { results: strip(ALL_MOVIES) };
  if (/^\/(trending\/tv\/week|tv\/popular|tv\/top_rated|discover\/tv|tv\/\d+\/similar)$/.test(p)) return { results: strip(ALL_SHOWS) };
  if (p === "/trending/all/week") return { results: [...ALL_MOVIES, ...ALL_SHOWS] };
  if (/^\/collection\/\d+$/.test(p)) return { id: 1, name: "C", parts: strip(ALL_MOVIES) };
  if ((m = p.match(/^\/movie\/(\d+)$/))) return movie(+m[1]);
  if ((m = p.match(/^\/tv\/(\d+)$/))) return show(+m[1]);
  return {};
}
globalThis.fetch = win.fetch = async (url) => {
  urls.push(String(url));
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body(String(url)) };
};

const K = await import("../src/platform/ios/kids/kidsFilter.js");
const { setActiveProfileScope } = await import("../src/utils/profileScope.js");
const { tmdbFetch, readTrendingCache, saveTrendingCache } = await import("../src/utils/api.js");

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log("ok -", name); };
const ids = (list) => list.map((i) => i.id).sort((a, b) => a - b);

// ── Rules ──────────────────────────────────────────────────────────────────
await t("movies: G and PG allowed; PG-13, R, NC-17 blocked", () => {
  for (const c of ["G", "PG", " pg ", "g"]) assert.equal(K.isCertAllowed("movie", c), true, c);
  for (const c of ["PG-13", "R", "NC-17", "TV-G", "TV-Y", "X"]) assert.equal(K.isCertAllowed("movie", c), false, c);
});
await t("shows: TV-Y, TV-Y7 (incl. -FV), TV-G allowed; TV-PG, TV-14, TV-MA blocked", () => {
  for (const c of ["TV-Y", "TV-Y7", "TV-G", "tv-y7-fv"]) assert.equal(K.isCertAllowed("tv", c), true, c);
  for (const c of ["TV-PG", "TV-14", "TV-MA", "G", "PG"]) assert.equal(K.isCertAllowed("tv", c), false, c);
});
await t("unrated is hidden: empty, NR, Not Rated, Unrated, null", () => {
  for (const c of ["", "  ", "NR", "Not Rated", "unrated", null, undefined]) {
    assert.equal(K.isCertAllowed("movie", c), false, String(c));
    assert.equal(K.isCertAllowed("tv", c), false, String(c));
  }
});
await t("anime (HiAnime/MAL ratings): G and PG only", () => {
  for (const r of ["G - All Ages", "PG - Children", "G", "PG"]) assert.equal(K.isAnimeRatingAllowed(r), true, r);
  for (const r of ["PG-13 - Teens 13 or older", "PG13", "R - 17+ (violence & profanity)", "R+ - Mild Nudity", "Rx - Hentai", "", null]) assert.equal(K.isAnimeRatingAllowed(r), false, String(r));
});
await t("US certification is read from TMDB release_dates / content_ratings", () => {
  assert.equal(K.movieCertFromReleaseDates(body("https://x/3/movie/2/release_dates")), "PG");
  assert.equal(K.movieCertFromReleaseDates(body("https://x/3/movie/8/release_dates")), null, "no US entry = unrated");
  assert.equal(K.movieCertFromReleaseDates(body("https://x/3/movie/7/release_dates")), null, "NR = unrated");
  assert.equal(K.tvCertFromContentRatings(body("https://x/3/tv/12/content_ratings")), "TV-Y7");
  assert.equal(K.tvCertFromContentRatings(body("https://x/3/tv/18/content_ratings")), null);
});
await t("discover asks TMDB for kid certifications and no adult titles", () => {
  const m = K.kidsRewritePath("/discover/movie?with_genres=16&page=1");
  assert.match(m, /certification_country=US/);
  assert.match(m, /certification=G%7CPG(&|$)/);
  assert.match(m, /include_adult=false/);
  const tv = K.kidsRewritePath("/discover/tv?with_genres=16");
  assert.match(tv, /certification=TV-Y%7CTV-Y7%7CTV-G/);
  assert.match(K.kidsRewritePath("/search/multi?query=a"), /include_adult=false/);
  assert.equal(K.kidsRewritePath("/movie/550"), "/movie/550");
});

// ── TMDB client: every title list is filtered on a Kids profile ─────────────
const ALLOWED_MOVIES = [1, 2];
const ALLOWED_SHOWS = [11, 12, 13, 19];

await t("adult profile: lists unchanged", async () => {
  setActiveProfileScope({ id: "a", kids: false });
  const r = await tmdbFetch("/movie/popular?page=1", "tok");
  assert.equal(r.results.length, ALL_MOVIES.length);
  assert.ok(!urls.some((u) => /release_dates|content_ratings/.test(u)), "no rating lookups for adults");
});

setActiveProfileScope({ id: "k", kids: true });
const LISTS = [
  ["/trending/movie/week", "results", ALLOWED_MOVIES],
  ["/trending/tv/week", "results", ALLOWED_SHOWS],
  ["/movie/popular?page=1", "results", ALLOWED_MOVIES],
  ["/movie/now_playing?page=1", "results", ALLOWED_MOVIES],
  ["/movie/top_rated?page=1", "results", ALLOWED_MOVIES],
  ["/tv/popular?page=1", "results", ALLOWED_SHOWS],
  ["/tv/top_rated?page=1", "results", ALLOWED_SHOWS],
  ["/discover/movie?with_genres=16&with_original_language=ja", "results", ALLOWED_MOVIES],
  ["/discover/tv?with_genres=16&with_origin_country=JP", "results", ALLOWED_SHOWS],
  ["/movie/5/recommendations", "results", ALLOWED_MOVIES],
  ["/tv/5/similar", "results", ALLOWED_SHOWS],
  ["/search/multi?query=x&page=1", "results", [...ALLOWED_MOVIES, ...ALLOWED_SHOWS]],
  ["/trending/all/week", "results", [...ALLOWED_MOVIES, ...ALLOWED_SHOWS]],
  ["/collection/10", "parts", ALLOWED_MOVIES],
];
for (const [path, key, want] of LISTS) {
  await t(`kids: ${path.split("?")[0]} keeps only kid-rated titles`, async () => {
    const r = await tmdbFetch(path, "tok");
    assert.deepEqual(ids(r[key]), [...want].sort((a, b) => a - b));
  });
}
await t("kids: discover requests carry the certification params", () => {
  assert.ok(urls.some((u) => u.includes("/discover/movie") && u.includes("certification=G%7CPG") && u.includes("include_adult=false")));
  assert.ok(urls.some((u) => u.includes("/discover/tv") && u.includes("certification=TV-Y%7CTV-Y7%7CTV-G")));
  assert.ok(urls.some((u) => u.includes("/search/multi") && u.includes("include_adult=false")));
});
await t("kids: a failed rating lookup hides the title", async () => {
  K.clearKidsCertCache();
  const fail = async () => { throw new Error("offline"); };
  assert.deepEqual(await K.filterKidsItems([movie(1), show(11)], fail), []);
});
await t("kids: trending cache from an older filter version is not reused", () => {
  saveTrendingCache("en-US", [movie(1)], []);
  assert.ok(readTrendingCache("en-US"));
  const raw = JSON.parse(localStorage.getItem("streambert_trendingCache"));
  raw.kv = 1;
  localStorage.setItem("streambert_trendingCache", JSON.stringify(raw));
  assert.equal(readTrendingCache("en-US"), null);
});

// ── React surfaces (happy-dom) ──────────────────────────────────────────────
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
globalThis.IS_REACT_ACT_ENVIRONMENT = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (ms = 0) => act(async () => { await sleep(ms); });
const mountEl = async (el) => {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return { host, root };
};

await t("kids: Search shows only kid-rated results (no people, no unrated)", async () => {
  const { default: SearchModal } = await import("../src/components/SearchModal.jsx");
  const { host, root } = await mountEl(React.createElement(SearchModal, { apiKey: "tok", onSelect() {}, onClose() {}, offline: false }));
  const input = host.querySelector("input.search-input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(input, "cartoon");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  await flush(500);
  await flush(50);
  const titles = [...host.querySelectorAll(".search-result-title")].map((n) => n.textContent).sort();
  assert.deepEqual(titles, ["Movie 1", "Movie 2", "Show 11", "Show 12", "Show 13", "Show 19"]);
  root.unmount();
});

const { default: KidsTitleGate } = await import("../src/platform/ios/kids/KidsTitleGate.jsx");
const gate = async (type, id) => {
  const { host, root } = await mountEl(
    React.createElement(KidsTitleGate, { item: { id }, type, apiKey: "tok", onBack() {} }, React.createElement("div", { className: "page" }, "PLAYING")),
  );
  await flush(30);
  const out = { page: !!host.querySelector(".page"), blocked: !!host.querySelector(".kids-blocked") };
  root.unmount();
  return out;
};
await t("kids: title pages (direct navigation) open only for kid-rated titles", async () => {
  K.clearKidsCertCache();
  for (const id of Object.keys(MOVIE_CERT).map(Number)) {
    const g = await gate("movie", id);
    assert.equal(g.page, ALLOWED_MOVIES.includes(id), `movie ${id} (${MOVIE_CERT[id]})`);
    assert.equal(g.blocked, !ALLOWED_MOVIES.includes(id));
  }
  for (const id of Object.keys(TV_CERT).map(Number)) {
    const g = await gate("tv", id);
    assert.equal(g.page, ALLOWED_SHOWS.includes(id), `tv ${id} (${TV_CERT[id]})`);
  }
});
await t("adult profile: the title gate never blocks", async () => {
  setActiveProfileScope({ id: "a", kids: false });
  assert.equal((await gate("movie", 4)).page, true);
  setActiveProfileScope({ id: "k", kids: true });
});

await t("kids: Home rails, billboard, Continue Watching hide unverified titles", async () => {
  K.clearKidsCertCache();
  const HS = await import("../src/platform/ios/HomeSections.jsx");
  const items = [...ALL_MOVIES, ...ALL_SHOWS];
  const common = { onSelect() {}, watched: {}, apiKey: "tok" };
  for (const [C, props, sel] of [
    [HS.PosterRail, { title: "R", items }, ".sb-row-item"],
    [HS.RankRail, { title: "R", items }, ".sb-rank-item"],
    [HS.WideRail, { title: "R", items, progress: {} }, ".sb-wide-item"],
  ]) {
    const { host, root } = await mountEl(React.createElement(C, { ...common, ...props }));
    await flush(40);
    const n = host.querySelectorAll(sel).length;
    const want = sel === ".sb-rank-item" ? Math.min(10, 6) : 6;
    assert.equal(n, want, `${C.name}: ${n}`);
    root.unmount();
  }
  const { host, root } = await mountEl(React.createElement(HS.Billboard, { ...common, items: [movie(4), movie(3), movie(7)] }));
  await flush(40);
  assert.equal(host.querySelector(".sb-bill"), null, "billboard showed unrated/PG-13/R");
  root.unmount();
});

await t("kids: Downloads list only shows verified kid-rated downloads", async () => {
  const { useKidsFilter } = await import("../src/platform/ios/kids/useKidsFilter.js");
  const dls = [
    { id: "a", tmdbId: 1, mediaType: "movie", name: "G film" },
    { id: "b", tmdbId: 4, mediaType: "movie", name: "R film" },
    { id: "c", tmdbId: 12, mediaType: "tv", name: "Y7 show" },
    { id: "d", tmdbId: 14, mediaType: "tv", name: "TV-PG show" },
    { id: "e", name: "local file, no TMDB id" },
  ];
  let seen = null;
  function Probe() { seen = useKidsFilter(dls); return null; }
  const { root } = await mountEl(React.createElement(Probe));
  await flush(40);
  assert.deepEqual(seen.map((d) => d.id), ["a", "c"]);
  root.unmount();
});

// ── Every surface goes through the kids module (static wiring check) ───────
await t("every surface uses the kids filter", () => {
  const src = (f) => fs.readFileSync(`${process.cwd()}/${f}`, "utf8");
  const need = {
    "src/utils/api.js": [/filterKidsResponse\(/, /kidsRewritePath\(/, /kv: KIDS_FILTER_VERSION/],
    "src/App.jsx": [/<KidsTitleGate item=\{selected\} type="movie"/, /<KidsTitleGate item=\{selected\} type="tv"/, /isKidsAllowedNow\(/],
    "src/pages/HomePage.jsx": [/useKidsFilter\(trendingAll/, /useKidsFilter\(trendingTVAll/, /useKidsFilter\(inProgressAll/],
    "src/platform/ios/HomeSections.jsx": [/PosterRail[\s\S]*?useKidsFilter\(items\)/, /RankRail[\s\S]*?useKidsFilter\(all\)/, /WideRail[\s\S]*?useKidsFilter\(all\)/, /Billboard[\s\S]*?useKidsFilter\(all, apiKey\)/, /WideBackdropRail[\s\S]*?useKidsFilter\(all\)/],
    "src/pages/LibraryPage.jsx": [/useKidsFilter\(historyAll\)/, /useKidsFilter\(inProgressAll\)/, /useKidsFilter\(savedAll\)/],
    "src/pages/DownloadsPage.jsx": [/useKidsFilter\(props\.downloads\)/, /downloads=\{downloads\}/],
    "src/components/SearchModal.jsx": [/useKidsFilter\(rawResults/],
    "src/platform/ios/shim.js": [/resolveHiAnime:[\s\S]*?isKidsProfileActive\(\)/],
    "src/utils/kidsFilter.js": [/platform\/ios\/kids\/kidsFilter/],
  };
  for (const [f, res] of Object.entries(need)) for (const re of res) assert.match(src(f), re, `${f} lacks ${re}`);
  // No surface may call the old genre-only filter directly.
  for (const f of ["src/utils/api.js", "src/platform/ios/HomeSections.jsx", "src/components/SearchModal.jsx"])
    assert.doesNotMatch(src(f), /filterKidSafeResults/, f);
});

console.log(`\n${pass} kids filter tests passed`);
await win.happyDOM.close();
process.exit(0);
