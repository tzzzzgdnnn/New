// Dev-only: the iPhone player's connection pill, copied from the Android
// player (PlayerActivity.updatePill on apk-port). A JS mirror of NetPill
// (ios/App/App/DownloadMath.swift) plus source checks of how
// StreambertPlayer.swift wires it. The Swift side of the same table is in
// scripts/DownloadMathTests.swift. Not bundled.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const src = readFileSync("ios/App/App/StreambertPlayer.swift", "utf8");
const math = readFileSync("ios/App/App/DownloadMath.swift", "utf8");
const body = (name, text = src) => {
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

// ---- JS mirror of NetPill (keep in step with DownloadMath.swift) ----
const NetPill = {
  greenMbps: 10, amberMbps: 4, smoothing: 0.35, hideAfter: 2.5,
  totals: (events) => events.reduce((t, e) => ({
    bytes: t.bytes + Math.max(0, e.bytes), transferSec: t.transferSec + Math.max(0, e.transferSec),
  }), { bytes: 0, transferSec: 0 }),
  reading(prev, cur, observed) {
    if (prev && cur.bytes >= prev.bytes && cur.transferSec >= prev.transferSec) {
      const b = cur.bytes - prev.bytes, s = cur.transferSec - prev.transferSec;
      return b > 0 && s > 0.01 ? (b * 8) / s : null;
    }
    return observed > 0 ? observed : null;
  },
  smooth: (prev, r) => (r == null || r <= 0 ? prev : prev <= 0 ? r : prev + NetPill.smoothing * (r - prev)),
  light: (bps) => (bps / 1e6 >= 10 ? "green" : bps / 1e6 >= 4 ? "amber" : "red"),
  throttled: (bps, v) => bps > 0 && v > 0 && bps < v,
  resolution: (h) => (h > 0 ? (h >= 2160 ? "4K" : `${h}p`) : "—"),
  text(bps, h, v) {
    const rate = v > 0 ? ` · ${(v / 1e6).toFixed(1)} Mbps video` : "";
    return `${bps > 0 ? "●" : "○"} ${(bps / 1e6).toFixed(1)} Mbps  ·  ${NetPill.resolution(h)}${rate}`;
  },
};

// Android's updatePill, as shipped on apk-port, for reference.
const android = (estimate, height, videoBitrate) => {
  const mbps = estimate / 1e6;
  const res = height > 0 ? (height >= 2160 ? "4K" : height + "p") : "—";
  const rate = videoBitrate > 0 ? ` · ${(videoBitrate / 1e6).toFixed(1)} Mbps video` : "";
  const color = mbps >= 10 ? "green" : mbps >= 4 ? "amber" : "red";
  return { text: `${estimate > 0 ? "●" : "○"} ${mbps.toFixed(1)} Mbps  ·  ${res}${rate}`, color };
};

test("wording matches the Android pill (and the user's photo)", () => {
  assert.equal(NetPill.text(25.4e6, 1080, 4.2e6), "● 25.4 Mbps  ·  1080p · 4.2 Mbps video");
  for (const [b, h, v] of [[25.4e6, 1080, 4.2e6], [0, 0, 0], [3.1e6, 720, 2.5e6], [40e6, 2160, 16e6], [9.99e6, 480, 0]]) {
    assert.equal(NetPill.text(b, h, v), android(b, h, v).text);
    assert.equal(NetPill.light(b), android(b, h, v).color);
  }
});

test("light thresholds: green >= 10 Mbps, amber >= 4, red below", () => {
  assert.equal(NetPill.light(10e6), "green");
  assert.equal(NetPill.light(9.999e6), "amber");
  assert.equal(NetPill.light(4e6), "amber");
  assert.equal(NetPill.light(3.999e6), "red");
  assert.equal(NetPill.light(0), "red");
  assert.ok(NetPill.throttled(3e6, 4.2e6) && !NetPill.throttled(25e6, 4.2e6));
});

test("speed from the access log: bytes over transfer time, held when idle, smoothed", () => {
  const a = NetPill.totals([{ bytes: 1e6, transferSec: 1 }]);
  const b = NetPill.totals([{ bytes: 1e6, transferSec: 1 }, { bytes: 3e6, transferSec: 1 }]);
  assert.equal(NetPill.reading(a, b, 0), 24e6);
  assert.equal(NetPill.reading(b, b, 9e6), null);
  assert.equal(NetPill.reading(null, a, 9e6), 9e6);
  assert.equal(NetPill.reading(b, a, 7e6), 7e6); // log restarted (new item)
  assert.equal(NetPill.smooth(0, 20e6), 20e6);
  assert.equal(NetPill.smooth(20e6, null), 20e6);
  assert.ok(Math.abs(NetPill.smooth(20e6, 10e6) - 16.5e6) < 1);
});

test("Swift NetPill carries the same constants and wording", () => {
  assert.match(math, /static let greenMbps = 10\.0/);
  assert.match(math, /static let amberMbps = 4\.0/);
  assert.match(math, /static let smoothing = 0\.35/);
  assert.match(math, /static let hideAfter: TimeInterval = 2\.5/);
  assert.match(math, /static let connectingText = "● Connecting…"/);
  assert.match(body("text", math), /Mbps  ·  \\\(resolution\(height: height\)\)\\\(rate\)/);
  assert.match(body("text", math), /Mbps video/);
});

test("pill looks like Android's chip: colours, fill, border, font, padding", () => {
  for (const hex of ["0x2ECC71", "0xF1C40F", "0xE74C3C"]) assert.ok(src.includes(hex), hex);
  assert.match(src, /backgroundColor = UIColor\(white: 0, alpha: 0x99 \/ 255\.0\)/);
  assert.match(src, /layer\.borderWidth = 1/);
  assert.match(src, /alpha: 0x88 \/ 255\.0/);
  assert.match(src, /systemFont\(ofSize: 13, weight: \.medium\)/);
  assert.match(src, /UIEdgeInsets\(top: 8, left: 14, bottom: 8, right: 14\)/);
  assert.match(src, /layer\.cornerRadius = bounds\.height \/ 2/);
});

test("speed comes from AVPlayerItem.accessLog() once a second", () => {
  const u = body("updateNetPill");
  assert.match(u, /accessLog\(\)/);
  assert.match(u, /numberOfBytesTransferred/);
  assert.match(u, /transferDuration/);
  assert.match(u, /observedBitrate/);
  assert.match(u, /indicatedBitrate/);
  assert.match(u, /NetPill\.smooth\(/);
  assert.match(body("startNetMeter"), /NetPill\.refreshEvery/);
  assert.match(body("closePlayer"), /stopNetMeter\(\)/);
});

test("pill shows with the controls, fades after 2.5 s, never takes taps", () => {
  assert.match(body("setControls"), /setNetPill\(visible: visible\)/);
  assert.match(body("scheduleNetPillHide"), /NetPill\.hideAfter/);
  assert.match(body("scheduleNetPillHide"), /timeControlStatus == \.playing/);
  assert.match(body("scheduleHide"), /setNetPill\(visible: true\)/);
  assert.match(src, /final class NetPillLabel[\s\S]{0,900}isUserInteractionEnabled = false/);
  assert.doesNotMatch(src, /controls\.addSubview\(netPill\)/);
});

test("old health dot is gone; tap rules untouched", () => {
  assert.doesNotMatch(src, /HealthDotView|ConnectionHealthMonitor|healthLabel/);
  assert.match(body("handleSingleTap"), /PlayerTap\.singleTap\(/);
  assert.match(math, /justShownWindow: TimeInterval = 0\.6/);
  assert.match(math, /doubleTapWindow: TimeInterval = 0\.3/);
});
