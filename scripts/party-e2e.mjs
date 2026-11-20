// Cross-device Watch Party test: three real browsers in one party, watching
// Breaking Bad S1E1 together.
//
//   iPhone   WebKit, iPhone 16e emulation, the web app (dist-web)
//   Android  Chromium, Pixel 7 emulation, the ANDROID app bundle (dist-android)
//            with a stand-in for the native side (party-e2e/fake-android.js):
//            adapters/android.js, the SbPlayer bridge and the native player model
//   Desktop  Chromium, 1366x768, the web app (dist-web)
//
// Real TMDB and the real PeerJS broker (parties run peer-to-peer with no room
// server); the video is a generated test stream (testsrc + tone, HLS) served
// through request interception, so no streaming site is ever contacted.
//
//   npm run test:party                  local builds
//   npm run test:party -- --live        the web clients load the live GitHub Pages app
//   PARTY_E2E_ONLY=chat,voice ...       run a subset of scenarios
//
// Not covered (needs hardware): the real iPhone / Android apps' native players
// (AVPlayer / ExoPlayer), real phone audio routing and mobile networks.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "node_modules/.cache/party-e2e");
const LIVE = process.argv.includes("--live");
const LIVE_URL = "https://tzzzzgdnnn.github.io/New/";
const STREAM_HOST = "https://stream.party-e2e.test";
const STREAM_URL = `${STREAM_HOST}/bb/index.m3u8`;
const ONLY = (process.env.PARTY_E2E_ONLY || "").split(",").filter(Boolean);
const SYNC_TOL = Number(process.env.PARTY_E2E_TOL || 0.6); // seconds between devices (three browsers on one CI box)
const BB = { id: 1396, title: "Breaking Bad" };

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Test stream (generated once) ─────────────────────────────────────────
function ensureStream() {
  const dir = path.join(CACHE, "bb");
  if (fs.existsSync(path.join(dir, "index.m3u8"))) return dir;
  fs.mkdirSync(dir, { recursive: true });
  log("generating test stream (ffmpeg)");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "300",
    "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-g", "50",
    "-c:a", "aac", "-b:a", "96k",
    "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(dir, "seg%03d.ts"), path.join(dir, "index.m3u8"),
  ]);
  return dir;
}

// ── Local static server for the builds ───────────────────────────────────
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm" };
function serve() {
  const roots = { "/web/": path.join(ROOT, "dist-web"), "/android/": path.join(ROOT, "dist-android") };
  for (const [k, d] of Object.entries(roots)) if (!fs.existsSync(path.join(d, "index.html")) && !(LIVE && k === "/web/")) throw new Error(`missing build ${d} (run npm run test:party)`);
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const pre = Object.keys(roots).find((p) => u.pathname.startsWith(p));
    if (!pre) return res.writeHead(404).end();
    let f = path.join(roots[pre], decodeURIComponent(u.pathname.slice(pre.length)) || "index.html");
    if (!f.startsWith(roots[pre])) return res.writeHead(403).end();
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
    if (!fs.existsSync(f)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

// ── Browsers ─────────────────────────────────────────────────────────────
const ALLOW = [/^http:\/\/127\.0\.0\.1:/, /^https:\/\/tzzzzgdnnn\.github\.io\//, /^https:\/\/(api|image)\.themoviedb\.org\//, /^https:\/\/static\.tvmaze\.com\//, /peerjs\.com/, /^data:/, /^blob:/];

// Clients whose video segments from a given time on are held back (a phone
// on a stalling connection): kind -> first held-back second.
const stallFrom = new Map();
const segStart = (url) => Number(/seg(\d+)\.ts/.exec(url)?.[1] ?? -1) * 2;

async function routeAll(ctx, streamDir, kind) {
  await ctx.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(STREAM_HOST)) {
      while (stallFrom.has(kind) && segStart(url) >= stallFrom.get(kind)) await sleep(200);
      const f = path.join(streamDir, path.basename(new URL(url).pathname));
      if (!fs.existsSync(f)) return route.fulfill({ status: 404 });
      return route.fulfill({
        status: 200,
        body: fs.readFileSync(f),
        headers: { "content-type": f.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t", "access-control-allow-origin": "*" },
      });
    }
    if (ALLOW.some((re) => re.test(url))) return route.continue();
    return route.abort(); // streaming sites, embeds, trackers: never contacted
  });
}

function seed({ name, avatar }) {
  const id = name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 8);
  return { id, name, avatar };
}

