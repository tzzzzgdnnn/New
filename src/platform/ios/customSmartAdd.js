// Custom servers, smart add: from any link on a site (homepage included),
// work out everything the Add sheet needs: name and icon, the movie / TV /
// anime links and their ids (all filled from TMDB data when playing), which
// lists the site really serves (one known title tried per kind, in the
// background, in parallel), bot walls, whether a direct API can be learned,
// and the mode to use. Reports progress step by step for the sheet's list.
import { crawlSite, CRAWL_FETCH_TIMEOUT_MS } from "../../utils/customServers/crawl";
import { fillFromFamily, idScheme } from "../../utils/customServers/families";
import { analyzeUrl, buildUrl, deriveTemplate, originOf, siteDomain, TEMPLATE_KINDS } from "../../utils/customServers/template";
import { analyzeSample, canTestNatively, defaultLists, directSteps, nativeTry, pageSteps, testLinkFor, REFERENCE_TITLES, CUSTOM_ID_PREFIX } from "./customServers";
import { directHttp } from "./customDirect";
import { diag } from "../../utils/diag";

/** Smart add aims to finish within this long. */
export const SMART_ADD_BUDGET_MS = 20000;
/** Each background page try gets at most this long to show a stream. */
export const SMART_PROBE_TIMEOUT_MS = 9000;
/** Hidden pages open at once during the probes. */
const PROBE_PARALLEL = 3;

/** Where embed sites usually put each kind, tried when the site shows no title links. */
export const COMMON_ROUTES = Object.freeze({
  movie: ["/embed/movie/{tmdb}", "/movie/{tmdb}", "/movie/{tmdb}/watch", "/embed/movie?tmdb={tmdb}", "/watch/movie/{tmdb}"],
  tv: [
    "/embed/tv/{tmdb}/{season}/{episode}",
    "/tv/{tmdb}/{season}/{episode}",
    "/tv/{tmdb}/watch?season={season}&episode={episode}",
    "/embed/tv?tmdb={tmdb}&season={season}&episode={episode}",
    "/watch/tv/{tmdb}/{season}/{episode}",
  ],
  anime: ["/embed/anime/{anilist}/{episode}/{lang}", "/anime/{anilist}/{episode}/{lang}"],
});

/** The progress list the sheet shows, in order. */
export const SMART_STEPS = Object.freeze([
  { id: "read", label: "Reading the site" },
  { id: "links", label: "Finding movie, TV and anime links" },
  { id: "match", label: "Matching titles on TMDB" },
  { id: "probe", label: "Trying a movie, an episode and an anime" },
  { id: "direct", label: "Looking for a direct API" },
]);

const KIND_WORD = { movie: "Movies", tv: "TV", anime: "Anime" };

/** A link is a site's root (or a list page) rather than a title. */
export const isSiteLink = (link) => {
  const a = analyzeUrl(link);
  return a.ok && !a.numbers.length && !a.imdb.length && a.titleGuess.split(" ").filter(Boolean).length < 2;
};

/** Run async jobs `n` at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

/**
 * Analyse a site from a pasted link.
 * @param {string} link any link on the site
 * @param {{ apiKey?, onStep?: (id, state, detail?) => void, deps? }} opts
 *   deps (tests): { http, analyze, tryPage, learn, native }
 * @returns {Promise<{ ok, error?, draft?, summary?, report? }>}
 *   draft: the fields the Add sheet saves (name, icon, sample, templates,
 *   guessed, lists, match, slugStyle, mode, direct, directNotes)
 */
