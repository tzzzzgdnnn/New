// Dev-only: offline site corpus for the Custom Servers site adder. Runs
// smartAdd on each site's pasted link against its saved fixtures (no network,
// fake TMDB, no native app) and reports, per site, how many expected routes
// (sites.json) were learned. A report, not a gate: exit code is always 0
// unless the harness itself breaks. Not bundled.
//   node <bundled run.mjs> [--json]
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

const { matchSample } = await import("../../src/utils/customServers/match.js");
const { smartAdd } = await import("../../src/platform/ios/customSmartAdd.js");

// Read from the repo root (the runner bundles this into node_modules/.cache).
const ROOT = new URL("scripts/site-corpus/", `file://${process.cwd()}/`);
const corpus = JSON.parse(fs.readFileSync(new URL("sites.json", ROOT), "utf8"));

// Fake TMDB: the corpus titles plus the titles the pasted links name.
const MOVIES = [...corpus.titles.movies, { tmdb: 299534, imdb: "tt4154796", title: "Avengers: Endgame", year: 2019 }];
const SHOWS = [...corpus.titles.episodes, ...corpus.titles.anime, { tmdb: 1434, imdb: "tt0182576", title: "Family Guy", year: 1999 }];
const asMovie = (m) => ({ id: m.tmdb, title: m.title, release_date: `${m.year}-01-01`, imdb_id: m.imdb });
const asShow = (s) => ({ id: s.tmdb, name: s.title, first_air_date: `${s.year}-01-01`, number_of_seasons: 1 });
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tmdb = async (path) => {
  const [p, q = ""] = path.split("?");
  const query = norm(new URLSearchParams(q).get("query"));
  let m;
  if ((m = p.match(/^\/movie\/(\d+)$/))) {
    const hit = MOVIES.find((x) => x.tmdb === +m[1]);
    if (hit) return asMovie(hit);
  } else if ((m = p.match(/^\/tv\/(\d+)$/))) {
    const hit = SHOWS.find((x) => x.tmdb === +m[1]);
    if (hit) return asShow(hit);
  } else if ((m = p.match(/^\/find\/(tt\d+)$/))) {
    return { movie_results: MOVIES.filter((x) => x.imdb === m[1]).map(asMovie), tv_results: SHOWS.filter((x) => x.imdb === m[1]).map(asShow) };
  } else if (p === "/search/movie" || p === "/search/tv" || p === "/search/multi") {
    const hits = (list) => list.filter((x) => query && norm(x.title).includes(query));
    if (p === "/search/movie") return { results: hits(MOVIES).map(asMovie) };
    if (p === "/search/tv") return { results: hits(SHOWS).map(asShow) };
    return { results: [...hits(MOVIES).map((x) => ({ ...asMovie(x), media_type: "movie" })), ...hits(SHOWS).map((x) => ({ ...asShow(x), media_type: "tv" }))] };
  }
  const e = new Error("404 not found");
  e.status = 404;
  throw e;
};
const analyze = (url, prefer) =>
  matchSample(url, { tmdb, anilist: async () => ({}), prefer, timeoutMs: 2000 }).then((r) => (r.ok ? { ...r, templates: { [r.detected.kind]: r.detected.template } } : r));

/** Fixture HTTP for one site: routes.json maps path(+query) -> { file, status }. */
function fixtureHttp(site) {
  const dir = new URL(`fixtures/${site.fixtures}/`, ROOT);
  const routes = JSON.parse(fs.readFileSync(new URL("routes.json", dir), "utf8"));
  const host = new URL(site.origin).hostname.replace(/^www\./, "");
  return async (arg) => {
    const url = typeof arg === "string" ? arg : arg.url;
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, "") !== host) return { status: 0, text: "", url }; // offline: other hosts don't answer
    const r = routes[u.pathname + u.search] || routes[u.pathname];
    if (!r) return { status: 404, text: "Not found", url };
    return { status: r.status, text: fs.readFileSync(new URL(r.file, dir), "utf8"), url };
  };
}

const sameRoute = (a, b) => !!a && !!b && a.replace("://www.", "://") === b.replace("://www.", "://");

async function runSite(site) {
  const expected = Object.entries(site.routes).filter(([, v]) => v);
  const base = { id: site.id, appCanPlay: site.appCanPlay, total: expected.length, ok: 0, kinds: {} };
  if (!site.fixtures || !fs.existsSync(new URL(`fixtures/${site.fixtures}/routes.json`, ROOT))) return { ...base, skipped: "no fixtures" };
  const http = fixtureHttp(site);
  const r = await smartAdd(site.paste, { deps: { http, siteHttp: http, analyze, native: false }, budgetMs: 15000 }).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  if (r.builtIn) base.builtIn = r.builtIn.label || r.builtIn.id;
  if (!r.ok) return { ...base, error: r.error };
  for (const [k, want] of expected) {
    const got = r.draft?.templates?.[k] || null;
    const hit = sameRoute(got, want);
    base.kinds[k] = hit ? "ok" : got || "none";
    if (hit) base.ok++;
  }
  return base;
}

const results = [];
for (const site of corpus.sites) results.push(await runSite(site));

if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 1));
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const run = results.filter((r) => !r.skipped);
let ok = 0;
let total = 0;
console.log("site corpus (offline fixtures, smartAdd routes learned / expected):");
for (const r of results) {
  if (r.skipped) {
    console.log(`  - ${r.id.padEnd(12)} skipped (${r.skipped})`);
    continue;
  }
  ok += r.ok;
  total += r.total;
  const miss = Object.entries(r.kinds)
    .filter(([, v]) => v !== "ok")
    .map(([k, v]) => `${k}: got ${v}`)
    .join("; ");
  const mark = r.ok === r.total ? "✓" : "✗";
  console.log(`  ${mark} ${r.id.padEnd(12)} ${r.ok}/${r.total} (${pct(r.ok, r.total)}%) [${r.appCanPlay}]${r.builtIn ? ` built-in: ${r.builtIn}` : ""}${r.error ? ` error: ${r.error}` : ""}${miss ? ` — ${miss}` : ""}`);
}
const full = run.filter((r) => r.ok === r.total).length;
console.log(`site corpus: ${full}/${run.length} sites fully learned, ${ok}/${total} routes (${pct(ok, total)}%), ${results.length - run.length} skipped`);
const failing = run.filter((r) => r.ok < r.total).map((r) => r.id);
if (failing.length) console.log(`site corpus: known failing (report only, not a CI failure): ${failing.join(", ")}`);