// The local app server is on 127.0.0.1: never send it through an HTTP proxy.
const LAUNCH_ENV = { ...process.env, NO_PROXY: `127.0.0.1,localhost${process.env.NO_PROXY ? "," + process.env.NO_PROXY : ""}`, no_proxy: `127.0.0.1,localhost${process.env.no_proxy ? "," + process.env.no_proxy : ""}` };

// Chromium ignores a username/password in the *_PROXY variables: hand them over explicitly.
function chromiumProxy() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return {
      server: `${u.protocol}//${u.host}`,
      username: decodeURIComponent(u.username) || undefined,
      password: decodeURIComponent(u.password) || undefined,
      bypass: "127.0.0.1,localhost",
    };
  } catch {
    return undefined;
  }
}

async function makeClient(kind, { base, streamDir }) {
  const fakeMedia = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"];
  let browser, ctx, url, profile;
  if (kind === "iphone") {
    browser = await webkit.launch({ env: LAUNCH_ENV });
    ctx = await browser.newContext({ ...devices["iPhone 16e"], serviceWorkers: "block" });
    url = LIVE ? LIVE_URL : `${base}/web/`;
    profile = seed({ name: "Montez iPhone", avatar: "sp:ember" });
  } else if (kind === "android") {
    browser = await chromium.launch({ args: fakeMedia, env: LAUNCH_ENV, proxy: chromiumProxy() });
    ctx = await browser.newContext({ ...devices["Pixel 7"], permissions: ["microphone"], serviceWorkers: "block" });
    url = `${base}/android/`;
    profile = seed({ name: "Amy Android", avatar: "sp:ocean" });
    await ctx.addInitScript({ path: path.join(ROOT, "node_modules/hls.js/dist/hls.min.js") });
    await ctx.addInitScript({ path: path.join(ROOT, "scripts/party-e2e/fake-android.js") });
  } else {
    browser = await chromium.launch({ args: fakeMedia, env: LAUNCH_ENV, proxy: chromiumProxy() });
    ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, permissions: ["microphone"], serviceWorkers: "block" });
    url = LIVE ? LIVE_URL : `${base}/web/`;
    profile = seed({ name: "Desk Web", avatar: "sp:gold" });
  }
  await routeAll(ctx, streamDir, kind);
  await ctx.addInitScript(
    ({ profile, stream }) => {
      try {
        if (!localStorage.getItem("streambert_profiles")) {
          localStorage.setItem("streambert_profiles", JSON.stringify([{ id: profile.id, name: profile.name, avatar: profile.avatar, kids: false, gender: null, pin: null }]));
          localStorage.setItem("streambert_lastProfileId", JSON.stringify(profile.id));
        }
        localStorage.setItem("sbTestStream", stream);
        localStorage.setItem("sb_adblockSheet", "dismissed");
      } catch {}
    },
    { profile, stream: STREAM_URL },
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return { kind, browser, ctx, page, url, profile, errors, native: kind === "android" };
}

// ── Page helpers ─────────────────────────────────────────────────────────
const vidSel = (c) => (c.native ? "#fake-native-player video" : "video.sb-direct-video");

async function playerState(c) {
  return c.page.evaluate((sel) => {
    const v = [...document.querySelectorAll(sel)].find((x) => x.isConnected && !x.closest("[data-sb-warm]"));
    if (!v) return null;
    return { t: v.currentTime, paused: v.paused, ready: v.readyState, at: Date.now(), rate: v.playbackRate };
  }, vidSel(c));
}

// Largest distance (s) of each device from the group's median while all three play in steady state.
const maxDrift = {};
let steady = false; // set by scenarios once a start / seek has settled

/** Positions of all clients projected to one instant. */
async function positions(cs) {
  const s = await Promise.all(cs.map(playerState));
  if (s.some((x) => !x)) return { ok: false, s };
  const ref = Math.max(...s.map((x) => x.at));
  const t = s.map((x) => x.t + (x.paused ? 0 : ((ref - x.at) / 1000) * x.rate));
  const playing = s.map((x) => !x.paused);
  if (steady && cs.length === 3 && playing.every(Boolean)) {
    const med = [...t].sort((a, b) => a - b)[1];
    cs.forEach((c, i) => (maxDrift[c.kind] = Math.max(maxDrift[c.kind] || 0, Math.abs(t[i] - med))));
  }
  return { ok: true, s, t, spread: Math.max(...t) - Math.min(...t), playing };
}

