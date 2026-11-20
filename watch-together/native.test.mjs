// Watch Together with the real native-player adapters (adapters/ios.js and
// adapters/android.js) on both ends: a fake native side (the bridge
// StreambertPlayer.swift / SbPlayerPlugin.java implement) runs a simulated
// player, pushes its state every 250 ms and reports the viewer's taps, the
// same messages the apps send. Covers Pick + Play auto-start together,
// pause / play / seek / stop from any device, drift, and the iPhone key sync.
import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTime, SimPlayer, SimNet } from "./sim.mjs";
import { WatchClient } from "../src/watch/client.js";
import { createAndroidAdapter } from "../src/watch/adapters/android.js";
import { createIosAdapter } from "../src/watch/adapters/ios.js";
import { mediaKey, cleanMedia } from "../src/watch/protocol.js";
import { shouldAutoOpen } from "../src/watch/autoOpen.js";

// adapters/ios.js talks to window.webkit / window.__sbWatch*: one iPhone per test.
globalThis.window = globalThis.window || {};

const MOVIE = cleanMedia({ type: "movie", tmdbId: 603, title: "The Matrix" });
const SHOW = cleanMedia({ type: "tv", tmdbId: 1399, title: "GoT", season: 1, episode: 2 });

/** The native side of the bridge, driving a SimPlayer like AVPlayer / ExoPlayer would. */
class FakeNative {
  constructor(vt, player, kind) {
    Object.assign(this, { vt, p: player, kind, on: false, watchKey: null, log: [] });
  }
  handle(m) {
    this.log.push(m.cmd);
    const p = this.p;
    switch (m.cmd) {
      case "begin":
        this.on = true;
        this.watchKey = m.key ?? null;
        this.timer = this.vt.setInterval(() => this.push(), 250);
        break;
      case "end":
        this.on = false;
        this.vt.clearInterval(this.timer);
        break;
      case "setKey":
        this.watchKey = m.key ?? null;
        break;
      case "pause":
        if (p.key) p.pause(m.pos);
        break;
      case "playAt":
        if (p.key) p.playAt(m.pos, m.atMs, m.rate);
        break;
      case "setRate":
        if (p.key) p.setRate(m.rate);
        break;
      case "seek":
        if (p.key) p.seekTo(m.pos);
        break;
    }
  }
  state() {
    const p = this.p;
    const open = !!p.key && !this.closed;
    const r = p.read();
    const s = { pos: p.t, rate: r.rate, status: open ? p.status : "paused", ready: open && r.ready, seeking: r.seeking, sampledAt: p.localNow() };
    if (this.kind === "ios") s.key = open ? this.watchKey : null; // StreambertPlayer: watchKey while its player is up
    else s.open = open; // SbPlayerPlugin: open flag, JS knows the key
    return s;
  }
  push() {
    if (!this.on) return;
    this.deliverState(this.state());
  }
  // The viewer's own taps on the native controls.
  tapPause() {
    this.p.pause(this.p.t);
    this.deliverIntent({ action: "pause", pos: this.p.t, rate: 1 });
  }
  tapPlay() {
    this.deliverIntent({ action: "play", pos: this.p.t, rate: 1 });
  }
  tapSeek(pos) {
    this.p.seekTo(pos);
    this.deliverIntent({ action: "seek", pos, rate: 1 });
  }
  close() {
    const pos = this.p.t;
    this.closed = true;
    this.p.pause(pos);
    if (this.kind === "android") this.deliverIntent({ action: "stop", pos, rate: 1 });
    // iPhone: the bridge just reports no player any more (key null); the adapter turns that into the stop.
    this.push();
  }
}

