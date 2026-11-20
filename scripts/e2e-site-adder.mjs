// Dev-only: end-to-end test of the site adder in a real headless browser
// (Chromium via Playwright), against the fixture sites in
// site-adder-fixtures.mjs and, with LIVE=1, a real public site.
// The `net` given to discoverSite / resolveSite here behaves like the
// iPhone's: render = a hidden browser page running collector.js; fetch =
// native HTTP sending the browser's own cookies (Cloudflare clearance) and
// the same User-Agent. Not bundled; needs `playwright` installed:
//   npx esbuild scripts/e2e-site-adder.mjs --bundle --platform=node --format=esm \
//     --external:playwright --outfile=<dir with node_modules/playwright>/e2e.mjs && node …/e2e.mjs
import { chromium } from "playwright";
import { discoverSite, resolveSite, verifyStream, streamHeaders, clearSiteCache } from "../src/utils/customServers/site.js";
import { collectorScript } from "../src/utils/customServers/collector.js";
import { startFixtures } from "./site-adder-fixtures.mjs";

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

function makeNet(context, log = () => {}) {
  const cookieFor = async (url) => {
    const list = await context.cookies(url);
    return list.length ? list.map((c) => `${c.name}=${c.value}`).join("; ") : null;
  };
  return {
    stats: { fetch: 0, render: 0 },
    async fetch(url, { headers = {}, method = "GET", body = null, timeoutMs = 15000, bytes = 0 } = {}) {
      this.stats.fetch++;
      const h = { "User-Agent": UA, ...headers };
      const c = await cookieFor(url);
      if (c && !h.Cookie) h.Cookie = c;
      try {
        const r = await fetch(url, { method, headers: h, body, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        const buf = Buffer.from(await r.arrayBuffer());
        return { ok: r.ok, status: r.status, url: r.url, contentType: r.headers.get("content-type") || "", text: buf.subarray(0, 3_000_000).toString("utf8"), bytes: buf.length };
      } catch (e) {
        return { ok: false, status: 0, error: e.message };
      }
    },
    async render(url, { play = false, search = null, timeoutMs = 15000 } = {}) {
      this.stats.render++;
      const page = await context.newPage();
      const msgs = [];
      await page.exposeBinding("__sbCollect", (_src, m) => msgs.push(m));
      await page.addInitScript(collectorScript({ play, search }, "window.__sbCollect"));
      let status = 0;
      page.on("response", (r) => {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) status = r.status();
      });
      const t0 = Date.now();
      let error = null;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      } catch (e) {
        error = e.message;
      }
      // Like the iPhone: wait for a stream (play), a search (search) or the page to settle; Cloudflare checks reload on their own.
      const until = t0 + timeoutMs;
      const challenged = async () => /just a moment|checking your browser/i.test(await page.title().catch(() => ""));
      while (Date.now() < until) {
        await page.waitForTimeout(400);
        if (await challenged()) continue;
        const media = msgs.some((m) => m.kind === "media");
        const elapsed = Date.now() - t0;
        if (play && media && elapsed > 1500) break;
        if (msgs.some((m) => m.kind === "drm")) break;
        if (!play && !search && elapsed > 2500) break;
        if (search && elapsed > 6000) break;
        if (play && elapsed > 9000) break;
      }
      await page.evaluate(() => window.__sbSnap && window.__sbSnap()).catch(() => {});
      await page.waitForTimeout(150);
      const frames = new Map();
      for (const m of msgs) if (m.kind === "frame") frames.set(m.url + (m.top ? "#top" : ""), m);
      const out = {
        ok: !error && status < 400,
        status,
        url: page.url(),
        title: await page.title().catch(() => ""),
        frames: [...frames.values()],
        api: msgs.filter((m) => m.kind === "api"),
        media: msgs.filter((m) => m.kind === "media"),
        drm: msgs.some((m) => m.kind === "drm"),
        cookie: await cookieFor(page.url()),
        userAgent: UA,
        challenge: await challenged(),
        error,
      };
      log(`render ${url} play=${play} search=${search || ""} -> ${out.frames.length} frames, ${out.api.length} api, ${out.media.length} media, ${Date.now() - t0} ms`);
      await page.close();
      return out;
    },
  };
}

const CASES = [
  // [fixture, expect ok?, title to resolve afterwards, extra checks]
  { site: "form", ok: true, resolve: { title: "Metropolis", year: 1927, type: "movie" }, search: "form" },
  { site: "wp", ok: true, resolve: { title: "His Girl Friday", year: 1940, type: "movie" }, search: "wp", quality: true, aes: true },
  { site: "spa", ok: true, resolve: { title: "Nosferatu", year: 1922, type: "movie" }, search: "api" },
  { site: "sitemap", ok: true, resolve: { title: "Sherlock Jr.", year: 1924, type: "movie" }, search: "sitemap", quality: true },
  { site: "mirrors", ok: true, resolve: { title: "The General", year: 1926, type: "movie" }, mirrors: true },
  { site: "tv", ok: true, resolve: { title: "Dragnet", type: "tv", season: 2, episode: 3 } },
  { site: "cloudflare", ok: true, resolve: { title: "Night of the Living Dead", year: 1968, type: "movie" }, cloudflare: true },
  { site: "drm", ok: false, reason: /protected/i },
  { site: "drmhls", ok: false, reason: /protected/i },
  { site: "login", ok: false, reason: /sign in/i },
];

