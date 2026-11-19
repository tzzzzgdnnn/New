// Dev-only checks of the iOS profile store (not bundled into the app).
// Run: npm run test:ios   (bundles this file with esbuild, then runs it)
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
// Object.keys(localStorage) must list stored keys, like a real Storage.
globalThis.localStorage = new Proxy(globalThis.localStorage, {
  ownKeys: () => [...mem.keys()],
  getOwnPropertyDescriptor: (t, k) => (mem.has(k) ? { enumerable: true, configurable: true, value: mem.get(k) } : Reflect.getOwnPropertyDescriptor(t, k)),
});

// Keychain stand-in (window.electron.secureGet/secureSet, as shim.js provides).
const keychain = new Map();
globalThis.window = globalThis.window || globalThis;
const events = [];
window.dispatchEvent = (e) => { events.push(e); return true; };
globalThis.CustomEvent = globalThis.CustomEvent || class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };
window.electron = {
  isIOS: true,
  secureGet: async (k) => keychain.get(k) ?? null,
  secureSet: async (k, v) => { if (v) keychain.set(k, v); else keychain.delete(k); return { ok: true }; },
};

const { storage } = await import("../src/utils/storage.js");
const store = await import("../src/platform/ios/profiles/profileStore.js");
const { getActiveProfileId } = await import("../src/utils/profileScope.js");
const nav = await import("../src/utils/navHistory.js");

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log("ok -", name); };

// Legacy single-user data, as written before profiles existed.
storage.set("history", [{ id: 1, title: "Legacy" }]);

let main, second;
await t("first run creates Main and adopts legacy data", async () => {
  const list = await store.loadProfiles();
  assert.equal(list.length, 1);
  main = list[0];
  store.activateProfile(main);
  assert.deepEqual(storage.get("history"), [{ id: 1, title: "Legacy" }]);
});

await t("create 2 profiles; data is per profile", async () => {
  second = await store.createProfile({ name: "Kid", kids: true });
  await store.createProfile({ name: "Third" });
  assert.equal(store.listProfiles().length, 3);
  store.activateProfile(second);
  assert.equal(storage.get("history"), null, "new profile starts empty");
  storage.set("history", [{ id: 2, title: "Kid show" }]);
  storage.set("progress", { tv_2_s1e1: 40 });
});

await t("switch repeatedly keeps each profile's own data", () => {
  for (let i = 0; i < 20; i++) {
    store.activateProfile(main);
    assert.equal(getActiveProfileId(), main.id);
    assert.deepEqual(storage.get("history"), [{ id: 1, title: "Legacy" }]);
    assert.equal(storage.get("progress"), null);
    store.activateProfile(second);
    assert.deepEqual(storage.get("history"), [{ id: 2, title: "Kid show" }]);
    assert.deepEqual(storage.get("progress"), { tv_2_s1e1: 40 });
  }
});

await t("search history is per profile", () => {
  store.activateProfile(main); storage.set("searchHistory", ["naruto"]);
  store.activateProfile(second); assert.equal(storage.get("searchHistory"), null);
  storage.set("searchHistory", ["bluey"]);
  store.activateProfile(main); assert.deepEqual(storage.get("searchHistory"), ["naruto"]);
});

await t("app-wide settings stay shared", () => {
  store.activateProfile(main); storage.set("accentColor", "blue");
  store.activateProfile(second); assert.equal(storage.get("accentColor"), "blue");
});

await t("Back stack saved under one profile is not restored into another", () => {
  store.activateProfile(main);
  nav.saveNavState({ profileId: getActiveProfileId(), page: "settings", selected: null, stack: [{ page: "home", selected: null }] });
  store.activateProfile(second);
  assert.equal(nav.loadNavState(getActiveProfileId()), null);
  store.activateProfile(main);
  assert.equal(nav.loadNavState(getActiveProfileId()).page, "settings");
});

await t("persistence across reload (re-read from storage + Keychain)", async () => {
  const ids = store.listProfiles().map((p) => p.id);
  assert.equal(store.getLastProfileId(), main.id);
  // A reload re-runs loadProfiles: same profiles, no new Main, data intact.
  const again = await store.loadProfiles();
  assert.deepEqual(again.map((p) => p.id), ids);
  store.activateProfile(again.find((p) => p.id === second.id));
  assert.deepEqual(storage.get("history"), [{ id: 2, title: "Kid show" }]);
});

await t("profile list lost from localStorage is restored from the Keychain", async () => {
  const ids = store.listProfiles().map((p) => p.id);
  localStorage.removeItem("streambert_profiles");
  const restored = await store.loadProfiles();
  assert.deepEqual(restored.map((p) => p.id), ids);
});