/** A device in the room: native player + its real adapter + a real WatchClient. */
function device(vt, net, { id, kind, skewMs = 0, loadMs = 1500, lat = { up: 40, down: 40, jitter: 15 }, speedError = 0, startLatencyMs = 0 }) {
  const p = new SimPlayer(vt, { kind: kind === "ios" ? "ios" : "web", skewMs, speedError, startLatencyMs, seekMs: 90 });
  const nat = new FakeNative(vt, p, kind);
  const page = { key: null }; // the title page this device has open (window.__sbCtx)
  const getKey = () => page.key;
  let adapter;
  if (kind === "android") {
    const listeners = {};
    const plugin = {
      watch: (m) => {
        nat.handle(JSON.parse(JSON.stringify(m)));
        return Promise.resolve();
      },
      addListener: (ev, fn) => {
        listeners[ev] = fn;
        return { remove() {} };
      },
    };
    adapter = createAndroidAdapter({ plugin, getKey, now: p.localNow });
    nat.deliverState = (s) => listeners.watchState?.(s);
    nat.deliverIntent = (i) => listeners.watchIntent?.(i);
  } else {
    window.webkit = { messageHandlers: { sbWatch: { postMessage: (m) => nat.handle(JSON.parse(JSON.stringify(m))) } } };
    adapter = createIosAdapter({ getKey });
    nat.deliverState = (s) => window.__sbWatchState?.(s);
    nat.deliverIntent = (i) => window.__sbWatchIntent?.(i);
  }
  const opened = { n: 0 };
  const client = new WatchClient({
    url: "wss://sim/rooms/ABC234/ws",
    clientId: id,
    platform: kind,
    name: id,
    adapter,
    WebSocketImpl: net.socketClass(lat),
    now: p.localNow,
    timers: vt,
    // Pick + Play: the party's title opens here by itself and its player starts loading.
    onState: (st) => {
      const key = st.media?.key;
      if (key && page.key !== key) {
        page.key = key;
        opened.n += 1;
        p.load(key, loadMs);
        nat.closed = false;
      }
    },
  });
  adapter.begin();
  client.connect();
  return { id, kind, p, nat, adapter, client, page, opened };
}

function party(specs) {
  const vt = new VirtualTime();
  const net = new SimNet(vt);
  const devs = specs.map((s) => {
    const d = device(vt, net, s);
    vt.run(60);
    return d;
  });
  const step = (_t, dt) => devs.forEach((d) => d.p.advance(dt));
  const run = (ms) => vt.run(ms, step);
  const positions = () => devs.map((d) => d.p.t);
  const spread = () => Math.max(...positions()) - Math.min(...positions());
  return { vt, net, devs, run, spread, positions };
}

const allPlaying = (devs) => devs.every((d) => d.p.status === "playing");
const allPaused = (devs) => devs.every((d) => d.p.status === "paused");

test("Pick + Play: the picked title opens and starts on iPhone + Android together, nobody taps Play", () => {
  const { devs, run, spread, net } = party([
    { id: "iphone", kind: "ios", skewMs: 350, loadMs: 1200 },
    { id: "android", kind: "android", skewMs: -700, loadMs: 2600, startLatencyMs: 120 },
  ]);
  run(1500);
  devs[1].client.pickMedia(MOVIE); // Android picks
  run(1500);
  // Nobody is playing yet: the room waits for the slower phone to buffer.
  assert.ok(devs.every((d) => d.opened.n === 1), "both devices opened the title by themselves");
  assert.equal(net.core.playback.paused, true, "held while the Android phone still loads");
  run(8000);
  assert.equal(net.core.playback.paused, false, "started once everyone was buffered");
  assert.ok(allPlaying(devs), `both playing: ${devs.map((d) => d.p.status)}`);
  assert.ok(spread() < 0.08, `same position (spread ${spread().toFixed(3)} s)`);
  assert.ok(devs.every((d) => d.p.t > 3), "actually advancing");
});

