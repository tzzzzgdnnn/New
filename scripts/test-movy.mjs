// Dev-only: Movy direct-stream resolver (cipher, provider race, source pick)
// and its place in the native player / downloader candidates. Not bundled.
import assert from "node:assert/strict";
import { test } from "node:test";

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.window = globalThis;
window.addEventListener = () => {};
globalThis.document = { addEventListener: () => {}, visibilityState: "visible" };
globalThis.fetch = async () => ({ type: "opaque", status: 0 });

const M = await import("../src/utils/servers/movy.js");
const ios = await import("../src/platform/ios/movy.js");
const { withMovy } = await import("../src/platform/ios/webview.js");

const SEED = "kQ2-x_9";
const fakeApi = ({ answer = {}, failing = [], calls = [] } = {}) => async (url, headers) => {
  calls.push(url);
  assert.equal(headers.Origin, "https://www.movy.sx");
  const u = new URL(url);
  if (u.pathname === "/seed") return JSON.stringify({ seed: SEED, ttlMs: 30000 });
  const p = u.pathname.split("/")[1];
  if (failing.includes(p)) throw new Error("HTTP 404");
  const id = u.searchParams.get("tmdbId");
  assert.equal(u.searchParams.get("enc"), "2");
  assert.equal(u.searchParams.get("seed"), SEED);
  return M.encodeMovy(JSON.stringify(answer[p] || { sources: [] }), SEED, id);
};

test("cipher: round trip, wrong seed refused", () => {
  const enc = M.encodeMovy('{"a":"é"}', SEED, 550);
  assert.equal(M.decodeMovy(enc, SEED, 550), '{"a":"é"}');
  assert.throws(() => M.decodeMovy(enc, "nope", 550), /decrypt failed/);
  assert.throws(() => M.decodeMovy(enc, SEED, 551), /decrypt failed/);
});

test("source pick: HLS master first, then highest quality", () => {
  assert.equal(M.pickMovySource([{ url: "https://a/1080.mp4", quality: "1080" }, { url: "https://a/m.m3u8", quality: "auto" }]).url, "https://a/m.m3u8");
  assert.equal(M.pickMovySource([{ file: "https://a/360.m3u8", quality: "360" }, { file: "https://a/720.m3u8", quality: "720p" }]).url, "https://a/720.m3u8");
  assert.equal(M.pickMovySource([{ url: "http://insecure" }, null]), null);
});

test("resolver: first provider with a stream wins; empty and failing ones are skipped", async () => {
  const calls = [];
  const http = fakeApi({ calls, failing: ["miami"], answer: { atlanta: { sources: [] }, berlin: { sources: [{ url: "https://cdn/berlin/master.m3u8", quality: "auto" }], subtitles: [{ url: "https://s/en.vtt", lang: "en" }] } } });
  const r = await M.resolveMovy(http, { type: "tv", tmdbId: 74204, title: "Big Mouth", year: 2017, season: 2, episode: 3 });
  assert.equal(r.source, "https://cdn/berlin/master.m3u8");
  assert.equal(r.provider, "berlin");
  assert.equal(r.subtitles.length, 1);
  const q = new URL(calls.find((c) => c.includes("/berlin/")));
  assert.equal(q.searchParams.get("mediaType"), "tv");
  assert.equal(q.searchParams.get("seasonId"), "2");
  assert.equal(q.searchParams.get("episodeId"), "3");
  assert.equal(q.searchParams.get("tmdbId"), "74204");
  assert.equal(q.searchParams.get("year"), "2017");
  assert.equal(calls.filter((c) => c.includes("/seed")).length, 1, "one seed per lookup");
  assert.ok(calls.filter((c) => c.includes("/sources")).length === M.MOVY_PROVIDERS.length, "all providers asked at once");
});

test("resolver: nothing anywhere -> error", async () => {
  await assert.rejects(M.resolveMovy(fakeApi(), { type: "movie", tmdbId: 1 }), /no provider/);
});

test("iOS: candidate is the direct stream; anime never uses Movy; lookups are cached", async () => {
  let seeds = 0;
  const base = fakeApi({ answer: { miami: { sources: [{ url: "https://cdn/m.m3u8", quality: "auto" }] } } });
  ios.setMovyHttp(async (u, h) => (u.includes("/seed") && seeds++, base(u, h)), async () => "tt0137523");
  ios.clearMovyCache();
  const ctx = { type: "movie", tmdbId: 550, title: "Fight Club", year: 1999 };
  const c = await ios.movyCandidates(ctx);
  assert.deepEqual(c, [{ id: "movy-direct", label: "Movy", url: "https://cdn/m.m3u8#sb-direct" }]);
  await ios.movyCandidates(ctx);
  assert.equal(seeds, 1, "second Play reuses the prefetch");
  assert.deepEqual(await ios.movyCandidates({ ...ctx, isAnime: true }), []);
});

test("player order: Movy leads on Auto", () => {
  const ranked = [{ id: "hexa", url: "h" }, { id: "flixer", url: "f" }];
  const movy = [{ id: "movy-direct", url: "m#sb-direct" }];
  assert.deepEqual(withMovy(ranked, movy).map((c) => c.id), ["movy-direct", "hexa", "flixer"]);
  assert.deepEqual(withMovy(ranked, []).map((c) => c.id), ["hexa", "flixer"]);
});