await t("delete removes only that profile's data; last profile can't go", async () => {
  const third = store.listProfiles().find((p) => p.name === "Third");
  store.activateProfile(third); storage.set("history", [{ id: 3 }]);
  store.activateProfile(main);
  await store.deleteProfile(third.id);
  assert.equal(store.listProfiles().length, 2);
  assert.ok(![...mem.keys()].some((k) => k.includes(`p.${third.id}.`)));
  assert.deepEqual(storage.get("history"), [{ id: 1, title: "Legacy" }]);
  await store.deleteProfile(second.id);
  await assert.rejects(() => store.deleteProfile(main.id));
});

await t("deleting the active profile: a late write can't recreate its data", async () => {
  const doomed = await store.createProfile({ name: "Doomed" });
  store.activateProfile(doomed); storage.set("history", [{ id: 4 }]);
  await store.deleteProfile(doomed.id);
  assert.equal(getActiveProfileId(), null);
  storage.set("progress", { movie_4: 30 }); // e.g. a progress report landing late
  assert.ok(![...mem.keys()].some((k) => k.includes(`p.${doomed.id}.`)), "deleted profile's data came back");
  store.activateProfile(main);
});

await t("profile cap is enforced", async () => {
  while (store.listProfiles().length < store.MAX_PROFILES) await store.createProfile({ name: "x" });
  await assert.rejects(() => store.createProfile({ name: "too many" }));
});

await t("per-profile settings don't leak (subtitles, autoplay, dub mode) and the native mirror follows", async () => {
  const [a, b] = store.listProfiles();
  store.activateProfile(a);
  storage.set("subtitleLang", "de"); storage.set("autoplayNextEnabled", false); storage.set("hianimeDubMode", "dub");
  store.activateProfile(b);
  assert.equal(storage.get("subtitleLang"), null);
  assert.equal(storage.get("autoplayNextEnabled"), null);
  assert.equal(storage.get("hianimeDubMode"), null);
  assert.equal(localStorage.getItem("streambert_subtitleLang"), null, "native mirror kept A's language");
  store.activateProfile(a);
  assert.equal(localStorage.getItem("streambert_subtitleLang"), '"de"');
});

await t("switching mid-watch: progress reported after the switch lands in the new profile only", async () => {
  const [a, b] = store.listProfiles();
  store.activateProfile(a); storage.set("progress", { movie_1: 50 });
  store.activateProfile(b); storage.set("progress", { movie_2: 10 });
  store.activateProfile(a); assert.deepEqual(storage.get("progress"), { movie_1: 50 });
});

await t("a failed save is reported, not silent", async () => {
  const orig = localStorage.setItem;
  localStorage.setItem = () => { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; };
  const ok = storage.set("history", [{ id: 99 }]);
  localStorage.setItem = orig;
  assert.equal(ok, false);
  assert.ok(events.some((e) => e.type === "sb-storage-error" && e.detail.kind === "save failed"));
});

await t("corrupt stored JSON is reported and read as missing", async () => {
  events.length = 0;
  const [a] = store.listProfiles();
  store.activateProfile(a);
  localStorage.setItem(`streambert_p.${a.id}.watched`, "{not json");
  await new Promise((r) => setTimeout(r, 2100)); // event throttle window
  assert.equal(storage.get("watched"), null);
  assert.ok(events.some((e) => e.type === "sb-storage-error" && e.detail.kind === "corrupt"));
});

await t("corrupt profile list is restored from the Keychain, never replaced by a fresh Main", async () => {
  const ids = store.listProfiles().map((p) => p.id);
  localStorage.setItem("streambert_profiles", "[{broken");
  const restored = await store.loadProfiles();
  assert.deepEqual(restored.map((p) => p.id), ids);
  assert.ok([...mem.keys()].some((k) => k.startsWith("streambert_profiles_corrupt_")), "no backup of the damaged list");
});

await t("corrupt profile list with no Keychain copy is rebuilt from stored profile data", async () => {
  const ids = store.listProfiles().map((p) => p.id).filter((id) => [...mem.keys()].some((k) => k.startsWith(`streambert_p.${id}.`)));
  keychain.clear();
  localStorage.setItem("streambert_profiles", "garbage");
  const rebuilt = await store.loadProfiles();
  for (const id of ids) assert.ok(rebuilt.some((p) => p.id === id), `lost profile ${id}`);
  assert.ok(!rebuilt.some((p) => p.name === "Main" && !ids.includes(p.id)), "fresh Main created");
});

console.log(`\n${pass} profile tests passed`);
