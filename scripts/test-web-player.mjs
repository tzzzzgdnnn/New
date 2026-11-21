// Dev-only: the web app's embed player (src/platform/ios/webview.js) in a
// simulated DOM (happy-dom), built as the web app (VITE_WEB). Guards #19
// (iPhone Safari / home-screen app crashing) and #26 (Cinezo skipped by Auto):
//  - a <webview> that leaves the page releases its window listeners, timers,
//    embed page and prewarm hold (one "message" listener used to leak per title)
//  - the hidden prewarm player is dropped, and never re-created, while an
//    embed page is on screen (two streams at once)
//  - web Auto's failover is bounded (no reload loop, also with "auto" stored)
//  - Cinezo plays through player.cinezo.live and its PLAYER_EVENT counts as
//    started, so the 8 s no-start watch keeps it
// Bundled by scripts/run-ios-tests.sh with VITE_WEB=1. Not shipped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

const win = new Window({ url: "https://tzzzzgdnnn.github.io/New/", settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
for (const k of ["document", "navigator", "HTMLElement", "Node", "Event", "CustomEvent", "MessageEvent", "MutationObserver", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "location"]) {
  try { globalThis[k] = win[k]; } catch { Object.defineProperty(globalThis, k, { value: win[k], configurable: true }); }
}
globalThis.window = win;
globalThis.fetch = async () => ({ ok: false, status: 0, type: "opaque", json: async () => null, text: async () => "" });
win.fetch = globalThis.fetch;

// Count live window "message" listeners.
const live = new Map(); // type -> Set of listeners
const add = win.addEventListener.bind(win);
const rem = win.removeEventListener.bind(win);
win.addEventListener = (type, fn, opts) => {
  if (!live.has(type)) live.set(type, new Set());
  live.get(type).add(fn);
  return add(type, fn, opts);
};
win.removeEventListener = (type, fn, opts) => {
  live.get(type)?.delete(fn);
  return rem(type, fn, opts);
};
const count = (type) => live.get(type)?.size || 0;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const bundled = (await import("../servers.json")).default;
const { PLAYER_SOURCES } = await import("../src/utils/api.js");
const { applyServers } = await import("../src/platform/ios/servers.js");
const { installWebviewPolyfill } = await import("../src/platform/ios/webview.js");
const { prewarmDirect, warmVideo, prewarmHeld } = await import("../src/platform/web/directPlayer.js");
applyServers(bundled);
installWebviewPolyfill();

const VIDFAST = "https://vidfast.vc/movie/550";
const mount = async (src) => {
  const wv = document.createElement("webview");
  wv.setAttribute("src", src);
  document.body.appendChild(wv);
  await tick();
  return wv;
};
const unmount = async (wv) => {
  wv.remove();
  await tick(10);
};

test("web server list: Vidfast first, Cinezo through its bare player page", () => {
  assert.equal(PLAYER_SOURCES[0].id, "vidfast");
  const cz = PLAYER_SOURCES.find((s) => s.id === "cinezo");
  assert.ok(cz, "cinezo listed on web");
  assert.equal(cz.movieUrl("550"), "https://player.cinezo.live/embed/movie/550");
  assert.equal(cz.tvUrl("1396", 1, 2), "https://player.cinezo.live/embed/tv/1396/1/2");
});

test("#19: a removed <webview> releases its window message listener, iframe and timers", async () => {
  const base = count("message");
  for (let i = 0; i < 6; i++) {
    const wv = await mount(VIDFAST);
    const iframe = wv.querySelector("iframe");
    assert.ok(iframe, "upgraded");
    assert.equal(iframe.getAttribute("src"), VIDFAST);
    assert.equal(count("message"), base + 1, "one listener while mounted");
    await unmount(wv);
    assert.equal(count("message"), base, `listener released after title ${i + 1}`);
    assert.equal(wv.querySelector("iframe"), null, "embed page removed");
    assert.equal(typeof wv.__sbTeardown, "undefined");
  }
});

test("#19: a <webview> moved within the page is kept, not torn down", async () => {
  const base = count("message");
  const wv = await mount(VIDFAST);
  const box = document.createElement("div");
  document.body.appendChild(box);
  box.appendChild(wv); // removed + added in the same task
  await tick(10);
  assert.ok(wv.querySelector("iframe"), "still upgraded");
  assert.equal(count("message"), base + 1);
  await unmount(box);
  assert.equal(count("message"), base);
});

test("#19: prewarm player is dropped while an embed plays, and not re-created", async () => {
  prewarmDirect("https://cdn.example/a/master.m3u8");
  const v = warmVideo();
  assert.ok(v, "warm-up player loaded on the title page");
  assert.ok(v.closest("[data-sb-warm]"));
  const wv = await mount(VIDFAST);
  assert.equal(prewarmHeld(), true, "embed holds prewarm");
  assert.equal(warmVideo(), null, "warm-up dropped when the embed went on screen");
  assert.equal(v.isConnected, false, "warm-up <video> removed");
  assert.equal(v.getAttribute("src"), null, "warm-up <video> unloaded");
  prewarmDirect("https://cdn.example/b/master.m3u8");
  assert.equal(warmVideo(), null, "no new warm-up while the embed is on screen");
  // Embed blanked (e.g. switched to a direct stream): hold released.
  wv.setAttribute("src", "about:blank");
  await tick();
  assert.equal(prewarmHeld(), false);
  wv.setAttribute("src", VIDFAST);
  await tick();
  assert.equal(prewarmHeld(), true);
  await unmount(wv);
  assert.equal(prewarmHeld(), false, "hold released when the player leaves");
  prewarmDirect("https://cdn.example/c/master.m3u8");
  assert.ok(warmVideo(), "prewarm works again after");
});

// Ready window shortened for the tests (30 s in the app).
win.__sbEmbedReadyMs = 300;
const urlFor = (id, ctx) => {
  const s = PLAYER_SOURCES.find((p) => p.id === id);
  return ctx.type === "tv" ? s.tvUrl(ctx.tmdbId, ctx.season, ctx.episode) : s.movieUrl(ctx.tmdbId);
};
// Mounts `src`, optionally posts `message` from the embed, and plays the page's
// part: an automatic server switch swaps the <webview> src like the page does.
async function watchRun({ src, message, stored = null, foreign = false, follow = false, waitMs = 450 }) {
  localStorage.clear();
  if (stored) localStorage.setItem("streambert_playerSource", JSON.stringify(stored));
  win.__sbCtx = { type: "movie", tmdbId: 550 + Math.floor(Math.random() * 1e6), progressKey: null };
  const wv = await mount(src);
  const iframe = wv.querySelector("iframe");
  const picks = [];
  const onPick = (e) => {
    picks.push(e.detail);
    if (follow) { localStorage.setItem("streambert_playerSource", JSON.stringify(e.detail)); setTimeout(() => wv.setAttribute("src", urlFor(e.detail, win.__sbCtx)), 5); }
  };
  win.addEventListener("sb-select-server", onPick);
  let fails = 0;
  wv.addEventListener("did-fail-load", () => fails++);
  iframe.dispatchEvent(new win.Event("load"));
  if (message) win.dispatchEvent(new win.MessageEvent("message", { data: message, source: foreign ? win : iframe.contentWindow }));
  await tick(waitMs);
  win.removeEventListener("sb-select-server", onPick);
  const text = wv.querySelector(".sb-native-card")?.textContent || "";
  await unmount(wv);
  return { picks, fails, text };
}

const CINEZO = "https://player.cinezo.live/embed/movie/550";
const PLAYER_EVENT = { type: "PLAYER_EVENT", data: { event: "timeupdate", currentTime: 3, duration: 8340, tmdbId: 550, mediaType: "movie" } };
win.__sbPlayAfterTapMs = 200;

test("#26: Cinezo's PLAYER_EVENT counts as started (Auto keeps it)", async () => {
  const r = await watchRun({ src: CINEZO, message: PLAYER_EVENT });
  assert.equal(r.fails, 0, "no did-fail-load");
  assert.deepEqual(r.picks, [], "no automatic switch");
});

test("#26: Cinezo's PLAYER_EVENT as a JSON string counts too; a ready player at 0 s waits for the tap", async () => {
  const r = await watchRun({ src: CINEZO, message: JSON.stringify(PLAYER_EVENT) });
  assert.deepEqual(r.picks, []);
  const zero = await watchRun({ src: CINEZO, message: { type: "PLAYER_EVENT", data: { event: "play", currentTime: 0, duration: 8340 } } });
  assert.equal(zero.fails, 0, "a player that said it is ready is kept (waits for the viewer's tap)");
  const ghost = await watchRun({ src: CINEZO, message: { type: "PLAYER_EVENT", data: { event: "play", currentTime: 0, duration: 0 } } });
  assert.equal(ghost.fails, 1, "Cinezo's play event with no duration (no stream) is not ready: next server");
  const md = await watchRun({ src: CINEZO, message: { type: "MEDIA_DATA", data: { id: 550, progress: { watched: 0, duration: 0 } } } });
  assert.equal(md.fails, 1, "Cinezo's MEDIA_DATA alone is not ready (#26 ghost)");
  const other = await watchRun({ src: CINEZO, message: PLAYER_EVENT, foreign: true });
  assert.equal(other.fails, 1, "PLAYER_EVENT from another window is ignored");
});

test("Auto: an embed with no sign of playback moves to the next server", async () => {
  const r = await watchRun({ src: CINEZO });
  assert.equal(r.fails, 1);
  assert.equal(r.picks.length, 1);
  assert.notEqual(r.picks[0], "cinezo", "never re-picks the server that failed");
});

test("#19: web Auto failover is bounded (no loop), also with 'auto' stored as the pick", async () => {
  for (const stored of [null, "auto"]) {
    const r = await watchRun({ src: VIDFAST, stored, follow: true, waitMs: 4000 });
    const n = PLAYER_SOURCES.length;
    assert.ok(r.picks.length <= n, `${r.picks.length} switches <= ${n} servers (stored ${stored})`);
    assert.equal(new Set(r.picks).size, r.picks.length, `no server picked twice: ${r.picks}`);
    assert.ok(!r.picks.includes("auto"));
    assert.ok(r.picks.length >= 1, "it did fail over");
    assert.match(r.text, /No other server worked/, `ends on our own card: ${r.picks}`);
  }
});

// The embed page is hidden behind our own card until it says it has the title;
// an error page (Vidfast's 404 / "Please Disable Sandbox") is never shown.
test("web: embed hidden until ready; Vidfast status 404 skips at once, never shown", async () => {
  localStorage.clear();
  win.__sbCtx = { type: "tv", tmdbId: 306499, season: 1, episode: 1, progressKey: null };
  const wv = await mount("https://vidfast.vc/tv/306499/1/1");
  const iframe = wv.querySelector("iframe");
  const card = wv.querySelector(".sb-native-card");
  assert.equal(card.style.display, "flex", "our card covers the embed while it loads");
  assert.match(card.textContent, /Finding the stream/);
  const picks = [];
  const onPick = (e) => picks.push(e.detail);
  win.addEventListener("sb-select-server", onPick);
  win.dispatchEvent(new win.MessageEvent("message", { data: { event: "status", data: 404 }, source: iframe.contentWindow }));
  win.removeEventListener("sb-select-server", onPick);
  assert.equal(iframe.getAttribute("src"), "about:blank", "error page unloaded at once");
  assert.equal(picks.length, 1, "Auto moved on");
  assert.notEqual(picks[0], "vidfast");
  await unmount(wv);
});

test("web: a ready message reveals the embed; a hand-picked server that 404s shows our own card", async () => {
  localStorage.clear();
  win.__sbCtx = { type: "tv", tmdbId: 306499, season: 1, episode: 1, progressKey: null };
  let wv = await mount("https://player.cinezo.live/embed/tv/306499/1/1");
  let iframe = wv.querySelector("iframe");
  win.dispatchEvent(new win.MessageEvent("message", { data: { type: "MEDIA_DATA", data: { id: 306499 } }, source: iframe.contentWindow }));
  assert.equal(wv.querySelector(".sb-native-card").style.display, "flex", "Cinezo's MEDIA_DATA alone keeps our card");
  win.dispatchEvent(new win.MessageEvent("message", { data: { type: "PLAYER_EVENT", data: { event: "timeupdate", currentTime: 0, duration: 2580 } }, source: iframe.contentWindow }));
  assert.equal(wv.querySelector(".sb-native-card").style.display, "none");
  await unmount(wv);
  localStorage.setItem("streambert_serverAutoPick", "false");
  localStorage.setItem("streambert_playerSource", JSON.stringify("vidfast"));
  wv = await mount("https://vidfast.vc/tv/306499/1/1");
  iframe = wv.querySelector("iframe");
  win.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify({ event: "status", data: 404 }), source: iframe.contentWindow }));
  assert.equal(iframe.getAttribute("src"), "about:blank");
  assert.match(wv.querySelector(".sb-native-card").textContent, /Not available on this server/);
  await unmount(wv);
  localStorage.clear();
});

