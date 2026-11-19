// Dev-only: Cinejoy direct-stream resolver against a fake sealing module and
// API (real AES-GCM), and its place in the iOS candidates. Not bundled.
import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.window = globalThis;
window.addEventListener = () => {};
globalThis.document = { addEventListener: () => {}, visibilityState: "visible" };

const C = await import("../src/utils/servers/cinejoy.js");
const ios = await import("../src/platform/ios/cinejoy.js");

// Fake crush.wasm: "seals" by writing a fixed key, key id, pub key, then the plain request.
const KEY = new Uint8Array(32).fill(7), PUB = new Uint8Array(65).fill(9);
const memory = new WebAssembly.Memory({ initial: 2 });
let top = 8;
const fakeWasm = {
  memory,
  alloc: (n) => ((top += n), top - n),
  dealloc: () => {},
  seal_request: (a, n, f, fn, b, cap) => {
    const m = new Uint8Array(memory.buffer);
    m.set(KEY, b); m[b + 32] = 3; m.set(PUB, b + 33); m.copyWithin(b + 98, a, a + n);
    return 98 + n;
  },
};
const aad = () => { const l = new TextEncoder().encode("lumen-gate-v2"); const x = new Uint8Array(l.length + 68); x.set(l); x.set([0, 2, 3], l.length); x.set(PUB, l.length + 3); return x; };
async function answer(env) {
  const key = await webcrypto.subtle.importKey("raw", KEY, "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12).fill(1);
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad() }, key, new TextEncoder().encode(JSON.stringify(env))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
}
const fakeFetch = (streams, seen = []) => async (url, opts = {}) => {
  if (url.endsWith("/crush.wasm")) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  const req = JSON.parse(new TextDecoder().decode(new Uint8Array(opts.body)));
  seen.push(req);
  const server = req.path.split("/")[1];
  const env = streams[server] ? { status: 200, data: { stream: [{ type: "hls", playlist: streams[server], captions: [{ url: "https://s/en.vtt", language: "en" }] }] } } : { status: 404, data: { error: "Not Found" } };
  const bytes = await answer(env);
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
};
const realInst = WebAssembly.instantiate;
WebAssembly.instantiate = async () => ({ instance: { exports: fakeWasm } });

test("request shape: movie vs series, English upstreams only", () => {
  assert.deepEqual(C.cinejoyRequest("Light", { type: "movie", tmdbId: 550, year: 1999 }), { path: "/Light/movie", payload: { tmdb: "550", year: "1999" } });
  assert.deepEqual(C.cinejoyRequest("Nebula", { type: "tv", tmdbId: 1396, season: 2, episode: 4 }).payload, { tmdb: "1396", season: "2", episode: "4" });
  assert.ok(!C.CINEJOY_SERVERS.some((s) => /Warsaw|Munich|Paris/.test(s)));
});

test("resolver: first upstream with a stream wins, answers decrypted", async () => {
  const seen = [];
  const r = await C.resolveCinejoy(fakeFetch({ Sirius: "https://cdn/s.m3u8" }, seen), { type: "tv", tmdbId: 1396, season: 1, episode: 1 });
  assert.equal(r.server, "Sirius");
  assert.equal(r.source, "https://cdn/s.m3u8");
  assert.equal(r.subtitles[0].lang, "en");
  assert.equal(seen.length, C.CINEJOY_SERVERS.length);
  await assert.rejects(C.resolveCinejoy(fakeFetch({}), { type: "movie", tmdbId: 1 }), /no server/);
});

test("iOS: candidate is the direct stream; anime skipped", async () => {
  ios.setCinejoyHttp(fakeFetch({ Light: "https://cdn/l.m3u8" }), async () => null);
  ios.clearCinejoyCache();
  assert.deepEqual(await ios.cinejoyCandidates({ type: "movie", tmdbId: 550 }), [{ id: "cinejoy-direct", label: "Cinejoy", url: "https://cdn/l.m3u8#sb-direct" }]);
  assert.deepEqual(await ios.cinejoyCandidates({ type: "movie", tmdbId: 550, isAnime: true }), []);
  WebAssembly.instantiate = realInst;
});
