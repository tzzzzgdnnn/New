// Dev-only: iOS screen-fit + desktop-CSS split checks (not bundled).
// 1. vite/strip-desktop-css.mjs drops the desktop-only rules from the shared
//    stylesheets and keeps everything the phone renders.
// 2. No iOS source uses a class the iOS build strips.
// 3. src/platform/ios/screen-fit.css: display titles clamp to 2 lines with
//    clamp() sizes, the landscape billboard fits between the bars, and the
//    sheet is loaded last on iOS only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import stripDesktopCss, { isDesktopOnlySelector, DESKTOP_ONLY_CLASSES } from "../vite/strip-desktop-css.mjs";

// postcss is CommonJS (Vite's own copy): load it at run time, not bundled.
const postcss = createRequire(import.meta.url)("postcss");

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log("ok -", name); };

const read = (p) => fs.readFileSync(p, "utf8");
const strip = async (file) =>
  (await postcss([stripDesktopCss()]).process(read(file), { from: path.resolve(file) })).root;
const selectorsOf = (root) => {
  const out = new Set();
  root.walkRules((r) => r.selectors.forEach((s) => out.add(s.replace(/\s+/g, " ").trim())));
  return out;
};

const globalBefore = selectorsOf(postcss.parse(read("src/styles/global.css")));
const globalRoot = await strip("src/styles/global.css");
const globalAfter = selectorsOf(globalRoot);
const iosRoot = await strip("src/platform/ios/ios.css");
const iosAfter = selectorsOf(iosRoot);

await t("strips desktop-only rules from global.css", async () => {
  for (const sel of [
    ".sidebar", ".sidebar-btn", ".hero", ".hero-title", ".carousel-item",
    ".window-titlebar", ".close-confirm-modal", ".settings-section",
    "html[data-win-titlebar] .main", "kbd", "::highlight(settings-search)",
  ]) {
    assert.ok(globalBefore.has(sel), `fixture moved: ${sel} no longer in global.css`);
    assert.ok(!globalAfter.has(sel), `desktop rule shipped on iOS: ${sel}`);
  }
  assert.ok(globalAfter.size < globalBefore.size * 0.9, "expected a real cut");
});

await t("keeps every shared rule the phone renders", async () => {
  for (const sel of [
    ".detail-title", ".detail-content", ".search-result", ".search-result-title",
    ".modal-overlay", ".section-title", ".library-title", ".player-wrap",
    ".player-overlay-btn", ".btn", ".main", ".card",
  ]) assert.ok(globalAfter.has(sel), `shared rule stripped: ${sel}`);
  for (const sel of ["html.sb-ios .sb-bill-title", "html.sb-ios .download-modal"])
    assert.ok(iosAfter.has(sel), `iOS rule stripped: ${sel}`);
});

await t("a mixed selector list loses only its desktop part", async () => {
  const root = (await postcss([stripDesktopCss({ files: /./ })]).process(
    ".a, .sidebar .a, .hero-title { color: red } .tooltip { color: blue } @media (max-width: 9px) { .carousel-item { x: y } }",
    { from: "x.css" },
  )).root;
  const sels = [];
  root.walkRules((r) => sels.push(r.selector));
  assert.deepEqual(sels, [".a"]);
  let media = 0;
  root.walkAtRules(() => media++);
  assert.equal(media, 0, "empty @media left behind");
  assert.ok(!isDesktopOnlySelector("html.sb-ios .sb-bill-title"));
  assert.ok(!isDesktopOnlySelector(".detail-hero"), "detail-hero is shared, not the desktop hero");
  assert.ok(isDesktopOnlySelector("html.sb-ios .hero-actions .btn"));
});

await t("only global.css and ios.css are stripped by default", async () => {
  const css = ".sidebar { color: red }";
  const out = await postcss([stripDesktopCss()]).process(css, { from: "/x/settings.css" });
  assert.equal(out.css, css);
});

await t("no iOS source uses a class the iOS build strips", async () => {
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(jsx?|css)$/.test(f.name)) files.push(p);
    }
  };
  walk("src/platform/ios");
  walk("src/components/downloads");
  files.push("src/main.ios.jsx");
  const classes = new Set();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/className=\{?[`"']([^`"'}]+)/g))
      m[1].split(/\s+/).forEach((c) => c && !c.includes("$") && classes.add(c));
    if (f.endsWith(".css")) postcss.parse(src).walkRules((r) =>
      r.selectors.forEach((s) => { for (const m of s.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) classes.add(m[1]); }));
  }
  const bad = [...classes].filter((c) => isDesktopOnlySelector("." + c));
  // ios.css still names a few desktop classes to hide or restyle them; the
  // strip pass removes those rules, which is the point.
  const allowed = new Set(["hero", "hero-gradient", "hero-content", "hero-title", "hero-meta", "hero-overview",
    "hero-actions", "hero-type", "hero-bg", "close-confirm-modal", "window-titlebar"]);
  assert.deepEqual(bad.filter((c) => !allowed.has(c)), [], "iOS uses stripped classes");
  assert.ok(DESKTOP_ONLY_CLASSES.length > 10);
});

