// Custom servers, smart add: from any link on a site (homepage included),
// work out everything the Add sheet needs: name and icon, the movie / TV /
// anime links and their ids (all filled from TMDB data when playing), which
// lists the site really serves (one known title tried per kind, in the
// background, in parallel), bot walls, whether a direct API can be learned,
// and the mode to use. Reports progress step by step for the sheet's list.
import { crawlSite, CRAWL_FETCH_TIMEOUT_MS } from "../../utils/customServers/crawl";
import { discoverCandidates, looksLikeInfoPage } from "../../utils/customServers/discover";
import { learnLookup } from "../../utils/customServers/lookup";
import { fillFromFamily, idScheme } from "../../utils/customServers/families";
import { analyzeUrl, buildUrl, deriveTemplate, originOf, siteDomain, TEMPLATE_KINDS } from "../../utils/customServers/template";
import { analyzeSample, canTestNatively, defaultLists, directSteps, nativeTry, pageSteps, sampleNumbers, siteHttp, siteValueFor, testLinkAsync, REFERENCE_TITLES, CUSTOM_ID_PREFIX } from "./customServers";
import { directHttp } from "./customDirect";
import { diag } from "../../utils/diag";

/** Smart add aims to finish within this long. */
export const SMART_ADD_BUDGET_MS = 110000;
/** Each background page try gets at most this long to show a stream (it ends at the first one). */
export const SMART_PROBE_TIMEOUT_MS = 30000;
/** Links tried per kind before giving up on it. */
export const MAX_TRIES_PER_KIND = 5;
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
  // Where the site's player really is: router routes in its scripts, the
  // pasted link rewritten (details -> embed / watch, slug dropped), the usual
  // embed routes. Tried after the link as read, or before it when that link
  // is an info page that never starts a player.
  const disc = discoverCandidates({
    origin,
    pasted: { movie: all.movie, tv: all.tv, anime: all.anime },
    scriptTexts: crawl.scriptTexts || [],
    scriptRoutes: crawl.scriptRoutes || {},
  });
  const routeGuesses = {};
  for (const k of TEMPLATE_KINDS) routeGuesses[k] = disc[k].map((c) => c.tpl);
  const switched = {};

  // Slug sites with per-title ids ({site}): learn the site's own search from
  // the pasted title, so any title finds its page.
  const lookup = {};
  const searchHttp = deps.siteHttp || siteHttp(site);
  await Promise.all(
    TEMPLATE_KINDS.filter((k) => all[k]?.includes("{site}") && matches[k]).map(async (k) => {
      const seg = sampleNumbers(all[k], matches[k].sample).site;
      const lk = await learnLookup({
        origin,
        kind: k === "movie" ? "movie" : "tv",
        title: matches[k].match.title,
        siteSegment: seg,
        http: searchHttp,
        extra: crawl.search ? [crawl.search] : [],
      }).catch(() => null);
      if (lk) lookup[k] = lk;
    }),
  );
  for (const k of TEMPLATE_KINDS) {
    if (lookup[k] || !all[k]?.includes("{site}")) continue;
    const from = Object.values(lookup)[0];
    if (from) lookup[k] = { url: from.url, type: k === "movie" ? "movie" : "tv" };
  }
  // A {site} link with no way to find other titles is no use beyond the pasted one.
  for (const k of TEMPLATE_KINDS) {
    if (all[k]?.includes("{site}") && !lookup[k]) {
      delete all[k];
      delete guessed[k];
    }
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
    lookup,
  };

  // 4. Try one known title per kind, in the background, in parallel.
  const works = {};
  const tries = {};
  const titleIssues = [];
  let wall = crawl.wall;
  let adsOn = null;
  let humanCheck = null;
  if (native) {
    onStep("probe", "running");
    const jobs = [];
    for (const k of TEMPLATE_KINDS) {
      const found0 = all[k] && !guessed[k] ? all[k] : null;
      const rest = [...(all[k] && guessed[k] ? [all[k]] : []), ...routeGuesses[k]].filter((t) => t !== found0);
      // An info page goes after the site's player routes; a link that plays goes first.
      let options = found0 ? (looksLikeInfoPage(found0) ? [...rest.slice(0, 2), found0, ...rest.slice(2)] : [found0, ...rest]) : rest;
      options = [...new Set(options)].slice(0, MAX_TRIES_PER_KIND);
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
        const link0 = kindForLink === "anime-tv" ? await animeOnTvLink(server) : await testLinkAsync(server, k);
        if (!link0.ok) continue;
        const r = await tryPage(server, link0.url, ms);
        const steps = pageSteps(r, { title: link0.title, want: link0.want, site: base.name });
        wall = wall || r?.page?.wall || null;
        if (r?.ads) adsOn = adsOn || r.ads.filter !== false;
        const ok = !!r?.stream?.ok && !!r?.playable?.ok;
        const title = steps.find((s) => s.id === "title");
        if (title && !title.ok) titleIssues.push(`${KIND_WORD[k]}: ${title.detail}`);
        if (r?.page?.humanCheck) humanCheck = humanCheck || r.page.humanCheck;
        if (ok && title?.ok !== false) {
          works[k] = true;
          tries[k] = { r, link: link0, tpl };
          if (k !== "anime" || tpl !== all.tv) {
            if (all[k] && all[k] !== tpl) switched[k] = { from: all[k], to: tpl };
            all[k] = tpl;
            guessed[k] = false;
          }
          return;
        }
      }
      works[k] = false;
    });
    const okKinds = TEMPLATE_KINDS.filter((k) => works[k]);
    const sw = Object.values(switched)[0];
    onStep(
      "probe",
      okKinds.length ? "done" : "failed",
      TEMPLATE_KINDS.map((k) => `${KIND_WORD[k]} ${works[k] ? "✓" : "✗"}`).join(" ") +
        (sw ? ` · switched to ${sw.to.replace(/^https?:\/\//, "")}` : "") +
        (!okKinds.length && humanCheck ? ` · ${humanCheck} check` : ""),
    );
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
    // An info page that never played: not kept when the site was tried.
    if (native && !works[k] && looksLikeInfoPage(all[k]) && Object.values(works).some(Boolean)) continue;
    templatesOut[k] = all[k];
  }
  if (!Object.keys(templatesOut).length) {
    return {
      ok: false,
      error: humanCheck
        ? `${base.name} asks for a human check (${humanCheck}) before it plays. Super Player never ticks it for you, so this site can't play in the background.`
        : wall
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
    Object.keys(switched).length ? `switched to the site's player link` : null,
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
      tap: recipeTap(tries),
      lookup,
      siteServers: [...new Set(Object.values(tries).flatMap((t) => t.r?.page?.servers || []))].slice(0, 8).map((label) => ({ label, works: null })),
      switchedFrom: Object.values(switched)[0]?.from ? link.trim() : null,
      switched,
    },
    report: { crawl, works, switched, ms: Date.now() - started },
  };
}

/** The button the working pages needed pressed (last press before the stream). */
function recipeTap(tries) {
  for (const t of Object.values(tries)) {
    const taps = t.r?.page?.taps;
    if (taps?.length) return taps[taps.length - 1];
  }
  return null;
}

/** The anime reference title through a TV link (sites whose anime use TMDB ids). */
async function animeOnTvLink(server) {
  const ref = REFERENCE_TITLES.anime;
  const values = { tmdb: ref.tmdb, title: ref.title, year: ref.year, season: 1, episode: 1, lang: "sub", slugStyle: server.slugStyle };
  if (server.templates.tv?.includes("{site}")) {
    values.site = await siteValueFor(server, "tv", ref);
  }
  const url = buildUrl(server.templates.tv, values);
  if (!url) return { ok: false, error: "The TV link needs a value One Piece doesn't have on TMDB." };
  return { ok: true, url, title: ref.title, reference: true, values, want: { kind: "tv", title: ref.title, altTitles: ref.altTitles, tmdb: ref.tmdb } };
}
