// iOS build only (`vite build --mode ios`): PostCSS plugin that drops the
// desktop-only rules from the shared stylesheets, so the phone bundle does
// not ship CSS for the sidebar, window titlebar, desktop hero, carousels,
// desktop Settings / Downloads pages and the like. The desktop build does
// not run it, so its CSS (and cascade order) is byte-for-byte unchanged.
//
// A selector is desktop-only when it names one of the class families below
// (or one of the extra markers). A rule loses only its desktop-only
// selectors; it is removed when none are left. At-rules left empty go too.

/** Class names (exact) or prefixes (ending in "-" or "*") used only on desktop. */
export const DESKTOP_ONLY_CLASSES = [
  "sidebar*", // Sidebar.jsx (incl. sidebar-context-menu*)
  "saved-thumb*",
  "tooltip",
  "hero", "hero-*", // desktop Home hero; iOS uses .sb-bill
  "window-titlebar*", "titlebar-btn*", // WindowTitlebar.jsx
  "close-confirm-*", // CloseConfirmModal.jsx
  "settings-section*", "settings-sep", // desktop SettingsPage.jsx
  "anime-override-*",
  "carousel-*", // TrendingCarousel.jsx (not bundled on iOS)
  "dl-page*", "dl-toolbar*", "dl-search-bar*", // desktop DownloadsPage list
  "kbd-*", "shortcut-*", // KeyboardShortcutsModal.jsx
  "update-modal*", // UpdateModal.jsx
];

/** Non-class markers: attribute/element/pseudo selectors only desktop uses. */
const DESKTOP_ONLY_PATTERNS = [
  /\[data-win-titlebar\]/, // set by WindowTitlebar on <html>
  /::highlight\(settings-search/, // desktop Settings search
  /(^|[\s>+~(])kbd(?![\w-])/, // <kbd> appears only in desktop hints
];

const STYLESHEETS = /(?:^|[\\/])(global\.css|ios\.css)(?:\?|$)/;

function classMatcher(list) {
  const exact = new Set();
  const prefixes = [];
  for (const c of list) {
    if (c.endsWith("*")) prefixes.push(c.slice(0, -1));
    else exact.add(c);
  }
  return (name) => exact.has(name) || prefixes.some((p) => name.startsWith(p));
}
const isDesktopClass = classMatcher(DESKTOP_ONLY_CLASSES);

/** True when this single selector only ever matches desktop UI. */
export function isDesktopOnlySelector(sel) {
  if (DESKTOP_ONLY_PATTERNS.some((re) => re.test(sel))) return true;
  for (const m of sel.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
    if (isDesktopClass(m[1])) return true;
  }
  return false;
}

function inKeyframes(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "atrule" && /keyframes$/i.test(p.name)) return true;
  }
  return false;
}

/**
 * @param {{ files?: RegExp }} [opts] which stylesheets to strip (default:
 *   global.css and ios.css; the iOS-only sheets have nothing to strip).
 */
export default function stripDesktopCss(opts = {}) {
  const files = opts.files || STYLESHEETS;
  return {
    postcssPlugin: "strip-desktop-css",
    Once(root, { result }) {
      const from = result.opts.from || root.source?.input?.file || "";
      if (from && !files.test(from)) return;
      root.walkRules((rule) => {
        if (inKeyframes(rule)) return;
        const keep = rule.selectors.filter((s) => !isDesktopOnlySelector(s));
        if (keep.length === 0) rule.remove();
        else if (keep.length !== rule.selectors.length) rule.selectors = keep;
      });
      // Drop at-rules (e.g. @media) the pass left with no rules inside.
      let changed = true;
      while (changed) {
        changed = false;
        root.walkAtRules((at) => {
          if (at.nodes && at.nodes.every((n) => n.type === "comment")) {
            at.remove();
            changed = true;
          }
        });
      }
    },
  };
}
stripDesktopCss.postcss = true;
