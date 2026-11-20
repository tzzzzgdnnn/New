// Dev-only: Safari → Home Screen data carry-over (#sp-import) and the
// ad-block sheet's device detection.
import assert from "node:assert/strict";

function makeStorage() {
  const mem = new Map();
  return {
    mem,
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
}
globalThis.window = globalThis;
globalThis.localStorage = makeStorage();
globalThis.location = { pathname: "/New/", search: "", hash: "" };
globalThis.history = {
  state: null,
  replaceState(_s, _t, url) {
    const u = new URL(url, "https://tzzzzgdnnn.github.io");
    location.pathname = u.pathname;
    location.search = u.search;
    location.hash = u.hash;
  },
};

const tr = await import("../src/platform/ios/web/transfer.js");
const env = await import("../src/platform/ios/web/env.js");
let pass = 0;
const t = async (n, f) => { await f(); pass++; console.log("ok -", n); };
const J = JSON.stringify;
const P = "streambert_p.abc123.";

// A realistic Safari profile's storage.
const safari = {
  streambert_profiles: J([{ id: "abc123", name: "Main", avatar: "a1" }]),
  streambert_lastProfileId: J("abc123"),
  [P + "history"]: J([
    { id: 1399, title: "GoT", media_type: "tv", season: 1, episode: 3, watchedAt: 3000 },
    { id: 603, title: "The Matrix", media_type: "movie", season: null, episode: null, watchedAt: 2000 },
  ]),
  [P + "progress"]: J({ tv_1399_s1e3: 41, movie_603: 88 }),
  [P + "watched"]: J({ tv_1399_s1e1: true }),
  [P + "saved"]: J([{ id: 603, media_type: "movie", title: "The Matrix" }]),
  [P + "dlTime_tv_1399_s1e3"]: J(1312),
  [P + "sbLastEp_1399"]: J({ season: 1, episode: 3, at: 3000 }),
  streambert_customServers: J([{ id: "srv1", name: "My site", template: "https://x/{id}" }]),
  "capacitor-storage_customServersSecure": "not-json-secret",
  streambert_accentColor: J("#e50914"),
  "sb_tmdb:movie/603": J({ big: "cache".repeat(500) }),
  sb_diag_log: "lots of log lines",
  sb_adblockSheet: "step2",
};

await t("snapshot carries user data and leaves caches/logs behind", async () => {
  const ls = makeStorage();
  for (const [k, v] of Object.entries(safari)) ls.setItem(k, v);
  const snap = tr.collectLocalStorage(ls);
  for (const k of Object.keys(safari)) {
    const skip = k.startsWith("sb_tmdb:") || k === "sb_diag_log" || k === "sb_adblockSheet";
    assert.equal(k in snap, !skip, k);
  }
});

let hashData;
await t("Safari side packs storage into #sp-import (gzip + base64url)", async () => {
  localStorage.clear();
  for (const [k, v] of Object.entries(safari)) localStorage.setItem(k, v);
  const len = await tr.writeImportHash();
  assert.ok(location.hash.startsWith("#sp-import=z."), location.hash.slice(0, 20));
  assert.match(location.hash.slice("#sp-import=".length), /^z\.[A-Za-z0-9_-]+$/);
  hashData = tr.readImportHash();
  assert.equal(hashData.length, len);
  console.log(`   payload ${len} chars in the URL`);
});

await t("Home Screen side imports everything into empty storage, sets the flag, strips the hash", async () => {
  localStorage.clear(); // separate Home Screen storage
  const res = await tr.importFromHash();
  assert.equal(res.imported, true);
  assert.equal(res.failed, 0);
  for (const [k, v] of Object.entries(safari)) {
    if (k.startsWith("sb_tmdb:") || k === "sb_diag_log" || k === "sb_adblockSheet") continue;
    assert.equal(localStorage.getItem(k), v, k);
  }
  assert.ok(localStorage.getItem(tr.IMPORT_DONE_KEY));
  assert.equal(location.hash, "");
  assert.equal(location.pathname, "/New/");
});

await t("relaunch from the same start URL does not import again", async () => {
  history.replaceState(null, "", "/New/#sp-import=" + hashData);
  localStorage.setItem(P + "progress", J({ movie_603: 99 })); // watched more in the Home Screen app
  const res = await tr.importFromHash();
  assert.equal(res.imported, false);
  assert.equal(res.already, true);
  assert.equal(localStorage.getItem(P + "progress"), J({ movie_603: 99 }));
  assert.equal(location.hash, "");
});

await t("merge with existing Home Screen data: history and resume newest wins", async () => {
  localStorage.clear();
  localStorage.setItem(P + "history", J([
    { id: 1399, title: "GoT", media_type: "tv", season: 1, episode: 3, watchedAt: 5000 },
    { id: 999, title: "Local only", media_type: "movie", season: null, episode: null, watchedAt: 1000 },
  ]));
  localStorage.setItem(P + "sbLastEp_1399", J({ season: 2, episode: 1, at: 9000 }));
  localStorage.setItem(P + "dlTime_tv_1399_s1e3", J(2000));
  localStorage.setItem(P + "saved", J([{ id: 1, media_type: "tv", title: "Local" }]));
  localStorage.setItem(P + "progress", J({ tv_5_s1e1: 10, movie_603: 5 }));
  history.replaceState(null, "", "/New/#sp-import=" + hashData);
  const res = await tr.importFromHash();
  assert.equal(res.imported, true);
  const h = JSON.parse(localStorage.getItem(P + "history"));
  assert.deepEqual(h.map((x) => [x.id, x.watchedAt]), [[1399, 5000], [603, 2000], [999, 1000]]);
  assert.deepEqual(JSON.parse(localStorage.getItem(P + "sbLastEp_1399")), { season: 2, episode: 1, at: 9000 });
  assert.equal(JSON.parse(localStorage.getItem(P + "dlTime_tv_1399_s1e3")), 2000);
  assert.deepEqual(JSON.parse(localStorage.getItem(P + "saved")).map((x) => x.id).sort(), [1, 603]);
  assert.deepEqual(JSON.parse(localStorage.getItem(P + "progress")), { tv_5_s1e1: 10, movie_603: 88, tv_1399_s1e3: 41 });
});

await t("plain (uncompressed) payloads and garbage are handled", async () => {
  const saved = globalThis.CompressionStream;
  globalThis.CompressionStream = undefined;
  const data = await tr.encodePayload({ v: 1, id: "x", at: 1, ls: { a: "1" } });
  globalThis.CompressionStream = saved;
  assert.ok(data.startsWith("j."));
  assert.deepEqual((await tr.decodePayload(data)).ls, { a: "1" });
  history.replaceState(null, "", "/New/#sp-import=z.%%%");
  const res = await tr.importFromHash();
  assert.equal(res.imported, false);
  assert.ok(res.error);
  assert.equal(location.hash, "");
});

await t("a big library still fits in a URL", async () => {
  const ls = makeStorage();
  const hist = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, title: `Show number ${i}`, poster_path: `/p${i}abcdefghijklmnop.jpg`, media_type: "tv", season: 1, episode: i % 10, watchedAt: 1e12 + i }));
  ls.setItem(P + "history", J(hist));
  ls.setItem(P + "progress", J(Object.fromEntries(hist.map((h) => [`tv_${h.id}_s1e${h.episode}`, 50]))));
  ls.setItem(P + "saved", J(hist.slice(0, 60)));
  const data = await tr.encodePayload(await tr.buildPayload(ls));
  console.log(`   100 history + 100 progress + 60 saved = ${data.length} chars`);
  assert.ok(data.length < 64 * 1024);
});

await t("sheet shows only in iPhone/iPad Safari", async () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
  const ipadDesktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
  const crios = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1";
  const wkNative = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  assert.ok(env.isAppleMobile(iphone, "iPhone", 5) && env.isSafari(iphone));
  assert.ok(env.isAppleMobile(ipadDesktop, "MacIntel", 5) && env.isSafari(ipadDesktop));
  assert.ok(!env.isAppleMobile(ipadDesktop, "MacIntel", 0), "a real Mac is not an iPad");
  assert.ok(!env.isSafari(crios));
  assert.ok(!env.isSafari(wkNative));
});

console.log(`${pass} web-transfer checks passed`);