test("#26: Cinezo playing a stand-in or a far longer video is the wrong one: next server at once", async () => {
  localStorage.clear();
  for (const [ctx, dur] of [
    [{ type: "tv", tmdbId: 90249, season: 1, episode: 1, progressKey: null }, 9469], // Cinezo's "2012"
    [{ type: "tv", tmdbId: 91421, season: 1, episode: 1, runtime: 42, progressKey: null }, 7000],
    [{ type: "movie", tmdbId: 777, runtime: 95, progressKey: null }, 12000],
  ]) {
    win.__sbCtx = ctx;
    const src = ctx.type === "tv" ? `https://player.cinezo.live/embed/tv/${ctx.tmdbId}/1/1` : `https://player.cinezo.live/embed/movie/${ctx.tmdbId}`;
    const wv = await mount(src);
    const iframe = wv.querySelector("iframe");
    const picks = [];
    const onPick = (e) => picks.push(e.detail);
    win.addEventListener("sb-select-server", onPick);
    win.dispatchEvent(new win.MessageEvent("message", { data: { type: "PLAYER_EVENT", data: { event: "timeupdate", currentTime: 4, duration: dur } }, source: iframe.contentWindow }));
    win.removeEventListener("sb-select-server", onPick);
    assert.equal(iframe.getAttribute("src"), "about:blank", `${dur} s video for ${ctx.type} ${ctx.tmdbId} dropped`);
    assert.equal(picks.length, 1, "Auto moved on");
    await unmount(wv);
  }
  // A real episode (close to its runtime) stays.
  win.__sbCtx = { type: "tv", tmdbId: 1396, season: 1, episode: 1, runtime: 58, progressKey: null };
  const wv = await mount("https://player.cinezo.live/embed/tv/1396/1/1");
  const iframe = wv.querySelector("iframe");
  win.dispatchEvent(new win.MessageEvent("message", { data: { type: "PLAYER_EVENT", data: { event: "timeupdate", currentTime: 4, duration: 3500 } }, source: iframe.contentWindow }));
  assert.notEqual(iframe.getAttribute("src"), "about:blank");
  await unmount(wv);
});