async function waitFor(fn, ms = 30_000, step = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(step);
  }
  throw new Error(`timed out${last instanceof Error ? `: ${last.message}` : ""}`);
}

async function viewer(c, action, pos) {
  if (c.native) return c.page.evaluate(([a, p]) => (window.__fakeNative.tap(a, p), window.__fakeNative.video?.currentTime), [action, pos]);
  if (action === "stop") {
    // Leave the title page (the app's own Back): the party player closes.
    return c.page.evaluate(() => window.history.back());
  }
  return c.page.evaluate(
    ([sel, a, p]) => {
      const v = [...document.querySelectorAll(sel)].find((x) => x.isConnected && !x.closest("[data-sb-warm]"));
      v.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      if (a === "pause") v.pause();
      else if (a === "play") v.play();
      else if (a === "seek") v.currentTime = p;
      return v.currentTime;
    },
    [vidSel(c), action, pos],
  );
}

async function openFab(c) {
  await c.page.locator(".wp-fab").click({ timeout: 30_000 });
}

async function partyCode(c) {
  const t = await c.page.locator(".wp-code-pill").textContent({ timeout: 30_000 });
  return t.replace(/\s/g, "");
}

async function createParty(c) {
  await openFab(c);
  await c.page.locator(".wp-sheet .wp-btn-primary").click();
  return waitFor(async () => (await c.page.locator(".wp-code-pill").count()) && partyCode(c), 40_000);
}

async function joinParty(c, code) {
  await openFab(c);
  await c.page.locator(".wp-sheet .wp-code").fill(code);
  await c.page.locator(".wp-sheet button", { hasText: "Join" }).click();
  await c.page.locator(".wp-code-pill").waitFor({ timeout: 40_000 });
}

async function leaveParty(c) {
  if (await c.page.locator(".wp-bar button", { hasText: "Leave" }).count()) await c.page.locator(".wp-bar button", { hasText: "Leave" }).click();
}

async function pickBreakingBad(c) {
  await c.page.locator(".wp-bar button", { hasText: "Pick" }).click();
  await c.page.locator(".wp-pick input").fill("Breaking Bad");
  await c.page.locator(".wp-pick-row", { hasText: "Breaking Bad" }).first().click({ timeout: 20_000 });
  await c.page.locator(".wp-pick button", { hasText: "Watch S1 E1 together" }).click();
}

async function openTitleFromSearch(c) {
  // Search (top bar / tab bar), then the Breaking Bad result: its title page.
  await c.page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "/" })));
  const search = c.page.locator('input[type="search"], input.search-input, .nfs-field input').first();
  if (!(await search.count())) await c.page.locator('[aria-label="Search"], button:has-text("Search")').first().click();
  await search.fill("Breaking Bad");
  await c.page.keyboard.press("Enter");
  await c.page.locator(`img[alt*="Breaking Bad"], .nfs-tile:has-text("Breaking Bad"), text=Breaking Bad`).first().click({ timeout: 20_000 });
}

async function chatTexts(c) {
  return c.page.$$eval(".wp-chat-msg", (els) =>
    els.map((e) => ({
      name: e.querySelector(".wp-chat-name")?.textContent,
      text: e.querySelector(".wp-chat-text")?.textContent,
      pic: !!e.querySelector(".wp-chat-avatar img") || !!e.querySelector(".wp-chat-avatar")?.style.background,
    })),
  );
}

async function sendChat(c, text) {
  if (c.native && (await c.page.locator("#fake-native-player").count())) {
    // Typed in the Android player's own chat column (PlayerActivity), sent over the bridge.
    return c.page.evaluate((t) => window.__fakeNative.sendChat(t), text);
  }
  const input = c.page.locator(".wp-chat-compose input");
  if (!(await input.count())) await c.page.locator(".wp-chat-toggle").click();
  await input.fill(text);
  await input.press("Enter");
}

