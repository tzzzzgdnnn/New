// Dev-only checks of the back-stack and nav-state rules (not bundled).
// Run: node scripts/test-nav.mjs
import assert from "node:assert/strict";
import {
  pushNav, popNav, saveNavState, loadNavState, MAX_NAV_STACK, NAV_STATE_MAX_AGE_MS,
  registerBackHandler, runBackHandlers,
} from "../src/utils/navHistory.js";

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log("ok -", name); };

// Simulates App.jsx navigate / navigateBack on top of the helpers.
function nav(start = "home") {
  let cur = { page: start, selected: null }, stack = [];
  return {
    go(page, selected = null) { stack = pushNav(stack, cur, { page, selected }); cur = { page, selected }; },
    back() { const r = popNav(stack); if (!r.entry) return false; stack = r.stack; cur = r.entry; return true; },
    get cur() { return cur; }, get stack() { return stack; },
  };
}

t("Back repeatedly returns one screen at a time", () => {
  const n = nav();
  n.go("settings"); n.go("movie", { id: 1, media_type: "movie" }); n.go("tv", { id: 2, media_type: "tv" });
  n.back(); assert.equal(n.cur.page, "movie");
  n.back(); assert.equal(n.cur.page, "settings");
  n.back(); assert.equal(n.cur.page, "home");
  assert.equal(n.back(), false); assert.equal(n.cur.page, "home");
});

t("several screens deep, Back never jumps home", () => {
  const n = nav();
  const path = ["history", "movie", "tv", "settings", "library", "movie"];
  path.forEach((p, i) => n.go(p, p === "movie" || p === "tv" ? { id: i, media_type: p } : null));
  for (let i = path.length - 2; i >= 0; i--) { n.back(); assert.equal(n.cur.page, path[i]); }
  n.back(); assert.equal(n.cur.page, "home");
});

t("tapping the screen already shown adds no dead Back step", () => {
  const n = nav();
  n.go("settings"); n.go("settings"); n.go("settings");
  assert.equal(n.stack.length, 1);
  n.back(); assert.equal(n.cur.page, "home");
});

t("same page with a different title is a real step", () => {
  const n = nav();
  n.go("movie", { id: 1, media_type: "movie" }); n.go("movie", { id: 2, media_type: "movie" });
  n.back(); assert.equal(n.cur.selected.id, 1);
});

t("stack is capped", () => {
  const n = nav();
  for (let i = 0; i < MAX_NAV_STACK + 25; i++) n.go("movie", { id: i, media_type: "movie" });
  assert.equal(n.stack.length, MAX_NAV_STACK);
});

t("nav state round-trips for the same profile only", () => {
  const store = mem();
  saveNavState({ profileId: "a", page: "tv", selected: { id: 9, media_type: "tv" }, stack: [{ page: "home", selected: null }] }, store);
  const s = loadNavState("a", { store });
  assert.equal(s.page, "tv"); assert.equal(s.selected.id, 9); assert.equal(s.stack[0].page, "home");
  assert.equal(loadNavState("b", { store }), null);
});

t("stale nav state is not restored", () => {
  const store = mem();
  saveNavState({ profileId: "a", page: "tv", selected: null, stack: [] }, store);
  assert.equal(loadNavState("a", { store, now: Date.now() + NAV_STATE_MAX_AGE_MS + 1 }), null);
});

t("corrupt nav state is ignored", () => {
  const store = mem(); store.setItem("sb_nav_state_v1", "{nope");
  assert.equal(loadNavState("a", { store }), null);
});

t("inner page (Settings sub-page) is left before the screen", () => {
  const n = nav();
  n.go("settings");
  let sub = "playback";
  const off = registerBackHandler(() => { sub = null; return true; });
  // App-level Back: inner handler first, screen unchanged
  const back = () => (runBackHandlers() ? true : n.back());
  back(); assert.equal(sub, null); assert.equal(n.cur.page, "settings");
  off(); // sub-page closed -> handler unregistered
  back(); assert.equal(n.cur.page, "home");
});

console.log(`\n${pass} nav tests passed`);