// ── screen-fit.css ────────────────────────────────────────────────────────
const fit = postcss.parse(read("src/platform/ios/screen-fit.css"));
const decls = (pred) => {
  const out = [];
  fit.walkRules((r) => {
    if (!pred(r)) return;
    r.walkDecls((d) => out.push({ sel: r.selector, prop: d.prop, value: d.value, media: r.parent.type === "atrule" ? r.parent.params : "" }));
  });
  return out;
};
const TITLES = ["detail-title", "sb-bill-title", "library-title", "pd-page__title", "sps-large-title", "sp-who-title"];

await t("display titles clamp to two lines", async () => {
  for (const c of TITLES) {
    const d = decls((r) => r.parent.type === "root" && r.selector.includes("." + c));
    const get = (p) => d.find((x) => x.prop === p)?.value;
    assert.equal(get("-webkit-line-clamp"), "2", `${c}: no 2-line clamp`);
    assert.equal(get("display"), "-webkit-box", `${c}: clamp needs -webkit-box`);
    assert.equal(get("overflow"), "hidden", `${c}: clamp needs overflow hidden`);
  }
  // The show title in Downloads is a <button>: its inner span clamps.
  assert.match(read("src/components/downloads/PhoneDownloads.jsx"), /pd-show-head__title[^>]*>\s*<span className="sp-clamp2">/);
});

await t("title sizes are fluid in portrait and landscape", async () => {
  const LAND = /orientation: landscape/;
  for (const c of TITLES) {
    const fs_ = decls((r) => r.selector.split(",").some((s) => s.trim().endsWith("." + c))).filter((d) => d.prop === "font-size");
    const portrait = fs_.find((d) => !LAND.test(d.media));
    const land = fs_.find((d) => LAND.test(d.media));
    assert.ok(portrait && /^clamp\(/.test(portrait.value), `${c}: portrait size not clamp()`);
    assert.ok(land && /^clamp\(.*vh/.test(land.value), `${c}: landscape size should clamp on vh`);
    // Never larger than 46px on a phone (the old billboard title was 64px).
    const max = parseFloat(portrait.value.split(",").pop());
    assert.ok(max <= 46, `${c}: max ${max}px is too big for a phone`);
  }
});

await t("landscape billboard fits between the top bar and the tab bar", async () => {
  const bill = decls((r) => r.selector === "html.sb-ios .sb-bill" && /landscape/.test(r.parent.params || ""));
  const h = bill.find((d) => d.prop === "height")?.value || "";
  assert.match(h, /100vh/);
  assert.match(h, /--sp-fit-top/);
  assert.match(h, /--sp-fit-bottom/);
  const root = decls((r) => r.selector === "html.sb-ios" && r.parent.type === "root");
  assert.match(root.find((d) => d.prop === "--sp-fit-top").value, /safe-area-inset-top/);
  assert.match(root.find((d) => d.prop === "--sp-fit-bottom").value, /safe-area-inset-bottom/);
  const logo = decls((r) => r.selector === "html.sb-ios .sb-bill-logo" && /landscape/.test(r.parent.params || ""));
  assert.match(logo.find((d) => d.prop === "max-height").value, /^clamp\(.*vh/);
});

await t("gutters use the safe-area insets", async () => {
  const css = read("src/platform/ios/screen-fit.css");
  for (const re of [/safe-area-inset-left/, /safe-area-inset-right/, /safe-area-inset-top/, /safe-area-inset-bottom/])
    assert.match(css, re);
});

await t("every screen-fit rule is iOS-scoped", async () => {
  fit.walkRules((r) => {
    if (r.parent.type === "atrule" && /keyframes/.test(r.parent.name)) return;
    for (const s of r.selectors) assert.ok(s.startsWith("html.sb-ios"), `unscoped: ${s}`);
  });
});

await t("screen-fit.css loads last on iOS and never on desktop", async () => {
  const ios = read("src/main.ios.jsx");
  const iPolish = ios.indexOf('import "./platform/ios/polish.css"');
  const iFit = ios.indexOf('import "./platform/ios/screen-fit.css"');
  assert.ok(iPolish > 0 && iFit > iPolish, "screen-fit.css must come after polish.css");
  assert.ok(!read("src/main.jsx").includes("screen-fit"), "desktop entry imports screen-fit.css");
  const cfg = read("vite.config.js");
  assert.match(cfg, /isIOS \? \{ css: \{ postcss: \{ plugins: \[stripDesktopCss\(\)\] \} \} \} : \{\}/, "strip pass must be iOS-only");
});

console.log(`screen-fit: ${pass} passed`);
