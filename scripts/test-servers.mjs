// Dev-only: server catalog (Sub/Dub grouping, every dub server listed),
// servers.json anime templates and the native candidate list. Not bundled.
import assert from "node:assert/strict";
import { test } from "node:test";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.window = globalThis;
window.addEventListener = () => {};
globalThis.document = { addEventListener: () => {}, visibilityState: "visible" };

const { serverCatalog, groupServers, parseServerKey, serverKey } = await import("../src/utils/servers/catalog.js");
const { nativeServerList, sourcesForContent } = await import("../src/utils/api.js");
const { applyServers } = await import("../src/platform/ios/servers.js");
const { downloadCandidates } = await import("../src/platform/ios/webview.js");
const bundled = (await import("../servers.json")).default;

const src = (id, anime = false) => ({
  id,
  label: id.toUpperCase(),
  ...(anime ? { animeUrl: (a, e, l) => `https://${id}/${a}/${e}/${l}` } : {}),
});

test("non-anime: one ungrouped entry per server", () => {
  const groups = groupServers(serverCatalog([src("a"), src("b", true)], false));
  assert.deepEqual(groups.map((g) => g.mode), [null]);
  assert.deepEqual(groups[0].servers.map((e) => e.key), ["a", "b"]);
});

test("anime: every server under Sub, every anime route under Dub", () => {
  const groups = groupServers(serverCatalog([src("a"), src("b", true), src("c", true)], true));
  assert.deepEqual(groups.map((g) => g.label), ["Sub", "Dub"]);
  assert.deepEqual(groups[0].servers.map((e) => e.key), ["a", "b:sub", "c:sub"]);
  assert.deepEqual(groups[1].servers.map((e) => e.key), ["b:dub", "c:dub"]);
});

test("server keys round-trip", () => {
  assert.deepEqual(parseServerKey(serverKey("vidnest", "dub")), { sourceId: "vidnest", mode: "dub" });
  assert.deepEqual(parseServerKey("vidsrc"), { sourceId: "vidsrc", mode: null });
});

test("bundled config: more than one Dub server, all labelled", () => {
  applyServers(bundled);
  const dub = nativeServerList(true).filter((s) => s.id.endsWith(":dub"));
  assert.ok(dub.length >= 2, `dub servers: ${dub.map((s) => s.id)}`);
  assert.ok(dub.every((s) => s.label.endsWith(" · Dub")));
  const routes = sourcesForContent(true).filter((s) => s.animeUrl && !s.async);
  assert.equal(dub.length, routes.length);
});

test("bundled config: Sub lists every anime-capable server", () => {
  applyServers(bundled);
  const sub = nativeServerList(true).filter((s) => !s.id.endsWith(":dub"));
  assert.equal(sub.length, sourcesForContent(true).filter((s) => !s.async).length);
});

test("servers.json anime template adds a Dub server", () => {
  applyServers({
    ...bundled,
    servers: [
      ...bundled.servers,
      { id: "zz", name: "ZZ", movie: "https://zz/m/{tmdb}", tv: "https://zz/t/{tmdb}/{season}/{episode}", anime: "https://zz/a/{anilist}/{episode}/{lang}" },
    ],
  });
  const dub = nativeServerList(true).find((s) => s.id === "zz:dub");
  assert.equal(dub?.label, "ZZ · Dub");
  const zz = sourcesForContent(true).find((s) => s.id === "zz");
  assert.equal(zz.animeUrl(21, 5, "dub"), "https://zz/a/21/5/dub");
  applyServers(bundled);
});

test("Dub playback tries every dub route, never a TMDB (sub) route", () => {
  applyServers(bundled);
  window.__sbCtx = { isAnime: true, dubMode: "dub", type: "tv", tmdbId: 1429, anilistId: 16498, episode: 3 };
  const list = downloadCandidates();
  assert.ok(list.length >= 2);
  assert.ok(list.every((c) => c.id.endsWith(":dub")));
  assert.ok(list.some((c) => c.url === "https://embed.vidrift.net/embed/anilist/16498/3?dub=1"));
  assert.ok(list.some((c) => c.url === "https://vidnest.fun/anime/16498/3/dub"));
});

test("Sub candidates: TMDB-route servers keep plain ids matching the menu", () => {
  applyServers(bundled);
  window.__sbCtx = { isAnime: true, dubMode: "sub", type: "tv", tmdbId: 1429, anilistId: 16498, episode: 3 };
  const menu = new Set(nativeServerList(true).map((s) => s.id));
  for (const c of downloadCandidates()) assert.ok(menu.has(c.id), `${c.id} not in the menu`);
});

const { settleEach } = await import("../src/utils/servers/concurrent.js");
const delay = (ms, v, signal) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => res(v), ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), rej(new Error("aborted"))));
  });

test("settleEach reports each result as it settles, fastest first", async () => {
  const seen = [];
  const out = await settleEach([30, 5, 15], (ms, signal) => delay(ms, ms, signal), {
    onSettled: (r) => seen.push(r.item),
  });
  assert.deepEqual(seen, [5, 15, 30]);
  assert.deepEqual(out.map((r) => r.value), [5, 15, 30]);
});

test("settleEach never waits on a slow job past its timeout, and aborts it", async () => {
  let abortedSlow = false;
  const started = Date.now();
  const out = await settleEach(
    ["fast", "slow"],
    (id, signal) => {
      signal.addEventListener("abort", () => id === "slow" && (abortedSlow = true));
      return delay(id === "fast" ? 5 : 10_000, id, signal);
    },
    { timeoutMs: 40 },
  );
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(out.map((r) => [r.item, r.ok]), [["fast", true], ["slow", false]]);
  assert.ok(abortedSlow);
});

test("settleEach: a thrown job fails alone; a parent abort cancels the rest", async () => {
  const parent = new AbortController();
  const done = settleEach(
    ["boom", "wait"],
    (id, signal) => {
      if (id === "boom") throw new Error("boom");
      return delay(10_000, id, signal);
    },
    { signal: parent.signal, timeoutMs: 10_000 },
  );
  setTimeout(() => parent.abort(), 10);
  const out = await done;
  assert.ok(out.every((r) => !r.ok));
  assert.equal(out.find((r) => r.item === "boom").error.message, "boom");
});

test("boot applies the cached server list without waiting on the network", async () => {
  const { loadServers } = await import("../src/platform/ios/servers.js");
  let release;
  globalThis.fetch = () => new Promise((r) => (release = r));
  localStorage.setItem("streambert_serversCache", JSON.stringify({ ...bundled, servers: [] }));
  const refresh = loadServers();
  assert.ok(!sourcesForContent(false).some((s) => s.id === "hexa"), "cached copy applied synchronously");
  release({ ok: true, json: async () => bundled });
  await refresh;
  assert.ok(sourcesForContent(false).some((s) => s.id === "hexa"), "fresh copy applied after the refresh");
  localStorage.removeItem("streambert_serversCache");
});
