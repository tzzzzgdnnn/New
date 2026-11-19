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
// Reachability probes answer at once (opaque, as no-cors fetches do).
const answer = async () => ({ type: "opaque", status: 0 });
globalThis.fetch = answer;

const { serverCatalog, groupServers, parseServerKey, serverKey } = await import("../src/utils/servers/catalog.js");
const { nativeServerList, sourcesForContent } = await import("../src/utils/api.js");
const { applyServers } = await import("../src/platform/ios/servers.js");
const { downloadCandidates, downloadContext } = await import("../src/platform/ios/webview.js");
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

test("Dub playback tries every dub route, never a TMDB (sub) route", async () => {
  applyServers(bundled);
  window.__sbCtx = { isAnime: true, dubMode: "dub", type: "tv", tmdbId: 1429, anilistId: 16498, episode: 3 };
  const list = await downloadCandidates(downloadContext());
  assert.ok(list.length >= 2);
  assert.ok(list.every((c) => c.id.endsWith(":dub")));
  assert.ok(list.some((c) => c.url === "https://embed.vidrift.net/embed/anilist/16498/3?dub=1"));
  assert.ok(list.some((c) => c.url === "https://vidnest.fun/anime/16498/3/dub"));
});

test("Sub candidates: TMDB-route servers keep plain ids matching the menu", async () => {
  applyServers(bundled);
  window.__sbCtx = { isAnime: true, dubMode: "sub", type: "tv", tmdbId: 1429, anilistId: 16498, episode: 3 };
  const menu = new Set(nativeServerList(true).map((s) => s.id));
  for (const c of await downloadCandidates(downloadContext())) assert.ok(menu.has(c.id), `${c.id} not in the menu`);
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
  globalThis.fetch = answer;
});

const { createServerStats, rankCandidates, probeAndRank } = await import("../src/utils/servers/ranking.js");
const { createFallback } = await import("../src/utils/servers/fallback.js");
const memStore = (init = null) => {
  let v = init;
  return { get: () => v, set: (m) => (v = JSON.parse(JSON.stringify(m))) };
};
const cand = (id) => ({ id, label: id, url: `https://${id}.test/` });

test("ranking: fastest first, failures sink, untested sit in between", () => {
  const stats = createServerStats(memStore());
  stats.record("fast", { ok: true, ms: 200 });
  stats.record("slow", { ok: true, ms: 6000 });
  stats.record("dead", { ok: false });
  const order = rankCandidates(["dead", "new", "slow", "fast"].map(cand), stats).map((c) => c.id);
  assert.deepEqual(order, ["fast", "new", "slow", "dead"]);
});

test("ranking: a pinned server leads; modes share their provider's stats", () => {
  const stats = createServerStats(memStore());
  stats.record("vidnest", { ok: true, ms: 100 });
  const order = rankCandidates([cand("vidrift:dub"), cand("vidnest:dub"), cand("x")], stats, { pinned: "x" });
  assert.deepEqual(order.map((c) => c.id), ["x", "vidnest:dub", "vidrift:dub"]);
});

test("ranking: a success clears failures; stats persist and expire", () => {
  let t = 0;
  const store = memStore();
  const stats = createServerStats(store, { ttlMs: 1000, now: () => t });
  stats.record("a", { ok: false });
  stats.record("a", { ok: true, ms: 300 });
  assert.equal(stats.get("a").fails, 0);
  assert.equal(createServerStats(store, { ttlMs: 1000, now: () => t }).get("a").ms, 300);
  t = 5000;
  assert.equal(createServerStats(store, { ttlMs: 1000, now: () => t }).get("a"), undefined);
});

test("probeAndRank: probes untested providers once each, in parallel", async () => {
  const stats = createServerStats(memStore());
  stats.record("known", { ok: true, ms: 50 });
  const probed = [];
  const probe = (url, signal) => {
    probed.push(url);
    return delay(url.startsWith("https://quick") ? 5 : 60, null, signal);
  };
  const list = [cand("slowish:sub"), cand("slowish:dub"), cand("quick"), cand("known")];
  const order = await probeAndRank(list, { stats, probe, graceMs: 500 });
  assert.equal(probed.length, 2, "one probe per untested provider");
  assert.deepEqual(order.map((c) => c.id), ["quick", "known", "slowish:sub", "slowish:dub"]);
});

test("probeAndRank: losing probes are cancelled after the grace and not marked failed", async () => {
  const stats = createServerStats(memStore());
  let cancelled = 0;
  const probe = (url, signal) => {
    signal.addEventListener("abort", () => cancelled++);
    return delay(url.startsWith("https://win") ? 5 : 5000, null, signal);
  };
  const started = Date.now();
  const order = await probeAndRank([cand("lose"), cand("win")], { stats, probe, budgetMs: 3000, graceMs: 20 });
  assert.ok(Date.now() - started < 1000, "did not wait for the slow probe");
  assert.equal(order[0].id, "win");
  assert.ok(cancelled >= 1);
  assert.equal(stats.get("lose"), undefined);
});

test("probeAndRank: a dead server is recorded as failed and ranks last", async () => {
  const stats = createServerStats(memStore());
  const probe = (url) => (url.startsWith("https://dead") ? Promise.reject(new Error("dns")) : delay(5));
  const order = await probeAndRank([cand("dead"), cand("ok")], { stats, probe, graceMs: 50 });
  assert.deepEqual(order.map((c) => c.id), ["ok", "dead"]);
  assert.equal(stats.get("dead").fails, 1);
});

test("fallback: failure moves to the next server; exhaustion reported once", () => {
  const played = [];
  let exhausted = 0;
  const fb = createFallback(["a", "b"], { play: (x) => played.push(x), onExhausted: () => exhausted++, stallMs: 10_000 });
  fb.start();
  fb.fail();
  assert.equal(fb.current, "b");
  fb.fail();
  fb.fail();
  assert.deepEqual(played, ["a", "b"]);
  assert.equal(exhausted, 1);
});

