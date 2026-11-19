// Dev-only: iOS server sheet (rows, Sub/Dub control), the player's measured
// Auto ranking, ani.pm leading for anime, and the Auto/manual choice. Not bundled.
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
globalThis.fetch = async () => ({ type: "opaque", status: 0 });

const sheet = await import("../src/platform/ios/serverSheetLogic.js");
const measure = await import("../src/utils/servers/measure.js");
const auto = await import("../src/platform/ios/autoServer.js");
const { withAnipm, playerOrder } = await import("../src/platform/ios/webview.js");
const { measureCache } = await import("../src/platform/ios/autoRank.js");

const SOURCES = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta", movieOnly: true },
  { id: "c", label: "Gamma", tag: "anime" },
];

test("sheet: Auto first and selected by default; TV hides movie-only", () => {
  const rows = sheet.serverSheetRows({ sources: SOURCES, type: "tv" });
  assert.deepEqual(rows.map((r) => r.id), ["auto", "a", "c"]);
  assert.equal(rows.filter((r) => r.selected).map((r) => r.id)[0], "auto");
});

test("sheet: anime lists ani.pm right after Auto; picked row is checked", () => {
  const rows = sheet.serverSheetRows({ sources: SOURCES, anime: true, choice: "anipm" });
  assert.deepEqual(rows.slice(0, 2).map((r) => r.id), ["auto", "anipm"]);
  assert.deepEqual(rows.filter((r) => r.selected).map((r) => r.id), ["anipm"]);
  assert.equal(sheet.serverChoiceLabel("anipm", SOURCES), "ani.pm");
  assert.equal(sheet.serverChoiceLabel("c", SOURCES), "Gamma");
  assert.equal(sheet.serverChoiceLabel("gone", SOURCES), "Auto");
  // A server no longer listed falls back to Auto.
  assert.equal(sheet.serverSheetRows({ sources: SOURCES, choice: "gone" })[0].selected, true);
});

test("sheet: Dub disabled only when ani.pm reports no dub", () => {
  assert.deepEqual(sheet.dubControl("dub", { sub: true, dub: false }), { mode: "sub", dubDisabled: true, wanted: "dub" });
  assert.equal(sheet.dubControl("dub", { sub: true, dub: true }).dubDisabled, false);
  assert.equal(sheet.dubControl("dub", null).mode, "dub");
});

test("sheet: drag dismiss thresholds", () => {
  assert.equal(sheet.shouldDismissDrag(-50, 100), false);
  assert.equal(sheet.shouldDismissDrag(120, 1000), true);
  assert.equal(sheet.shouldDismissDrag(40, 30), true);
  assert.equal(sheet.shouldDismissDrag(40, 1000), false);
});

test("choice: Auto by default; manual pick, ani.pm pin, back to Auto", () => {
  assert.equal(auto.getServerChoice(), "auto");
  assert.equal(auto.setServerChoice("a"), "a");
  assert.equal(auto.getServerChoice(), "a");
  assert.equal(auto.isAutoPick(), false);
  auto.setServerChoice("anipm");
  assert.equal(auto.getServerChoice(), "anipm");
  assert.equal(auto.isAnipmPinned(), true);
  auto.setServerChoice("auto");
  assert.equal(auto.getServerChoice(), "auto");
  assert.equal(auto.isAnipmPinned(), false);
});

test("measure: ranks by bandwidth, then ping; failed servers skipped", () => {
  const S = {
    a: { ok: true, bps: 1e6, latencyMs: 100 },
    b: { ok: true, bps: 5e6, latencyMs: 300 },
    c: { ok: false },
    d: { ok: true, bps: null, latencyMs: 50 },
  };
  const cands = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const out = measure.rankMeasured(cands, (p) => S[p]).map((c) => c.id);
  assert.deepEqual(out, ["b", "a", "d", "e"]);
  // Close bandwidths: lower ping wins.
  const T = { x: { ok: true, bps: 1e6, latencyMs: 200 }, y: { ok: true, bps: 1.05e6, latencyMs: 20 } };
  assert.deepEqual(measure.rankMeasured([{ id: "x" }, { id: "y" }], (p) => T[p]).map((c) => c.id), ["y", "x"]);
  assert.deepEqual(measure.rankMeasured(cands, (p) => S[p], { pinned: "e" })[0].id, "e");
});

test("measure: parallel within budget, cached, slow server times out", async () => {
  let clock = 0;
  const store = { v: {}, get() { return this.v; }, set(x) { this.v = x; } };
  const cache = measure.createMeasureCache(store, { now: () => clock });
  const calls = [];
  const sample = (c) => {
    calls.push(c.id);
    if (c.id === "slow") return new Promise(() => {});
    return Promise.resolve({ bps: c.id === "fast" ? 9e6 : 1e6, latencyMs: 40 });
  };
  const t0 = Date.now();
  await measure.measureCandidates([{ id: "fast" }, { id: "ok" }, { id: "slow" }], { sample, cache, budgetMs: 150 });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(cache.get("fast").ok, true);
  assert.equal(cache.get("slow").ok, false);
  await measure.measureCandidates([{ id: "fast" }], { sample, cache });
  assert.equal(calls.filter((c) => c === "fast").length, 1, "fresh sample reused");
  clock += measure.MEASURE_TTL_MS + 1;
  assert.equal(cache.get("fast"), undefined, "expires");
});

test("player Auto: measured order; ani.pm stays first for anime; manual pick leads", () => {
  measureCache.clear();
  measureCache.record("slowsrv", { ok: true, bps: 2e5, latencyMs: 500 });
  measureCache.record("fastsrv", { ok: true, bps: 8e6, latencyMs: 30 });
  const ranked = [{ id: "slowsrv" }, { id: "fastsrv" }];
  auto.setServerChoice("auto");
  const ordered = playerOrder(ranked, { type: "movie", tmdbId: 1 });
  assert.deepEqual(ordered.map((c) => c.id), ["fastsrv", "slowsrv"]);
  const anipm = [{ id: "anipm:sub", url: "x#sb-direct" }, { id: "anipm:sub", url: "y" }];
  assert.equal(withAnipm(ordered, anipm)[0].id, "anipm:sub");
  // Manual pick: playerOrder keeps the given order.
  auto.setServerChoice("slowsrv");
  assert.deepEqual(playerOrder(ranked, { tmdbId: 1 }).map((c) => c.id), ["slowsrv", "fastsrv"]);
  // ani.pm pinned by hand still leads.
  auto.setServerChoice("anipm");
  assert.equal(withAnipm(ranked, anipm)[0].id, "anipm:sub");
  auto.setServerChoice("auto");
});
