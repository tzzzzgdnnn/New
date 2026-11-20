// Page scroll lock for modal sheets. Reference-counted, so two sheets open at
// once (or one opening as another closes) never leave the page stuck locked
// or unlocked. The class on <html> is styled in ios.css.

/** Class set on <html> while any sheet holds the lock. */
export const SCROLL_LOCK_CLASS = "sp-scroll-locked";

let holders = 0;

/** Lock page scrolling; returns the matching unlock (safe to call twice). */
export function lockPageScroll(root = globalThis.document?.documentElement) {
  if (!root) return () => {};
  holders++;
  root.classList.add(SCROLL_LOCK_CLASS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0) root.classList.remove(SCROLL_LOCK_CLASS);
  };
}

/** Number of sheets currently holding the lock (for tests and diagnostics). */
export const scrollLockHolders = () => holders;