test("pause / play / seek / stop from either native player reach every device", () => {
  const { devs, run, spread, net } = party([
    { id: "iphone", kind: "ios", skewMs: 120 },
    { id: "android", kind: "android", skewMs: -400, startLatencyMs: 120 },
  ]);
  run(1000);
  devs[0].client.pickMedia(SHOW);
  run(10_000);
  assert.ok(allPlaying(devs));
  const [ios, android] = devs;

  // Android viewer taps Pause → the iPhone pauses on the same frame.
  android.nat.tapPause();
  run(1500);
  assert.ok(allPaused(devs), `paused everywhere: ${devs.map((d) => d.p.status)}`);
  assert.ok(spread() < 0.05, `same frame (spread ${spread().toFixed(3)})`);
  const held = net.core.playback.pos;

  // iPhone viewer taps Play → both restart together from the held frame.
  ios.nat.tapPlay();
  run(3000);
  assert.ok(allPlaying(devs));
  assert.ok(spread() < 0.08, `together (spread ${spread().toFixed(3)})`);
  assert.ok(ios.p.t > held + 1);

  // Android seeks forward 10 s → both land there and carry on.
  const target = android.p.t + 10;
  android.nat.tapSeek(target);
  run(4000);
  assert.ok(allPlaying(devs));
  assert.ok(devs.every((d) => d.p.t > target), "both past the seek target");
  assert.ok(spread() < 0.08, `together after seek (spread ${spread().toFixed(3)})`);

  // iPhone pauses → Android pauses.
  ios.nat.tapPause();
  run(1500);
  assert.ok(allPaused(devs));
  ios.nat.tapPlay();
  run(3000);
  assert.ok(allPlaying(devs));

  // Android viewer closes the player ("stop") → the party pauses for everyone.
  android.nat.close();
  run(1500);
  assert.equal(net.core.playback.paused, true, "room paused by the stop");
  assert.equal(ios.p.status, "paused", "iPhone stopped too");
});

test("closing the iPhone player while playing pauses the Android phone", () => {
  const { devs, run, net } = party([
    { id: "iphone", kind: "ios" },
    { id: "android", kind: "android", startLatencyMs: 100 },
  ]);
  run(1000);
  devs[0].client.pickMedia(MOVIE);
  run(9000);
  assert.ok(allPlaying(devs));
  devs[0].nat.close();
  run(1500);
  assert.equal(net.core.playback.paused, true);
  assert.equal(devs[1].p.status, "paused");
});

test("buffering on one phone holds everyone; they restart together (and chat traffic never pauses)", () => {
  const { devs, run, spread, net } = party([
    { id: "iphone", kind: "ios" },
    { id: "android", kind: "android", startLatencyMs: 120 },
  ]);
  run(1000);
  devs[1].client.pickMedia(MOVIE);
  run(9000);
  assert.ok(allPlaying(devs));
  for (let i = 0; i < 5; i++) devs[i % 2].client.sendChat(`hi ${i}`);
  run(1500);
  assert.ok(allPlaying(devs), "chat never pauses");
  devs[1].p.stallNet = true; // Android's network stops, its buffer runs dry
  devs[1].p.bufEnd = devs[1].p.t + 0.5;
  run(4000);
  assert.equal(net.core.playback.paused, true, "held for the stalled phone");
  assert.equal(devs[0].p.status, "paused", "iPhone waits");
  devs[1].p.stallNet = false;
  run(6000);
  assert.ok(allPlaying(devs), "restarted");
  assert.ok(spread() < 0.08, `together (spread ${spread().toFixed(3)})`);
});

test("drift: a native player running 3% fast is pulled back onto the room's timeline", () => {
  const { devs, run, spread } = party([
    { id: "iphone", kind: "ios" },
    { id: "android", kind: "android", speedError: 0.03, startLatencyMs: 150 },
  ]);
  run(1000);
  devs[0].client.pickMedia(MOVIE);
  run(9000);
  let worst = 0;
  for (let i = 0; i < 60; i++) {
    run(1000);
    worst = Math.max(worst, spread());
  }
  assert.ok(allPlaying(devs));
  assert.ok(worst < 0.35, `never more than a hard-seek apart (worst ${worst.toFixed(3)} s)`);
  assert.ok(spread() < 0.1, `in sync at the end (spread ${spread().toFixed(3)} s)`);
});

test("iPhone joined from Home (no title at begin): native gets the key once the title opens, so remote commands apply", () => {
  const { devs, run, net } = party([
    { id: "android", kind: "android" },
    { id: "iphone", kind: "ios" },
  ]);
  const ios = devs[1];
  assert.equal(ios.nat.watchKey, null, "began with no title");
  run(1000);
  devs[0].client.pickMedia(MOVIE);
  run(9000);
  assert.equal(ios.nat.watchKey, mediaKey(MOVIE), "key synced to native");
  assert.ok(allPlaying(devs));
  devs[0].nat.tapPause();
  run(1500);
  assert.equal(ios.p.status, "paused", "iPhone applied the Android pause");
  assert.equal(net.core.playback.paused, true);
});

