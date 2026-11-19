// Dev-only: guards the native Skip Intro pill (StreambertPlayer.swift) against
// "if you don't skip and keep watching, it never leaves". No Swift toolchain in
// CI, so this checks the wiring and mirrors SkipPill's decision table; the
// Swift table itself is in scripts/DownloadMathTests.swift. Not bundled.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const src = readFileSync("ios/App/App/StreambertPlayer.swift", "utf8");
const math = readFileSync("ios/App/App/DownloadMath.swift", "utf8");
const body = (text, name) => {
  const i = text.indexOf(`func ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  const open = text.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) return text.slice(open, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
};

test("updateSkip goes through SkipPill and retires the generic jump", () => {
  const u = body(src, "updateSkip");
  assert.match(u, /SkipPill\.retireJump\(/);
  assert.match(u, /SkipPill\.visible\(/);
  assert.match(u, /skipIntervals\.removeAll \{ \$0\.kind == "jump" \}/);
  assert.match(u, /jumpShownAt = t/);
});

test("jumpShownAt resets per episode and the hide can't be undone by a stale fade", () => {
  assert.match(body(src, "loadSkipTimes"), /jumpShownAt = nil/);
  assert.match(body(src, "hideSkipPill"), /if self\.activeSkip == nil \{ self\.skipButton\.isHidden = true \}/);
  assert.match(math, /static let jumpVisibleFor: Double = 12/);
});

// Mirror of SkipPill (keep in sync with DownloadMath.swift).
const VIS = 12;
const visible = (ivs, t, shown) => {
  for (const iv of ivs) {
    if (!(t >= iv.start && t < iv.end - 1)) continue;
    if (iv.kind === "jump" && shown != null && (t - shown >= VIS || t < shown)) continue;
    return iv;
  }
  return null;
};
const retire = (t, shown, w) => t >= w.end - 1 || (shown != null && t - shown >= VIS);

test("watching through without tapping: the pill leaves", () => {
  const jump = { kind: "jump", start: 20, end: 300 };
  let ivs = [jump];
  let shown = null;
  let lastVisible = null;
  for (let t = 0; t <= 320; t += 0.5) {
    if (ivs.some((i) => i.kind === "jump") && retire(t, shown, { start: 20, end: 300 })) ivs = ivs.filter((i) => i.kind !== "jump");
    const v = visible(ivs, t, shown);
    if (v?.kind === "jump" && shown == null) shown = t;
    if (v) lastVisible = t;
  }
  assert.equal(shown, 20);
  assert.ok(lastVisible < 20 + VIS, `pill gone by ${20 + VIS}s, last seen ${lastVisible}`);
});

test("a real opening: visible only inside it", () => {
  const op = { kind: "op", start: 90, end: 180 };
  assert.equal(visible([op], 95, null), op);
  assert.equal(visible([op], 179.5, null), null);
  assert.equal(visible([op], 400, null), null);
});