/** Resolve a title on a discovered site and fetch its stream like the player / downloader. */
async function playTitle(net, recipe, want) {
  const r = await resolveSite(recipe, want, { net });
  if (!r.ok) return { ok: false, error: r.error };
  // What the app plays: decoded stream first (direct), else the page / mirrors in the hidden stream finder.
  let stream = r.direct[0] ? { ...r.direct[0], page: r.page } : null;
  let render = null;
  for (const url of [r.page, ...r.mirrors.map((m) => m.url)]) {
    if (stream) break;
    render = await net.render(url, { play: true, timeoutMs: 15000 });
    const { streamsOf } = await import("../src/utils/customServers/site.js");
    stream = streamsOf(render, url)[0] || null;
  }
  if (!stream) return { ok: false, error: "no stream", page: r.page };
  const headers = streamHeaders(stream.page || r.page, { cookie: render?.cookie || null, userAgent: UA });
  const v = await verifyStream(net, stream, headers);
  return { ...v, page: r.page, stream: stream.url, mirrors: r.mirrors.length };
}

async function main() {
  const live = process.env.LIVE === "1";
  const only = process.env.ONLY;
  const browser = await chromium.launch();
  let context = null;
  const results = [];
  const fx = await startFixtures();
  try {
    for (const c of CASES) {
      if (only && c.site !== only) continue;
      clearSiteCache();
      // A fresh browser profile per site, like a first visit.
      await context?.close();
      context = await browser.newContext({ userAgent: UA });
      const net = makeNet(context, process.env.VERBOSE ? console.log : () => {});
      const t0 = Date.now();
      const steps = [];
      const d = await discoverSite(fx.sites[c.site], { net, onStep: (id, state, detail) => state !== "run" && steps.push(`${id}:${state}${detail ? `(${detail})` : ""}`) });
      const ms = Date.now() - t0;
      const row = { case: c.site, discovery: d.ok ? "ok" : `refused at ${d.step}: ${d.error}`, ms, steps: steps.join(" ") };
      let pass = d.ok === c.ok;
      if (!c.ok) pass = pass && c.reason.test(d.error || "");
      if (d.ok) {
        row.search = d.recipe.search.type;
        row.player = d.recipe.player.mode;
        row.quality = d.recipe.quality.map((q) => q.height).join("/");
        if (c.search && d.recipe.search.type !== c.search) pass = false;
        if (c.quality && d.recipe.quality.length < 2) pass = false;
        const p = await playTitle(net, d.recipe, c.resolve);
        row.play = p.ok ? `${c.resolve.title}: ${p.kind} ${p.bytes} bytes${p.variants?.length ? `, ${p.variants.length} qualities` : ""}${p.mirrors ? `, ${p.mirrors} servers` : ""}` : `FAILED ${p.error}`;
        pass = pass && p.ok;
        if (c.mirrors && !(p.mirrors >= 2)) pass = false;
        if (c.cloudflare) {
          // Every request after the check passed carried the clearance cookie and the browser's UA.
          const hits = fx.stats.cloudflare.hits.filter((h) => !h.path.startsWith("/media/") && /cf_clearance=/.test(h.cookie));
          const sameUa = hits.every((h) => h.ua === UA);
          const searchByFetch = hits.some((h) => h.path === "/search");
          row.cloudflare = `challenged ${fx.stats.cloudflare.blocked}x, ${hits.length} cleared requests, same UA: ${sameUa}, search via native fetch with cookie: ${searchByFetch}`;
          pass = pass && sameUa && searchByFetch;
        }
        if (c.site === "form") {
          // The MP4 is hotlink-guarded: it only answers with the site's Referer.
          const guarded = fx.stats.form.hits.filter((h) => h.path.endsWith("movie.mp4"));
          row.referer = `mp4 requests with Referer: ${guarded.filter((h) => h.referer).length}/${guarded.length}`;
        }
      }
      row.pass = pass;
      row.requests = `${net.stats.fetch} fetch, ${net.stats.render} render`;
      results.push(row);
      console.log(`${pass ? "PASS" : "FAIL"} ${c.site.padEnd(10)} ${ms} ms  ${row.discovery}${row.search ? ` · search=${row.search} player=${row.player}${row.quality ? ` quality=${row.quality}` : ""}` : ""}\n      ${row.play || ""}${row.cloudflare ? `\n      ${row.cloudflare}` : ""}${row.referer ? `\n      ${row.referer}` : ""}\n      steps: ${row.steps}`);
    }
    if (live) {
      clearSiteCache();
      await context?.close();
      context = await browser.newContext({ userAgent: UA });
      const net = makeNet(context, process.env.VERBOSE ? console.log : () => {});
      const home = process.env.LIVE_SITE || "https://archive.org/";
      const t0 = Date.now();
      const d = await discoverSite(home, { net, onStep: (id, state, detail) => state !== "run" && console.log(`      live ${id}:${state} ${detail || ""}`) });
      console.log(`LIVE ${home}: ${d.ok ? `ok search=${d.recipe.search.type} player=${d.recipe.player.mode} sample=${d.recipe.sample.title}` : `refused at ${d.step}: ${d.error}`} in ${Date.now() - t0} ms`);
      if (d.ok && process.env.LIVE_TITLE) {
        const p = await playTitle(net, d.recipe, { title: process.env.LIVE_TITLE, year: Number(process.env.LIVE_YEAR) || null, type: "movie" });
        console.log(`LIVE play ${process.env.LIVE_TITLE}: ${JSON.stringify(p)}`);
      }
      results.push({ case: `live ${home}`, ok: d.ok, detail: d.ok ? d.recipe : d });
    }
  } finally {
    await fx.close();
    await browser.close();
  }
  const failed = results.filter((r) => r.pass === false);
  console.log(`\n# fixtures: ${results.filter((r) => r.pass).length} pass, ${failed.length} fail`);
  process.exitCode = failed.length ? 1 : 0;
}

await main();