export async function smartAdd(link, { apiKey, onStep = () => {}, deps = {} } = {}) {
  const started = Date.now();
  const left = () => SMART_ADD_BUDGET_MS - (Date.now() - started);
  const http = deps.http || ((url) => directHttp({ url, timeoutMs: CRAWL_FETCH_TIMEOUT_MS }));
  const analyze = deps.analyze || ((url, prefer) => analyzeSample(url, { apiKey, prefer }));
  const native = deps.native ?? canTestNatively();
  const tryPage = deps.tryPage || ((server, url, ms) => nativeTry(server, url, { timeoutMs: ms, learn: true }));
  const learn = deps.learn || directSteps;
  const origin = originOf(link);
  if (!origin) return { ok: false, error: "Paste a full link that starts with http:// or https://" };
  const site = siteDomain(link);

  // 1–2. The pasted link as a strong hint, and the site's own links, at once.
  const hintP = isSiteLink(link) ? Promise.resolve(null) : analyze(link, null).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  const crawl = await crawlSite(link, {
    http,
    onStep,
    searchTitles: { movie: REFERENCE_TITLES.movie.title, tv: REFERENCE_TITLES.tv.title, anime: REFERENCE_TITLES.anime.title },
  });
  const hint = await hintP;

  // 3. Match each kind's sample on TMDB / AniList and turn it into a template.
  onStep("match", "running");
  const templates = {};
  const matches = {};
  let slugStyle = null;
  if (hint?.ok) {
    templates[hint.detected.kind] = hint.detected.template;
    matches[hint.detected.kind] = { match: hint.match, sample: link.trim() };
    slugStyle = hint.detected.slugStyle || null;
  }
  const todo = TEMPLATE_KINDS.filter((k) => !templates[k] && (crawl.samples[k] || crawl.details[k]));
  const found = await Promise.all(
    todo.map(async (k) => {
      for (const sample of [crawl.samples[k], crawl.details[k]].filter(Boolean)) {
        const r = await analyze(sample, k).catch((e) => ({ ok: false, error: e?.message || String(e) }));
        if (r?.ok && r.detected.kind === k) return { k, r, sample };
        if (r?.ok && k === "tv" && r.detected.kind === "anime") return null; // an anime show on a TV route: the TV link comes from elsewhere
      }
      return null;
    }),
  );
  for (const f of found.filter(Boolean)) {
    templates[f.k] = f.r.detected.template;
    matches[f.k] = { match: f.r.match, sample: f.sample };
    slugStyle = slugStyle || f.r.detected.slugStyle || null;
  }
  const matchedKinds = Object.keys(templates);
  onStep(
    "match",
    matchedKinds.length ? "done" : "failed",
    matchedKinds.length
      ? matchedKinds.map((k) => `${KIND_WORD[k]}: ${matches[k].match.title}`).join(" · ")
      : hint && !hint.ok && !crawl.samples.movie && !crawl.samples.tv
        ? "No title links matched; trying the usual embed routes"
        : "Trying the usual embed routes",
  );

  // Fill the other kinds: the site's family, movie <-> tv, its script routes.
  const fam = fillFromFamily(templates);
  const all = { ...fam.templates };
  const guessed = { ...fam.guessed };
  for (const [from, to] of [["movie", "tv"], ["tv", "movie"]]) {
    if (!all[to] && all[from] && !guessed[from]) {
      const g = deriveTemplate(all[from], from, to);
      if (g) (all[to] = g), (guessed[to] = true);
    }
  }
  for (const k of TEMPLATE_KINDS) {
    if (!all[k] && crawl.scriptRoutes?.[k]?.length) (all[k] = crawl.scriptRoutes[k][0]), (guessed[k] = true);
  }
  // Nothing at all: the usual embed routes, one per kind until one works.
  const routeGuesses = {};
  for (const k of TEMPLATE_KINDS) {
    if (!all[k]) routeGuesses[k] = COMMON_ROUTES[k].map((r) => origin + r);
  }

  const primaryKind = hint?.ok ? hint.detected.kind : ["movie", "tv", "anime"].find((k) => matches[k]) || null;
  const base = {
    id: `${CUSTOM_ID_PREFIX}smartadd`,
    name: crawl.name || site,
    site,
    sample: primaryKind ? matches[primaryKind].sample : link.trim(),
    match: primaryKind ? matches[primaryKind].match : null,
    templates: all,
    slugStyle,
    mode: "auto",
    direct: {},
  };

  // 4. Try one known title per kind, in the background, in parallel.
  const works = {};
  const tries = {};
  const titleIssues = [];
  let wall = crawl.wall;
  let adsOn = null;
  if (native) {
    onStep("probe", "running");
    const jobs = [];
    for (const k of TEMPLATE_KINDS) {
      const options = all[k] ? [all[k]] : routeGuesses[k] || [];
      // Anime on a TMDB route: One Piece through the TV link.
      if (k === "anime" && all.tv && (!all.anime || guessed.anime)) options.unshift(all.tv);
      jobs.push({ k, options });
    }
    await pool(jobs, PROBE_PARALLEL, async ({ k, options }) => {
      for (const tpl of options) {
        const ms = Math.min(SMART_PROBE_TIMEOUT_MS, left() - 3000);
        if (ms < 2000) break;
        const kindForLink = tpl === all.tv && k === "anime" ? "anime-tv" : k;
        const server = { ...base, templates: { ...all, [k]: tpl }, match: base.match?.kind === k ? base.match : null };
        const link0 = kindForLink === "anime-tv" ? animeOnTvLink(server) : testLinkFor(server, k);
        if (!link0.ok) continue;
        const r = await tryPage(server, link0.url, ms);
        const steps = pageSteps(r, { title: link0.title, want: link0.want, site: base.name });
        wall = wall || r?.page?.wall || null;
        if (r?.ads) adsOn = adsOn || r.ads.filter !== false;
        const ok = !!r?.stream?.ok && !!r?.playable?.ok;
        const title = steps.find((s) => s.id === "title");
        if (title && !title.ok) titleIssues.push(`${KIND_WORD[k]}: ${title.detail}`);
        if (ok && title?.ok !== false) {
          works[k] = true;
          tries[k] = { r, link: link0, tpl };
          if (k !== "anime" || tpl !== all.tv) all[k] = all[k] || tpl;
          if (routeGuesses[k]?.includes(tpl)) guessed[k] = true;
          return;
        }
      }
      works[k] = false;
    });
    const okKinds = TEMPLATE_KINDS.filter((k) => works[k]);
    onStep("probe", okKinds.length ? "done" : "failed", TEMPLATE_KINDS.map((k) => `${KIND_WORD[k]} ${works[k] ? "✓" : "✗"}`).join(" "));
  } else {
    onStep("probe", "skipped", "Trying the site needs the iPhone app");
  }

  // 5. Direct API, from what the working pages did.
  const direct = {};
  const directNotes = {};
  if (native) {
    onStep("direct", "running");
    await Promise.all(
      Object.entries(tries)
        .filter(([k]) => all[k] && tries[k].tpl === all[k])
        .map(async ([k, t]) => {
          const d = await learn({ ...base, templates: all }, k, t.link, t.r);
          if (d.def) direct[k] = d.def;
          else if (d.note) directNotes[k] = d.note;
        }),
    );
    const n = Object.keys(direct).length;
    onStep("direct", n ? "done" : "failed", n ? `Found for ${Object.keys(direct).map((k) => KIND_WORD[k]).join(", ")}` : Object.values(directNotes)[0] || "Not available: Page mode");
  } else {
    onStep("direct", "skipped", "Checked by the Test on the iPhone");
  }

  // Keep only links that worked, or were read from the site itself.
  const templatesOut = {};
  for (const k of TEMPLATE_KINDS) {
    if (!all[k]) continue;
    if (native && !works[k] && guessed[k]) continue;
    templatesOut[k] = all[k];
  }
  if (!Object.keys(templatesOut).length) {
    return {
      ok: false,
      error: wall
        ? `${base.name} shows a ${wall} bot check to the app, so its links can't be read. Paste a link of a page that plays a movie or an episode.`
        : `Couldn't find how ${base.name} links its movies and episodes. Paste a link of a page that plays a movie or an episode.`,
      report: { crawl, works },
    };
  }
  const lists = native
    ? { movies: !!works.movie, tv: !!works.tv, anime: !!works.anime }
    : matchedKinds.length > 1
      ? { movies: !!matches.movie, tv: !!matches.tv, anime: !!matches.anime }
      : primaryKind
        ? defaultLists(primaryKind)
        : { movies: !!templatesOut.movie, tv: !!templatesOut.tv, anime: false };
  const mode = Object.keys(direct).length ? "auto" : "page";
  const guessedOut = Object.fromEntries(Object.keys(templatesOut).filter((k) => guessed[k] && !works[k]).map((k) => [k, true]));
  const summary = [
    TEMPLATE_KINDS.map((k) => `${KIND_WORD[k]} ${native ? (works[k] ? "✓" : "✗") : templatesOut[k] ? "?" : "✗"}`).join(" "),
    idScheme(Object.fromEntries(Object.entries(templatesOut).filter(([k]) => !guessedOut[k]))),
    Object.keys(direct).length ? "Direct API found" : native ? "Page mode" : null,
    adsOn ? "ads blocked" : null,
    wall ? `${wall} check` : null,
    titleIssues.length ? "title mismatch" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  diag("custom", `smart add ${site}: ${summary} in ${Date.now() - started} ms (${crawl.pages} pages read)`);
  return {
    ok: true,
    summary,
    titleIssues,
    draft: {
      name: base.name,
      icon: crawl.icon,
      sample: base.sample,
      match: base.match,
      templates: templatesOut,
      guessed: guessedOut,
      lists,
      slugStyle,
      mode,
      direct,
      directNotes,
    },
    report: { crawl, works, ms: Date.now() - started },
  };
}

/** The anime reference title through a TV link (sites whose anime use TMDB ids). */
function animeOnTvLink(server) {
  const ref = REFERENCE_TITLES.anime;
  const values = { tmdb: ref.tmdb, title: ref.title, year: ref.year, season: 1, episode: 1, lang: "sub", slugStyle: server.slugStyle };
  const url = buildUrl(server.templates.tv, values);
  if (!url) return { ok: false, error: "The TV link needs a value One Piece doesn't have on TMDB." };
  return { ok: true, url, title: ref.title, reference: true, values, want: { kind: "tv", title: ref.title, altTitles: ref.altTitles, tmdb: ref.tmdb } };
}
