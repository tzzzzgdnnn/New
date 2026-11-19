// Dev-only: guards the native player's tap-to-show-controls wiring
// (ios/App/App/StreambertPlayer.swift) against the regressions behind
// "sometimes a tap doesn't bring up the controls". There is no Swift
// toolchain in CI, so this checks the source; the decision table itself
// (PlayerTap) is covered by scripts/DownloadMathTests.swift. Not bundled.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const src = readFileSync("ios/App/App/StreambertPlayer.swift", "utf8");
const math = readFileSync("ios/App/App/DownloadMath.swift", "utf8");
const body = (name) => {
  const i = src.indexOf(`func ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(open, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
};

test("tap recognizers sit on the root view, so taps outside the 16:9 box / under hidden controls land", () => {
  const g = body("setupGestures");
  assert.match(g, /view\.addGestureRecognizer\(doubleTap\)/);
  assert.match(g, /view\.addGestureRecognizer\(singleTap\)/);
  assert.doesNotMatch(g, /videoView\.addGestureRecognizer|controls\.addGestureRecognizer/);
});

test("single tap never waits on the double tap (controls appear immediately)", () => {
  assert.doesNotMatch(body("setupGestures"), /require\(toFail/);
  assert.match(src, /shouldRecognizeSimultaneouslyWith[\s\S]{0,80}\)\s*->\s*Bool\s*\{\s*true/);
});

test("delegate skips buttons/sliders and visible cards only", () => {
  assert.match(src, /extension StreambertPlayerViewController: UIGestureRecognizerDelegate/);
  assert.match(src, /shouldReceive touch: UITouch\)[\s\S]{0,400}cur is UIControl/);
});

test("decorative overlays above the controls never swallow touches", () => {
  for (const v of ["spinner", "statusLabel", "toastLabel", "healthLabel"]) {
    assert.match(src, new RegExp(`${v}\\.isUserInteractionEnabled = false`), v);
  }
});

test("tap handling follows PlayerTap; hides are deferred and cancellable", () => {
  const t = body("handleSingleTap");
  assert.match(t, /PlayerTap\.singleTap\(/);
  assert.match(t, /tapHideWork = w/);
  assert.match(body("handleDoubleTap"), /tapHideWork\?\.cancel\(\)/);
  assert.match(body("setControls"), /tapHideWork\?\.cancel\(\)/);
  assert.match(body("setControls"), /controlsShownAt = CACurrentMediaTime\(\)/);
  assert.match(math, /enum PlayerTap/);
});

// JS mirror of PlayerTap.singleTap, kept in step with DownloadMath.swift.
const singleTap = ({ shown, since, pending }) =>
  pending ? "cancelPendingHide" : !shown ? "show" : since < 0.6 ? "keep" : "hideAfterDoubleTapWindow";

test("PlayerTap table: hidden always shows; just-shown keeps; settled hides later", () => {
  assert.match(math, /if hidePending \{ return \.cancelPendingHide \}/);
  assert.match(math, /if !controlsShown \{ return \.show \}/);
  assert.match(math, /justShownWindow: TimeInterval = 0\.6/);
  assert.equal(singleTap({ shown: false, since: 99, pending: false }), "show");
  assert.equal(singleTap({ shown: true, since: 0.2, pending: false }), "keep");
  assert.equal(singleTap({ shown: true, since: 3, pending: false }), "hideAfterDoubleTapWindow");
  assert.equal(singleTap({ shown: true, since: 3, pending: true }), "cancelPendingHide");
});