// ── Scenarios ────────────────────────────────────────────────────────────
const results = []; // { scenario, client, ok, detail }
const record = (scenario, client, ok, detail = "") => {
  results.push({ scenario, client, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${scenario} [${client}] ${detail}`);
};

async function scenario(name, clients, fn) {
  if (ONLY.length && !name.startsWith("home") && !ONLY.some((o) => name === o || name.startsWith(`${o}:`))) return;
  try {
    await fn();
  } catch (e) {
    fs.mkdirSync(CACHE, { recursive: true });
    const tag = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
    for (const c of clients) {
      await c.page.screenshot({ path: path.join(CACHE, `fail-${tag}-${c.kind}.png`) }).catch(() => {});
      const dom = await c.page
        .evaluate(() => ({
          videos: [...document.querySelectorAll("video")].map((v) => `${v.className}|rs${v.readyState}|p${v.paused}|t${v.currentTime.toFixed(1)}|w${v.offsetWidth}|warm${!!v.closest("[data-sb-warm]")}|buf${v.buffered.length ? v.buffered.end(v.buffered.length - 1).toFixed(1) : "-"}|par:${v.parentElement?.className?.slice?.(0, 40)}`),
          iframes: [...document.querySelectorAll("iframe")].map((f) => f.src.slice(0, 80)),
          bar: document.querySelector(".wp-bar")?.innerText.replace(/\s+/g, " "),
          ctx: window.__sbCtx && `${window.__sbCtx.type}:${window.__sbCtx.tmdbId}:${window.__sbCtx.season}:${window.__sbCtx.episode}`,
        }))
        .catch((x) => String(x));
      log(`  [${c.kind}] ${JSON.stringify(dom)} errors: ${c.errors.slice(-3).join(" | ").slice(0, 300)}`);
    }
    log(`scenario "${name}" failed: ${e.message.split("\n")[0]}`);
    for (const c of clients) if (!results.some((r) => r.scenario === name && r.client === c.kind)) record(name, c.kind, false, e.message.split("\n")[0]);
  }
}

async function allTogether(cs, { playing = true, tol = SYNC_TOL, ms = 45_000 } = {}) {
  return waitFor(async () => {
    const p = await positions(cs);
    return p.ok && p.playing.every((x) => x === playing) && p.spread < tol && p;
  }, ms);
}

async function main() {
  const streamDir = ensureStream();
  const { srv, base } = await serve();
  log(`app: ${LIVE ? LIVE_URL : base + "/web/"} | android bundle: ${base}/android/`);
  const ctxArgs = { base, streamDir };
  const [iphone, android, desktop] = await Promise.all(["iphone", "android", "desktop"].map((k) => makeClient(k, ctxArgs)));
  const all = [iphone, android, desktop];
  for (const c of all) {
    try {
      await c.page.locator(".wp-fab").waitFor({ timeout: 60_000 });
    } catch (e) {
      fs.mkdirSync(CACHE, { recursive: true });
      await c.page.screenshot({ path: path.join(CACHE, `noload-${c.kind}.png`) }).catch(() => {});
      throw new Error(`${c.kind}: app did not load (${c.errors.slice(0, 3).join(" | ")})`);
    }
  }
  log("all three apps loaded");

  // 1. Create on Home (iPhone), join from Home (Android, desktop), Pick + Play.
  let code;
  await scenario("home: create/join + Pick Breaking Bad S1E1 + start together", all, async () => {
    code = await createParty(iphone);
    record("home: create/join + Pick Breaking Bad S1E1 + start together", "iphone", true, `created ${code}`);
    log("party", code, "- Android and desktop join");
    await Promise.all([joinParty(android, code), joinParty(desktop, code)]);
    log("joined; waiting for 3/9");
    await waitFor(async () => (await iphone.page.locator(".wp-count").textContent()).startsWith("3/"), 30_000);
    log("3 in the party; iPhone picks Breaking Bad S1E1");
    await pickBreakingBad(iphone);
    log("picked; waiting for every player to open");
    await waitFor(async () => {
      const p = await positions(all);
      return p.ok;
    }, 60_000);
    // Pick + Play: nobody presses Play; the room starts everyone at once when all are loaded.
    const p = await allTogether(all);
    for (const c of all.slice(1)) record("home: create/join + Pick Breaking Bad S1E1 + start together", c.kind, true, `spread ${p.spread.toFixed(2)} s`);
  });

  // 1b. Freeze rule (Montez's case): Android's stream freezes at 1:30 while the
  //     others run on past it; the room pauses everyone back ON Android's frame
  //     (the frozen device is the source of truth) with "Waiting for <name>",
  //     and when Android has the video again all three resume from 1:30 together.
  await scenario("freeze-1:30", all, async () => {
    const T = 90;
    stallFrom.set("android", T);
    await viewer(desktop, "seek", T - 6);
    await allTogether(all, { tol: 0.2, ms: 30_000 });
    const held = await waitFor(async () => {
      const q = await positions(all);
      return q.ok && q.playing.every((x) => !x) && q.t.every((t) => Math.abs(t - T) < 0.3) && q;
    }, 40_000);
    const note = (await iphone.page.locator(".wp-bar").innerText()).replace(/\s+/g, " ");
    const androidAt = held.t[1];
    for (const [i, o] of all.entries())
      record("freeze-1:30", o.kind, Math.abs(held.t[i] - androidAt) < 0.05, `held at ${held.t[i].toFixed(3)} s (Android froze at ${androidAt.toFixed(3)} s, off by ${Math.round(Math.abs(held.t[i] - androidAt) * 1000)} ms)`);
    record("freeze-1:30", "iphone", /Waiting for Amy Android/.test(note), `bar: "${note.match(/Waiting for [^…]*…|Buffering…/)?.[0] || "no note"}"`);
    stallFrom.delete("android");
    const r = await allTogether(all, { tol: 0.15, ms: 60_000 });
    for (const [i, o] of all.entries()) record("freeze-1:30", o.kind, r.t[i] >= androidAt - 0.05, `resumed together from ${androidAt.toFixed(2)} s, now ${r.t[i].toFixed(2)} s, drift ${Math.round(r.spread * 1000)} ms`);
  });

  // 2. Pause / resume / seek, from each device in turn, ROUNDS times. The device
  //    that acts is the source of truth: everyone lands on its frame.
  const ROUNDS = Number(process.env.PARTY_E2E_ROUNDS || 2);
  const ms = (x) => `${Math.round(x * 1000)} ms`;
  for (let round = 1; round <= ROUNDS; round++) {
    for (const c of all) {
      await scenario(`pause:${c.kind}`, all, async () => {
        await allTogether(all, { ms: 30_000 });
        await sleep(1500);
        const at = await viewer(c, "pause");
        const p = await waitFor(async () => {
          const q = await positions(all);
          return q.ok && q.playing.every((x) => !x) && Math.max(...q.t.map((t) => Math.abs(t - at))) < 0.1 && q;
        }, 15_000);
        for (const [i, o] of all.entries()) record(`pause:${c.kind}`, o.kind, true, `round ${round}: paused at ${p.t[i].toFixed(3)} s, off the pauser's frame by ${ms(Math.abs(p.t[i] - at))}`);
      });
      await scenario(`resume:${c.kind}`, all, async () => {
        const before = await positions(all);
        const from = before.t[all.indexOf(c)];
        await viewer(c, "play");
        const p = await allTogether(all, { tol: 0.15, ms: 20_000 });
        for (const [i, o] of all.entries()) {
          const ok = p.t[i] >= from - 0.05;
          record(`resume:${c.kind}`, o.kind, ok, `round ${round}: resumed from ${from.toFixed(3)} s, now ${p.t[i].toFixed(3)} s, drift to the others ${ms(p.spread)}`);
        }
        await sleep(2000);
        const q = await positions(all);
        for (const [i, o] of all.entries()) if (!q.playing[i] || q.spread > 0.15) record(`resume:${c.kind}`, o.kind, false, `round ${round}: 2 s later ${q.playing[i] ? "playing" : "PAUSED"}, drift ${ms(q.spread)}`);
      });
      for (const [label, delta] of [["skip +30 s (skip intro)", 30], ["back 10 s", -10], ["forward 10 s", 10]]) {
        await scenario(`seek:${c.kind}`, all, async () => {
          const before = (await playerState(c)).t;
          const target = Math.min(280, Math.max(2, before + delta));
          await viewer(c, "seek", target);
          const p = await waitFor(async () => {
            const q = await positions(all);
            return q.ok && q.playing.every(Boolean) && q.t.every((t) => t >= target - 0.1 && t < target + 8) && q.spread < 0.15 && q;
          }, 30_000);
          for (const [i, o] of all.entries()) record(`seek:${c.kind}`, o.kind, true, `round ${round}, ${label}: everyone to ${target.toFixed(1)} s, now ${p.t[i].toFixed(2)} s, drift ${ms(p.spread)}`);
        });
      }
    }
  }

  // 2c. Steady playback: sample every 250 ms for 30 s; every device stays within 150 ms of the others.
  await scenario("drift", all, async () => {
    await allTogether(all, { tol: 0.15, ms: 30_000 });
    await sleep(2000);
    steady = true;
    const worst = {};
    for (let i = 0; i < 120; i++) {
      const q = await positions(all);
      if (q.ok && q.playing.every(Boolean)) {
        const med = [...q.t].sort((a, b) => a - b)[1];
        all.forEach((c, j) => (worst[c.kind] = Math.max(worst[c.kind] || 0, Math.abs(q.t[j] - med))));
      }
      await sleep(250);
    }
    steady = false;
    for (const c of all) record("drift", c.kind, (worst[c.kind] ?? 1) <= 0.15, `30 s of playback: max ${Math.round((worst[c.kind] ?? NaN) * 1000)} ms from the group`);
  });

  // 3. Stop (close the player) from each client: everyone pauses; reopen and play on.
  for (const c of all) {
    await scenario(`stop:${c.kind}`, all, async () => {
      await allTogether(all);
      await viewer(c, "stop");
      const others = all.filter((o) => o !== c);
      await waitFor(async () => {
        const q = await positions(others);
        return q.ok && q.playing.every((x) => !x);
      }, 30_000);
      for (const o of others) record(`stop:${c.kind}`, o.kind, true, "paused when the other player closed");
      // Back into the party's title, then play together again.
      if (c.native) await c.page.locator("button", { hasText: /Resume|Play/ }).first().click({ timeout: 20_000 });
      else await c.page.locator(".wp-now").click({ timeout: 20_000 });
      await waitFor(async () => !!(await playerState(c)), 40_000);
      await viewer(others[0], "play");
      await allTogether(all, { ms: 60_000 });
      record(`stop:${c.kind}`, c.kind, true, "reopened and back in sync");
    });
  }

  // 4. Chat from each client reaches the other two, with names and pictures.
  await scenario("chat", all, async () => {
    for (const c of all) await sendChat(c, `hello from ${c.kind}`);
    for (const c of all) {
      if (c.native && (await c.page.locator("#fake-native-player").count())) {
        // The Android player's chat column gets every message with a picture.
        const msgs = await waitFor(async () => {
          const m = await c.page.evaluate(() => window.__fakeNative.chat);
          return all.every((o) => m.some((x) => x.text === `hello from ${o.kind}`)) && m;
        }, 20_000);
        const ok = msgs.every((m) => m.initial && (m.avatarUrl || m.avatarFrom));
        record("chat", c.kind, ok, `native chat column: ${msgs.length} messages, names ${[...new Set(msgs.map((m) => m.name))].join(" / ")}${ok ? ", pictures on every line" : ", MISSING pictures"}`);
      } else {
        const msgs = await waitFor(async () => {
          const m = await chatTexts(c);
          return all.every((o) => m.some((x) => x.text === `hello from ${o.kind}`)) && m;
        }, 20_000);
        const names = msgs.filter((m) => m.name !== "You").map((m) => m.name);
        const okNames = all.filter((o) => o !== c).every((o) => names.includes(o.profile.name));
        const okPics = msgs.every((m) => m.pic);
        record("chat", c.kind, okNames && okPics, `${msgs.length} messages from ${[...new Set(names)].join(", ")}${okPics ? ", pictures on every line" : ", MISSING pictures"}`);
      }
    }
  });

  // 5. Voice: everyone turns the mic on; every client receives two live remote audio tracks.
  await scenario("voice", all, async () => {
    for (const c of all) {
      const clicked = await c.page.locator('.wp-bar button[aria-label="Microphone"]').click({ timeout: 5000 }).then(() => true, () => false);
      if (!clicked && c.native) await c.page.evaluate(() => document.querySelector('.wp-bar button[aria-label="Microphone"]')?.click());
    }
    for (const c of all) {
      try {
        const r = await waitFor(async () => {
          const s = await c.page.evaluate(() =>
            [...document.querySelectorAll("audio[data-voice-peer]")].map((a) => ({
              peer: a.dataset.voicePeer,
              live: !!a.srcObject && a.srcObject.getAudioTracks().some((t) => t.readyState === "live"),
              playing: !a.paused,
            })),
          );
          return s.filter((x) => x.live).length >= 2 && s;
        }, 30_000);
        record("voice", c.kind, true, `${r.filter((x) => x.live).length} live remote voices (${r.filter((x) => x.playing).length} playing)`);
      } catch (e) {
        const notice = await c.page.locator(".wp-notice").textContent().catch(() => "");
        record("voice", c.kind, false, `${e.message}${notice ? ` (${notice})` : ""}`);
      }
    }
  });

  // 6. Reconnect after a drop (Android offline 6 s): back in sync, nobody else paused.
  await scenario("reconnect", all, async () => {
    await allTogether(all, { ms: 30_000 }).catch(() => viewer(iphone, "play"));
    await allTogether(all, { ms: 30_000 });
    await android.ctx.setOffline(true);
    await sleep(6000);
    const others = await positions([iphone, desktop]);
    record("reconnect", "iphone", others.playing[0], "kept playing while Android was offline");
    record("reconnect", "desktop", others.playing[1], "kept playing while Android was offline");
    await android.ctx.setOffline(false);
    const p = await allTogether(all, { ms: 60_000 });
    record("reconnect", "android", true, `back in sync, spread ${p.spread.toFixed(2)} s`);
  });

  // 7. Late joiner: desktop leaves and rejoins while the others play; it lands on the live position.
  await scenario("late-join", all, async () => {
    await leaveParty(desktop);
    await sleep(4000);
    await joinParty(desktop, code);
    const p = await allTogether(all, { ms: 60_000 });
    record("late-join", "desktop", true, `caught up, spread ${p.spread.toFixed(2)} s`);
    record("late-join", "iphone", p.playing[0], "never paused for the joiner");
    record("late-join", "android", p.playing[1], "never paused for the joiner");
  });

  // 8. Start from the title page: desktop opens Breaking Bad, starts a party there; the others join.
  await scenario("title-page", all, async () => {
    for (const c of all) await leaveParty(c);
    await sleep(2000);
    await desktop.page.goto(desktop.url);
    await desktop.page.locator(".wp-fab").waitFor();
    await openTitleFromSearch(desktop);
    await openFab(desktop);
    const label = await desktop.page.locator(".wp-sheet .wp-btn-primary").textContent();
    record("title-page", "desktop", /Breaking Bad/.test(label), `start button: "${label}"`);
    await desktop.page.locator(".wp-sheet .wp-btn-primary").click();
    const code2 = await waitFor(async () => (await desktop.page.locator(".wp-code-pill").count()) && partyCode(desktop), 40_000);
    await Promise.all([joinParty(iphone, code2), joinParty(android, code2)]);
    await waitFor(async () => (await positions(all)).ok, 60_000);
    const p = await allTogether(all, { ms: 60_000 });
    record("title-page", "iphone", true, `opened the party's title, spread ${p.spread.toFixed(2)} s`);
    record("title-page", "android", true, `opened the party's title, spread ${p.spread.toFixed(2)} s`);
  });

  // ── Report ──
  const scen = [...new Set(results.map((r) => r.scenario))];
  const kinds = ["iphone", "android", "desktop"];
  const lines = [`# Watch Party cross-device test (${LIVE ? "live web app" : "local build"}) ${new Date().toISOString()}`, "", `| scenario | ${kinds.join(" | ")} |`, `|---|${kinds.map(() => "---").join("|")}|`];
  for (const s of scen) lines.push(`| ${s} | ${kinds.map((k) => { const r = results.filter((x) => x.scenario === s && x.client === k); return r.length ? (r.every((x) => x.ok) ? "PASS" : "FAIL") : "–"; }).join(" | ")} |`);
  lines.push("", "Max drift per device during steady playback: " + Object.entries(maxDrift).map(([k, v]) => `${k} ${Math.round(v * 1000)} ms`).join(", "));
  lines.push("", "A/V (lip) sync: not measurable here. Headless browsers mute audio output and the emulated devices have no speakers, so audio-vs-video offset inside a player cannot be observed; each player plays one item (audio and video share one clock) and every party correction moves the whole item (seek / rate), never one track. Real-device check needed.");
  lines.push("", "## Details", ...results.map((r) => `- ${r.ok ? "PASS" : "FAIL"} ${r.scenario} [${r.client}] ${r.detail}`));
  const errs = all.flatMap((c) => c.errors.slice(0, 20).map((e) => `- [${c.kind}] ${e.slice(0, 200)}`));
  if (errs.length) lines.push("", "## Page errors (first 20 per client)", ...errs);
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, `report-${LIVE ? "live" : "local"}.md`);
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log("\n" + lines.join("\n") + `\n\nreport: ${out}`);
  for (const c of all) await c.browser.close();
  srv.close();
  process.exit(results.some((r) => !r.ok) || !results.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