test("#26: Cinezo ready but not playing within the window after the tap: next server, no endless spinner", async () => {
  localStorage.clear();
  win.__sbCtx = { type: "tv", tmdbId: 1396, season: 1, episode: 1, runtime: 58, progressKey: null };
  const wv = await mount("https://player.cinezo.live/embed/tv/1396/1/1");
  const iframe = wv.querySelector("iframe");
  let fails = 0;
  wv.addEventListener("did-fail-load", () => fails++);
  iframe.dispatchEvent(new win.Event("load"));
  win.dispatchEvent(new win.MessageEvent("message", { data: { type: "PLAYER_EVENT", data: { event: "play", currentTime: 0, duration: 3500 } }, source: iframe.contentWindow }));
  await tick(400);
  assert.equal(fails, 0, "no tap yet: the ready player waits");
  wv.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true }));
  await tick(400);
  assert.equal(fails, 1, "tapped, never played: next server");
  await unmount(wv);
  // Tapped and playing: kept.
  const wv2 = await mount("https://player.cinezo.live/embed/tv/1396/1/1");
  const f2 = wv2.querySelector("iframe");
  let fails2 = 0;
  wv2.addEventListener("did-fail-load", () => fails2++);
  f2.dispatchEvent(new win.Event("load"));
  win.dispatchEvent(new win.MessageEvent("message", { data: { type: "PLAYER_EVENT", data: { event: "play", currentTime: 0, duration: 3500 } }, source: f2.contentWindow }));
  wv2.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true }));
  win.dispatchEvent(new win.MessageEvent("message", { data: { type: "PLAYER_EVENT", data: { event: "timeupdate", currentTime: 2, duration: 3500 } }, source: f2.contentWindow }));
  await tick(400);
  assert.equal(fails2, 0, "playing after the tap: kept");
  await unmount(wv2);
});
