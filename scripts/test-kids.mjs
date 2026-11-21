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
  // iPhone search is portaled to <body>; result tiles are posters (title = alt).
  const input = document.body.querySelector("input.search-input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(input, "cartoon");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  await flush(500);
  await flush(50);
  const titles = [...document.body.querySelectorAll(".nfs-grid .nfs-tile img")].map((n) => n.getAttribute("alt")).sort();
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

// ── Kids Home UI (Netflix Kids look) ─────────────────────────────────────────
await t("kids home: rows, genres and favorites helpers", async () => {
  const H = await import("../src/platform/ios/kids/kidsHomeRows.js");
  assert.deepEqual([...H.KIDS_HOME_ROWS], ["continue", "favorites", "myList", "watchAgain", "genres"]);
  for (const bad of ["/trending/all/week", "/movie/now_playing", "/movie/upcoming", "/movie/popular", "/tv/top_rated", "/tv/airing_today"])
    assert.match(bad, H.KIDS_HOME_BANNED, bad);
  for (const ok of ["/discover/movie", "/search/tv", "/tv/12"]) assert.doesNotMatch(ok, H.KIDS_HOME_BANNED, ok);
  const hist = [
    { id: 1, media_type: "movie", watchedAt: 1 },
    { id: 12, media_type: "tv", watchedAt: 5 },
    { id: 1, media_type: "movie", watchedAt: 9 },
  ];
  assert.deepEqual(H.historyTitles(hist).map((i) => `${i.media_type}_${i.id}`), ["movie_1", "tv_12"]);
  const chars = [{ key: "A::x", item: show(11) }, { key: "B::y", item: show(12) }, { key: "B::z", item: show(12) }];
  assert.deepEqual(H.favoriteShows(chars, ["B::y", "B::z", "A::x", "nope"]).map((i) => i.id), [12, 11]);
  assert.deepEqual(H.favoriteGenres([{ ...show(1), genre_ids: [10762] }, { ...show(2), genre_ids: [10762, 35] }], 2).map((g) => g.key), ["kids", "comedy"]);
  assert.deepEqual(H.favoriteGenres([], 3).map((g) => g.key), ["animation", "family"]);
  const kidsTv = H.KIDS_GENRES.find((g) => g.key === "kids");
  assert.deepEqual(H.genrePaths(kidsTv).map((p) => p.type), ["tv"]);
  // Discover genre rows still get the kids certifications from tmdbFetch.
  assert.match(K.kidsRewritePath(H.genrePaths(kidsTv)[0].path), /certification=TV-Y/);
});

await t("kids home: favorites are saved per profile; theme follows the profile", async () => {
  const C = await import("../src/platform/ios/kids/kidsCatalog.js");
  setActiveProfileScope({ id: "k2", kids: true });
  assert.equal(document.documentElement.getAttribute("data-profile"), "kids");
  assert.equal(C.loadKidsFavorites(), null);
  C.saveKidsFavorites(["S::a", "S::a", "S::b"]);
  assert.deepEqual(C.loadKidsFavorites(), ["S::a", "S::b"]);
  setActiveProfileScope({ id: "a", kids: false });
  assert.equal(document.documentElement.hasAttribute("data-profile"), false);
  assert.equal(C.loadKidsFavorites(), null);
  setActiveProfileScope({ id: "k2", kids: true });
  assert.deepEqual(C.loadKidsFavorites(), ["S::a", "S::b"]);
  // Characters are left out when their show is not kid-rated.
  assert.ok(C.KIDS_CHARACTERS.length > 0);
  assert.ok(C.KIDS_CHARACTERS.every((c) => c.channel !== "Toonami"));
});

await t("kids home: new kids profile sees pick-favorites first, once", async () => {
  const { default: HomePage } = await import("../src/pages/HomePage.jsx");
  setActiveProfileScope({ id: "k3", kids: true });
  urls.length = 0;
  const props = { apiKey: "tok", offline: false, loading: false, onSelect() {}, progress: {}, inProgress: [], history: [], saved: [], trending: [movie(1)], trendingTV: [], watched: {}, isSaved: () => false, onToggleSave() {} };
  let m = await mountEl(React.createElement(HomePage, props));
  await flush(30);
  assert.ok(m.host.querySelector(".kids-onb"), "pick-favorites screen");
  const skip = m.host.querySelector(".kids-onb-skip");
  await act(async () => skip.dispatchEvent(new win.MouseEvent("click", { bubbles: true })));
  await flush(10);
  assert.equal(m.host.querySelector(".kids-onb"), null);
  assert.ok(m.host.querySelector(".kids-home"));
  m.root.unmount();
  m = await mountEl(React.createElement(HomePage, props));
  await flush(10);
  assert.equal(m.host.querySelector(".kids-onb"), null, "shown only once");
  m.root.unmount();
});

await t("kids home: only history, My List, favorites and genre rows; all kid-filtered", async () => {
  const { default: HomePage } = await import("../src/pages/HomePage.jsx");
  const C = await import("../src/platform/ios/kids/kidsCatalog.js");
  setActiveProfileScope({ id: "k4", kids: true });
  C.saveKidsFavorites([]);
  let searched = 0;
  const props = {
    apiKey: "tok", offline: false, loading: false, onSelect() {}, progress: {}, watched: {},
    inProgress: [{ ...movie(2), season: null }, { ...movie(4) }],
    history: [{ ...movie(1), watchedAt: 2 }, { ...show(15), watchedAt: 3 }, { ...show(13), watchedAt: 1 }],
    saved: [movie(1), movie(4), show(12), show(16), movie(7)],
    trending: [movie(1), movie(2)], trendingTV: [show(11)], isSaved: () => false, onToggleSave() {}, onSearch: () => searched++,
  };
  const { host, root } = await mountEl(React.createElement(HomePage, props));
  await flush(400);
  const titles = [...host.querySelectorAll(".section-title")].map((e) => e.textContent);
  for (const bad of [/Top 10/i, /Trending/i, /Theaters/i, /Critically/i, /Recommended/i]) assert.ok(!titles.some((x) => bad.test(x)), `${bad} in ${titles}`);
  assert.ok(titles.includes("Continue Watching"), titles.join("|"));
  assert.ok(titles.includes("My List"));
  assert.ok(titles.includes("Watch Again"));
  assert.equal(host.querySelector(".sb-bill, .sb-billboard"), null, "no trending billboard");
  const text = host.textContent;
  for (const blocked of ["Movie 4", "Show 15", "Show 16", "Movie 7"]) assert.ok(!text.includes(blocked), blocked);
  for (const ok of ["Movie 1", "Movie 2", "Show 12", "Show 13"]) assert.ok(text.includes(ok), ok);
  const paths = urls.map((u) => new URL(u).pathname.replace(/^\/3/, ""));
  const H = await import("../src/platform/ios/kids/kidsHomeRows.js");
  assert.deepEqual(paths.filter((p) => H.KIDS_HOME_BANNED.test(p)), []);
  // Genre rows come from discover with kids certifications.
  // Genre rows come from discover with kids certifications (requested since
  // the onboarding test above; later mounts read the cache).
  assert.ok(titles.some((x) => /Cartoons|Family|Kids TV|Funny|Adventure|Magic|Music/.test(x)), "favorite-genre row");
  assert.ok(urls.some((u) => /discover\/(movie|tv)/.test(u) && /with_genres=/.test(u) && /certification=/.test(u)), "genre discover");
  // Top tabs: Characters · Genres · Search.
  const tabs = [...host.querySelectorAll(".kids-tab")];
  assert.deepEqual(tabs.map((b) => b.textContent), ["Characters", "Genres", "Search"]);
  await act(async () => tabs[2].dispatchEvent(new win.MouseEvent("click", { bubbles: true })));
  assert.equal(searched, 1);
  await act(async () => tabs[1].dispatchEvent(new win.MouseEvent("click", { bubbles: true })));
  await flush(40);
  assert.equal(host.querySelectorAll(".kids-genre").length, 7);
  const tiles = [...host.querySelectorAll(".kids-tile-name")].map((e) => e.textContent);
  assert.ok(tiles.length > 0);
  for (const name of tiles) assert.match(name, /^(Movie [12]|Show (11|12|13|19))$/, name);
  root.unmount();
});

// ── Every surface goes through the kids module (static wiring check) ───────
await t("every surface uses the kids filter", () => {
  const src = (f) => fs.readFileSync(`${process.cwd()}/${f}`, "utf8");
  const need = {
    "src/utils/api.js": [/filterKidsResponse\(/, /kidsRewritePath\(/, /kv: KIDS_FILTER_VERSION/],
    "src/App.jsx": [/<KidsTitleGate item=\{selected\} type="movie"/, /<KidsTitleGate item=\{selected\} type="tv"/, /isKidsAllowedNow\(/],
    "src/pages/HomePage.jsx": [/useKidsFilter\(trendingAll/, /useKidsFilter\(trendingTVAll/, /useKidsFilter\(inProgressAll/],
    "src/platform/ios/HomeSections.jsx": [/PosterRail[\s\S]*?useKidsFilter\(items\)/, /WideRail[\s\S]*?useKidsFilter\(all\)/, /Billboard[\s\S]*?useKidsFilter\(all, apiKey\)/, /WideBackdropRail[\s\S]*?useKidsFilter\(all\)/],
    "src/pages/LibraryPage.jsx": [/useKidsFilter\(historyAll\)/, /useKidsFilter\(inProgressAll\)/, /useKidsFilter\(savedAll\)/],
    "src/pages/DownloadsPage.jsx": [/useKidsFilter\(props\.downloads\)/, /downloads=\{downloads\}/],
    "src/components/SearchModal.jsx": [/useKidsFilter\(rawResults/],
    "src/components/MobileSearch.jsx": [/useKidsFilter\(raw, apiKey\)/, /useKidsFilter\(trendRaw, apiKey\)/],
    "src/platform/ios/kids/KidsHome.jsx": [/useKidsFilter\(inProgress/, /useKidsFilter\(useMemo\(\(\) => uniqueItems\(saved\)/, /useKidsFilter\(useMemo\(\(\) => historyTitles/, /useKidsFilter\(useMemo\(\(\) => favoriteShows/, /useKidsFilter\(useGenreTitles/],
    "src/platform/ios/kids/kidsCatalog.js": [/resolveKidsVerdict\(item/],
    "src/platform/ios/shim.js": [/resolveHiAnime:[\s\S]*?isKidsProfileActive\(\)/],
    "src/utils/kidsFilter.js": [/platform\/ios\/kids\/kidsFilter/],
  };
  for (const [f, res] of Object.entries(need)) for (const re of res) assert.match(src(f), re, `${f} lacks ${re}`);
  // No surface may call the old genre-only filter directly.
  for (const f of ["src/utils/api.js", "src/platform/ios/HomeSections.jsx", "src/components/SearchModal.jsx", "src/components/MobileSearch.jsx"])
    assert.doesNotMatch(src(f), /filterKidSafeResults/, f);
});

await t("lite: character art uses the small TVmaze copy", async () => {
  const { KIDS_CHARACTERS, smallArt } = await import("../src/platform/ios/kids/kidsCatalog.js");
  assert.ok(KIDS_CHARACTERS.length > 0);
  for (const c of KIDS_CHARACTERS) assert.ok(!String(c.img).includes("original_untouched"), c.img);
  assert.equal(smallArt("https://static.tvmaze.com/uploads/images/original_untouched/1/2.jpg"), "https://static.tvmaze.com/uploads/images/medium_portrait/1/2.jpg");
});

await t("lite: kids theme has no fixed gradient, blur, shadows or animations", async () => {
  const css = fs.readFileSync("src/platform/ios/kids/kids.css", "utf8");
  assert.ok(!/\bfixed\s*;/.test(css.replace(/position:\s*fixed/g, "")), "no background-attachment fixed");
  assert.ok(!/linear-gradient/.test(css), "no gradients");
  assert.ok(!/box-shadow:\s*0 4px/.test(css) && !/text-shadow:\s*0/.test(css), "no soft shadows");
  assert.ok(!/@keyframes/.test(css) && !/scroll-snap-type/.test(css));
  assert.match(css, /backdrop-filter:\s*none/);
  assert.match(css, /animation:\s*none !important/);
  const home = fs.readFileSync("src/platform/ios/kids/KidsHome.jsx", "utf8");
  assert.ok(!home.includes('"w342"') && !home.includes("fade-in"));
});

console.log(`\n${pass} kids filter tests passed`);
await win.happyDOM.close();
process.exit(0);
