// Dev-only: the best-quality rule (src/utils/servers/quality.js) and the
// players that use it: every title starts on its tallest rendition, the best
// stream across servers wins, and no player caps the start low. Not shipped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { parseHlsVariants, streamMaxHeight, rankByQuality, topLevelIndex, sortVariants } from "../src/utils/servers/quality.js";

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4200000,RESOLUTION=1920x1080
1080/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480
https://cdn.example/480/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
720/index.m3u8
`;

test("parses every variant of a master playlist with absolute urls", () => {
  const v = parseHlsVariants(MASTER, "https://cdn.example/show/master.m3u8");
  assert.deepEqual(v.map((x) => x.height), [360, 1080, 480, 720]);
  assert.equal(v[1].url, "https://cdn.example/show/1080/index.m3u8");
  assert.equal(v[1].bandwidth, 4200000, "AVERAGE-BANDWIDTH preferred");
  assert.equal(v[2].url, "https://cdn.example/480/index.m3u8");
  assert.equal(streamMaxHeight(MASTER), 1080);
  assert.equal(streamMaxHeight("#EXTM3U\n#EXTINF:6,\nseg1.ts\n"), 0, "media playlist: unknown");
  assert.equal(sortVariants(v)[0].height, 1080);
});

test("hls.js starts on the tallest level, then the highest bitrate", () => {
  assert.equal(topLevelIndex([{ height: 360, bitrate: 8e5 }, { height: 1080, bitrate: 4e6 }, { height: 1080, bitrate: 6e6 }, { height: 720, bitrate: 9e6 }]), 2);
  assert.equal(topLevelIndex([{ height: 480, bitrate: 1e6 }]), 0);
  assert.equal(topLevelIndex([]), -1);
  assert.equal(topLevelIndex([{ bitrate: 1e6 }, { bitrate: 3e6 }]), 1, "no heights: highest bitrate");
});

test("servers ranked by best picture, then bitrate; unknown keep their order after", () => {
  const r = rankByQuality([
    { id: "a", height: 480 },
    { id: "b" },
    { id: "c", height: 1080, bandwidth: 3e6 },
    { id: "d", height: 1080, bandwidth: 6e6 },
    { id: "e" },
    { id: "f", height: 720 },
  ]);
  assert.deepEqual(r.map((x) => x.id), ["d", "c", "f", "a", "b", "e"]);
});

test("no player caps the start low", () => {
  const dp = readFileSync("src/platform/web/directPlayer.js", "utf8");
  assert.doesNotMatch(dp, /capLevelToPlayerSize:\s*true/, "web: never capped to the inline box");
  assert.doesNotMatch(dp, /startLevel:\s*0\b/, "web: never starts on the lowest level");
  assert.ok((dp.match(/startOnTop\(hls\)/g) || []).length >= 2, "warm-up and play both start on top");
  const swift = "ios/App/App/StreambertPlayer.swift";
  if (existsSync(swift)) {
    const s = readFileSync(swift, "utf8");
    assert.doesNotMatch(s, /preferredPeakBitRate = 2_500_000/, "iPhone app: no low start cap on Auto");
    assert.match(s, /startsOnFirstEligibleVariant = false/);
  }
  const java = "android/app/src/main/java/com/tezz/tezzdagoat/PlayerActivity.java";
  if (existsSync(java)) assert.match(readFileSync(java, "utf8"), /setInitialBitrateEstimate\(/, "Android: starts high");
});