test("fallback: a stall moves on; progress keeps the current server", async () => {
  const played = [];
  const fb = createFallback(["a", "b", "c"], { play: (x) => played.push(x), stallMs: 30 });
  fb.start();
  const keepAlive = setInterval(() => fb.progress(), 10);
  await delay(80);
  clearInterval(keepAlive);
  assert.deepEqual(played, ["a"]);
  await delay(45);
  assert.deepEqual(played, ["a", "b"]);
  fb.stop();
  await delay(45);
  assert.deepEqual(played, ["a", "b"], "stopped: no more switches");
});

// ── Downloader: auto-pick and fallback through the native lookup ─────────
const { serverStats } = await import("../src/platform/ios/autoServer.js");
const dl = await import("../src/platform/ios/downloads.js");
const native = { sent: [], badStreams: new Set(), jobs: [] };
window.webkit = {
  messageHandlers: {
    sbDownload: {
      postMessage: async (m) => {
        native.sent.push(m);
        if (m.op === "probe") {
          const c = m.candidates.find((x) => !native.badStreams.has(x.id)) || null;
          if (!c) return { ok: false, error: "No server returned a downloadable stream" };
          return {
            ok: true, kind: "hls", server: c.id, streamUrl: `https://${c.id}/master.m3u8`, headers: {}, subtitles: [{ url: `https://${c.id}/en.vtt`, lang: "en" }],
            variants: [{ url: `https://${c.id}/1080`, height: 1080, width: 1920, bandwidth: 5e6 }, { url: `https://${c.id}/720`, height: 720, width: 1280, bandwidth: 3e6 }],
          };
        }
        if (m.op === "start") {
          if ([...native.badStreams].some((id) => m.streamUrl.includes(id))) return { ok: false, error: "403" };
          native.jobs.push({ id: m.id, name: m.name, status: "downloading", streamUrl: m.streamUrl, meta: m.meta });
          return { ok: true, id: m.id };
        }
        if (m.op === "list") return native.jobs;
        if (m.op === "remove") native.jobs = native.jobs.filter((j) => j.id !== m.id);
        return true;
      },
    },
  },
};
const dubCtx = { isAnime: true, dubMode: "dub", type: "tv", tmdbId: 1429, anilistId: 16498, episode: 3 };
const starts = () => native.sent.filter((m) => m.op === "start");

test("downloads: the lookup gets the ranked servers and feeds speed + quality back", async () => {
  applyServers(bundled);
  window.__sbCtx = dubCtx;
  const probe = await dl.probeDownload();
  assert.ok(probe.ok);
  const lookup = native.sent.findLast((m) => m.op === "probe");
  assert.ok(lookup.candidates.length >= 2 && lookup.candidates.every((c) => c.id.endsWith(":dub")));
  assert.equal(serverStats.get(probe.server.split(":")[0]).height, 1080);
  assert.deepEqual(probe.tried, [probe.server]);
  assert.equal(probe.options[0].name, "1080p");
});

test("downloads: a job that cannot start moves to the next server, same quality and subtitles", async () => {
  window.__sbCtx = dubCtx;
  const probe = await dl.probeDownload();
  native.badStreams.add(probe.server);
  const option = probe.options.find((o) => o.name === "720p");
  const before = starts().length;
  const res = await dl.iosDownloadApi.runDownload({ name: "AoT 3", mediaId: 1429, mediaType: "tv", probe, option, subtitles: probe.subtitles });
  assert.ok(res.ok);
  const [failed, moved] = starts().slice(before);
  assert.ok(failed.streamUrl.includes(probe.server));
  assert.ok(!moved.streamUrl.includes(probe.server));
  assert.ok(moved.variantUrl.endsWith("/720"));
  assert.deepEqual(moved.subtitles.map((t) => t.lang), ["en"]);
  native.badStreams.clear();
});

test("downloads: a job that fails mid-way restarts on the next server; the failed one goes", async () => {
  window.__sbCtx = dubCtx;
  const probe = await dl.probeDownload();
  const first = await dl.iosDownloadApi.runDownload({ name: "AoT 3 mid-way", mediaId: 1429, mediaType: "tv", probe, option: probe.options[0] });
  window.__sbCtx = { type: "movie", tmdbId: 999 }; // viewer moved on to another title
  native.badStreams.add(probe.server);
  dl.recordFromEvent({ id: first.id, status: "error", name: "AoT 3 mid-way" });
  dl.recordFromEvent({ id: first.id, status: "error", name: "AoT 3 mid-way" }); // repeated events restart once
  await delay(50);
  const jobs = native.jobs;
  assert.ok(!jobs.some((j) => j.id === first.id), "failed job removed");
  const replacement = jobs.at(-1);
  assert.ok(!replacement.streamUrl.includes(probe.server));
  assert.ok(replacement.streamUrl.includes(":dub"), "same title and audio, not the page now open");
  assert.equal(starts().filter((m) => m.name === "AoT 3 mid-way").length, 2);
  native.badStreams.clear();
});

test("downloads: with no server left the failed job stays", async () => {
  window.__sbCtx = dubCtx;
  const probe = await dl.probeDownload();
  const first = await dl.iosDownloadApi.runDownload({ name: "Solo", mediaId: 1, mediaType: "tv", probe, option: probe.options[0] });
  for (const c of await downloadCandidates(downloadContext())) native.badStreams.add(c.id);
  dl.recordFromEvent({ id: first.id, status: "error", name: "Solo" });
  await delay(50);
  assert.ok(native.jobs.some((j) => j.id === first.id));
  native.badStreams.clear();
});