test("late joiner on Android auto-opens the playing title and lands on the live position", () => {
  const vt = new VirtualTime();
  const net = new SimNet(vt);
  const devs = [device(vt, net, { id: "iphone", kind: "ios" })];
  const step = (_t, dt) => devs.forEach((d) => d.p.advance(dt));
  vt.run(1000, step);
  devs[0].client.pickMedia(MOVIE);
  vt.run(6000, step);
  assert.equal(devs[0].p.status, "playing");
  devs.push(device(vt, net, { id: "android", kind: "android", startLatencyMs: 120 }));
  vt.run(8000, step);
  assert.equal(devs[1].opened.n, 1);
  assert.equal(devs[1].p.status, "playing");
  assert.ok(Math.abs(devs[1].p.t - devs[0].p.t) < 0.1, `on the live position (${(devs[1].p.t - devs[0].p.t).toFixed(3)})`);
  assert.equal(devs[0].p.status, "playing", "nobody else paused");
});

test("client: a stop while the room is held (title switch) is not a Pause; an old title's taps are ignored", () => {
  const sent = [];
  const adapter = { read: () => ({ key: null }), pause() {}, playAt() {}, setRate() {} };
  const c = new WatchClient({ url: "wss://x/rooms/ABC234/ws", clientId: "a", platform: "android", adapter, WebSocketImpl: class {}, timers: { setTimeout() {}, setInterval() {}, clearInterval() {} } });
  c.sendMsg = (m) => sent.push(m);
  c.state = { media: { key: "movie:1" }, playback: { paused: true, pos: 0, at: 0, rate: 1 } };
  c.intent({ action: "pause", pos: 3, stop: true });
  assert.equal(sent.length, 0, "stop during a hold ignored");
  c.state.playback.paused = false;
  c.intent({ action: "pause", pos: 3, key: "movie:2" });
  assert.equal(sent.length, 0, "tap on another title ignored");
  c.intent({ action: "pause", pos: 3, stop: true, key: "movie:1" });
  assert.equal(sent[0]?.type, "pause");
});

test("android adapter: no open player = no title loaded; open player = the page's title", () => {
  let listeners = {};
  const posted = [];
  const plugin = { watch: (m) => (posted.push(m), Promise.resolve()), addListener: (e, f) => ((listeners[e] = f), { remove() {} }) };
  const a = createAndroidAdapter({ plugin, getKey: () => "movie:603", now: () => 1000 });
  a.begin();
  assert.equal(posted[0].cmd, "begin");
  assert.equal(a.read().key, null);
  let pushes = 0;
  a.onPush = () => pushes++;
  listeners.watchState({ open: true, pos: 12.5, status: "playing", ready: true, seeking: false, rate: 1, sampledAt: 990 });
  assert.equal(pushes, 1, "every push steps the engine");
  assert.deepEqual(a.read(), { key: "movie:603", ready: true, seeking: false, status: "playing", pos: 12.5, sampledAt: 990, rate: 1 });
  const got = [];
  a.onIntent = (i) => got.push(i);
  listeners.watchIntent({ action: "stop", pos: 12.5 });
  assert.equal(got[0].action, "pause");
  assert.equal(got[0].stop, true);
  a.playAt(5, 2000, 1.02);
  assert.deepEqual(posted.at(-1), { cmd: "playAt", pos: 5, atMs: 2000, rate: 1.02 });
});

test("auto-open rule: open a new party title unless just opened here or already in the player", () => {
  const m = { key: "movie:603", rev: 2 };
  assert.equal(shouldAutoOpen(m, { key: null, at: 0 }, 10_000, () => false), true, "guest / host: opens");
  assert.equal(shouldAutoOpen(m, { key: "movie:603", at: 9_000 }, 10_000, () => false), false, "my own pick: already opened");
  assert.equal(shouldAutoOpen(m, { key: "movie:603", at: 0 }, 60_000, () => false), true, "same title picked again later");
  assert.equal(shouldAutoOpen(m, {}, 0, (k) => k === "movie:603"), false, "player already has it");
  assert.equal(shouldAutoOpen(null, {}, 0, () => false), false);
});
