// In-app back stack (page + selected item per entry) and its persistence.
// Pure helpers so the rules are testable outside React (scripts/test-nav.mjs).
//
// The stack is saved on every navigation. It is only read back when the iOS
// web content process was killed and the page reloaded (window.__sbRecovered,
// set by the native side), so a normal cold launch still opens the start page.

/** Deepest back stack kept; older entries are dropped first. */
export const MAX_NAV_STACK = 40;
/** A saved state older than this is not restored. */
export const NAV_STATE_MAX_AGE_MS = 30 * 60 * 1000;
const NAV_STATE_KEY = "sb_nav_state_v1";

const selectionId = (sel) => {
  if (!sel || typeof sel !== "object") return sel ?? null;
  if (sel.id != null) return `${sel.media_type || ""}:${sel.id}`;
  try {
    return JSON.stringify(sel);
  } catch {
    return null;
  }
};

/** True when two entries show the same screen. */
export const sameScreen = (a, b) =>
  !!a && !!b && a.page === b.page && selectionId(a.selected) === selectionId(b.selected);

/**
 * Stack after leaving `from` for `to`. Navigating to the screen already shown
 * adds nothing, so Back never "does nothing" on a duplicate entry.
 */
export function pushNav(stack, from, to) {
  if (!from || sameScreen(from, to)) return stack;
  const next = [...stack, { page: from.page, selected: from.selected ?? null }];
  return next.length > MAX_NAV_STACK ? next.slice(next.length - MAX_NAV_STACK) : next;
}

/** `{ stack, entry }` after one Back step; entry is null when there is none. */
export function popNav(stack) {
  if (!stack?.length) return { stack: stack || [], entry: null };
  return { stack: stack.slice(0, -1), entry: stack[stack.length - 1] };
}

// Selected items are TMDB objects; keep the save small and JSON-safe.
function slim(sel) {
  if (!sel || typeof sel !== "object") return sel ?? null;
  try {
    const json = JSON.stringify(sel);
    return json.length > 20000 ? null : JSON.parse(json);
  } catch {
    return null;
  }
}

/** Save the current screen and back stack (best effort). */
export function saveNavState({ profileId, page, selected, stack }, store = globalThis.localStorage) {
  try {
    store.setItem(
      NAV_STATE_KEY,
      JSON.stringify({
        v: 1,
        at: Date.now(),
        profileId: profileId ?? null,
        page,
        selected: slim(selected),
        stack: (stack || []).slice(-MAX_NAV_STACK).map((e) => ({ page: e.page, selected: slim(e.selected) })),
      }),
    );
  } catch {}
}

/** The saved state for this profile if it is recent enough, else null. */
export function loadNavState(profileId, { now = Date.now(), store = globalThis.localStorage } = {}) {
  try {
    const s = JSON.parse(store.getItem(NAV_STATE_KEY) || "null");
    if (!s || s.v !== 1 || typeof s.page !== "string") return null;
    if ((s.profileId ?? null) !== (profileId ?? null)) return null;
    if (!(now - s.at < NAV_STATE_MAX_AGE_MS)) return null;
    return { page: s.page, selected: s.selected ?? null, stack: Array.isArray(s.stack) ? s.stack : [] };
  } catch {
    return null;
  }
}

/** True when this page load is the native side's reload after a WebContent crash. */
export const isRecoveryBoot = () => typeof window !== "undefined" && !!window.__sbRecovered;
