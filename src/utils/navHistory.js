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

const RELOAD_FLAG = "sb_reload_restore";
const RELOAD_FLAG_MAX_AGE_MS = 30 * 1000;

/**
 * True when this page load should return to where the viewer was: the native
 * side's reload after a WebContent kill, or an in-app reload (reloadApp).
 */
export function isRecoveryBoot() {
  if (typeof window === "undefined") return false;
  if (window.__sbRecovered) return true;
  try {
    const at = Number(sessionStorage.getItem(RELOAD_FLAG) || localStorage.getItem(RELOAD_FLAG));
    return at > 0 && Date.now() - at < RELOAD_FLAG_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/** Forget the in-app reload flag once the app has restored itself. */
export function clearReloadFlag() {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
    localStorage.removeItem(RELOAD_FLAG);
  } catch {}
}

/**
 * Reload the web app but come back to the same profile and screen (used by
 * Retry/Reload buttons; a bare location.reload() dropped the viewer on the
 * profile picker / start page).
 */
export function reloadApp(reason = "reload") {
  try {
    const now = String(Date.now());
    sessionStorage.setItem(RELOAD_FLAG, now);
    localStorage.setItem(RELOAD_FLAG, now);
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent("sb-native-diag", { detail: { type: "app-reload", reason } }));
  } catch {}
  window.location.reload();
}

// ── Nested back handlers ─────────────────────────────────────────────────
// A screen with its own inner navigation (Settings sub-pages) registers a
// handler; app-level Back (tab bar button, edge swipe, gamepad) asks the
// newest one first, so Back leaves the sub-page before leaving the screen.
const _backHandlers = [];

/** Register `fn` (returns true when it handled Back). Returns an unregister. */
const _announce = () => {
  try {
    window.dispatchEvent(new CustomEvent("sb-nested-back", { detail: _backHandlers.length }));
  } catch {}
};

export function registerBackHandler(fn) {
  _backHandlers.push(fn);
  _announce();
  return () => {
    const i = _backHandlers.lastIndexOf(fn);
    if (i >= 0) _backHandlers.splice(i, 1);
    _announce();
  };
}

/** Run the newest registered handler; true when it consumed Back. */
export function runBackHandlers() {
  for (let i = _backHandlers.length - 1; i >= 0; i--) {
    try {
      if (_backHandlers[i]()) return true;
    } catch {}
  }
  return false;
}

/** True while some screen has an inner page to go back from. */
export const hasNestedBack = () => _backHandlers.length > 0;
