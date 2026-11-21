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
import { test, mock } from "node:test";
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

// Auto no-start watch: run with fake timers.
async function watchRun({ src, message, rounds = 1, stored = null, foreign = false }) {
  localStorage.clear();
  if (stored) localStorage.setItem("streambert_playerSource", JSON.stringify(stored));
  win.__sbCtx = { type: "movie", tmdbId: 550 + Math.floor(Math.random() * 1e6), progressKey: null };
  const wv = await mount(src);
  const iframe = wv.querySelector("iframe");
  const picks = [];
  const onPick = (e) => picks.push(e.detail);
  win.addEventListener("sb-select-server", onPick);
  let fails = 0;
  wv.addEventListener("did-fail-load", () => fails++);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (let r = 0; r < rounds; r++) {
      iframe.dispatchEvent(new win.Event("load"));
      if (message) win.dispatchEvent(new win.MessageEvent("message", { data: message, source: foreign ? win : iframe.contentWindow }));
      mock.timers.tick(8_500);
    }
  } finally {
    mock.timers.reset();
  }
  win.removeEventListener("sb-select-server", onPick);
  const text = wv.querySelector(".sb-native-card")?.textContent || "";
  await unmount(wv);
  return { picks, fails, text };
}

const CINEZO = "https://player.cinezo.live/embed/movie/550";
const PLAYER_EVENT = { type: "PLAYER_EVENT", data: { event: "timeupdate", currentTime: 3, duration: 0, tmdbId: 550, mediaType: "movie" } };

test("#26: Cinezo's PLAYER_EVENT counts as started (Auto keeps it)", async () => {
  const r = await watchRun({ src: CINEZO, message: PLAYER_EVENT });
  assert.equal(r.fails, 0, "no did-fail-load");
  assert.deepEqual(r.picks, [], "no automatic switch");
});

test("#26: Cinezo's PLAYER_EVENT as a JSON string counts too; a ready player at 0 s waits for the tap", async () => {
  const r = await watchRun({ src: CINEZO, message: JSON.stringify(PLAYER_EVENT) });
  assert.deepEqual(r.picks, []);
  const zero = await watchRun({ src: CINEZO, message: { type: "PLAYER_EVENT", data: { event: "play", currentTime: 0 } } });
  assert.equal(zero.fails, 0, "a player that said it is ready is kept (waits for the viewer's tap)");
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
    const r = await watchRun({ src: VIDFAST, rounds: 12, stored });
    const n = PLAYER_SOURCES.length;
    assert.ok(r.picks.length <= n, `${r.picks.length} switches <= ${n} servers (stored ${stored})`);
    assert.equal(new Set(r.picks).size, r.picks.length, `no server picked twice: ${r.picks}`);
    assert.ok(!r.picks.includes("auto"));
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
