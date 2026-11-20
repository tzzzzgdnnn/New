// Watch Together tests: sync math, the room state machine, a mixed room
// (iPhone + web) simulated end to end, and the Worker / Durable Object glue.
// Run: node --test watch-together/test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { ClockSync } from "../src/watch/clock.js";
import { decideCorrection, HARD_SEEK, MAX_NUDGE } from "../src/watch/drift.js";
import { RoomCore } from "../src/watch/roomCore.js";
import { SyncEngine } from "../src/watch/engine.js";
import { makeCode, normalizeCode, isValidCode, mediaKey, expectedPosition, START_LEAD_MS, RECONNECT_GRACE_MS } from "../src/watch/protocol.js";
import { VirtualTime, SimPlayer, SimNet, addDevice } from "./sim.mjs";

const MOVIE = { type: "movie", tmdbId: 603, title: "The Matrix", server: "cinejoy", audioLang: "en", subLang: "en" };
const EP = (e) => ({ type: "tv", tmdbId: 1399, title: "GoT", season: 1, episode: e, server: "vidnest" });

// ── Codes ────────────────────────────────────────────────────────────────
test("codes: 6 chars, no look-alikes, typed input normalized", () => {
  for (let i = 0; i < 200; i++) {
    const c = makeCode();
    assert.ok(isValidCode(c), c);
    assert.ok(!/[01OIL]/.test(c));
  }
  assert.equal(normalizeCode(" ab c-23x "), "ABC23X");
  assert.equal(normalizeCode("abc23xyz"), "ABC23X");
  assert.ok(!isValidCode("ABC23"));
});

// ── Clock offset (NTP-style) ─────────────────────────────────────────────
test("clock: offset from symmetric pings is exact", () => {
  const c = new ClockSync();
  // server is 5000 ms ahead; 40 ms each way
  for (let i = 0; i < 5; i++) {
    const t0 = 1000 + i * 100;
    c.add(t0, t0 + 40 + 5000, t0 + 80);
  }
  assert.equal(c.offset, 5000);
  assert.equal(c.serverNow(2000), 7000);
  assert.equal(c.toLocal(7000), 2000);
  assert.ok(c.synced);
});

test("clock: asymmetric slow samples are outvoted by the fastest round trips", () => {
  const c = new ClockSync();
  const truth = -1234;
  // Good samples: 20 ms rtt, symmetric
  for (let i = 0; i < 3; i++) c.add(i * 1000, i * 1000 + 10 + truth, i * 1000 + 20);
  // Bad samples: 400 ms rtt, 350 up / 50 down
  for (let i = 3; i < 10; i++) c.add(i * 1000, i * 1000 + 350 + truth, i * 1000 + 400);
  assert.ok(Math.abs(c.offset - truth) <= 1, `offset ${c.offset}`);
  assert.equal(c.uncertainty, 10);
});

// ── Drift correction decisions ───────────────────────────────────────────
test("drift: deadband, gentle rate nudges, hard seek beyond 300 ms", () => {
  assert.deepEqual(decideCorrection(0.01), { action: "none", rate: 1 });
  assert.deepEqual(decideCorrection(-0.02), { action: "none", rate: 1 });
  const ahead = decideCorrection(0.08);
  assert.equal(ahead.action, "rate");
  assert.ok(ahead.rate < 1 && ahead.rate >= 1 - MAX_NUDGE, `ahead slows ${ahead.rate}`);
  const behind = decideCorrection(-0.2);
  assert.ok(behind.rate > 1 && behind.rate <= 1 + MAX_NUDGE, `behind speeds up ${behind.rate}`);
  assert.equal(decideCorrection(0.29).action, "rate");
  assert.equal(decideCorrection(HARD_SEEK).action, "seek");
  assert.equal(decideCorrection(-2).action, "seek");
  // hysteresis: a running nudge continues inside the deadband until settled
  assert.equal(decideCorrection(0.02, { nudging: true }).action, "rate");
  assert.equal(decideCorrection(0.01, { nudging: true }).action, "none");
  // nudges scale with the room's speed
  assert.ok(Math.abs(decideCorrection(0.1, { baseRate: 1.5 }).rate - 1.5 * 0.95) < 1e-9);
  assert.equal(decideCorrection(NaN).action, "none");
});

test("expected position: holds while paused or scheduled, runs at the room rate", () => {
  const pb = { paused: false, pos: 100, at: 10_000, rate: 1 };
  assert.equal(expectedPosition(pb, 9_000), 100);
  assert.equal(expectedPosition(pb, 12_000), 102);
  assert.equal(expectedPosition({ ...pb, rate: 1.5 }, 12_000), 103);
  assert.equal(expectedPosition({ ...pb, paused: true }, 12_000), 100);
});

// ── Room state machine (buffering, scheduled start, anyone picks) ────────
function room() {
  let t = 1_000_000;
  const sent = [];
  const core = new RoomCore({ code: "ABC234", now: () => t, send: (id, msg) => sent.push([id, msg]) });
  return { core, sent, adv: (ms) => (t += ms), now: () => t, last: (id) => sent.filter(([i, m]) => i === id && m.type === "state").at(-1)?.[1] };
}
const ready = (r, id, extra = {}) =>
  r.core.handle(id, { type: "status", rev: r.core.media.rev, epoch: r.core.epoch, ready: true, buffering: false, pos: r.core.playback.pos, ...extra });

test("room: start waits for every member, then is scheduled ahead for all", () => {
  const r = room();
  r.core.join("ios", { platform: "ios" });
  r.core.join("web", { platform: "web" });
  r.core.handle("web", { type: "media", media: MOVIE });
  assert.equal(r.core.media.key, mediaKey(MOVIE));
  assert.equal(r.core.media.by, "web");
  assert.ok(r.core.playback.paused);
  ready(r, "ios");
  assert.ok(r.core.playback.paused, "one ready member is not enough");
  assert.deepEqual(r.core.waitingOn(), ["web"]);
  ready(r, "web");
  assert.equal(r.core.playback.paused, false);
  assert.equal(r.core.playback.at, r.now() + START_LEAD_MS);
  assert.equal(r.last("ios").playback.at, r.last("web").playback.at, "both got the same start instant");
});

test("room: a stale ready (older epoch) never starts playback", () => {
  const r = room();
  r.core.join("a", {});
  r.core.join("b", {});
  r.core.handle("a", { type: "media", media: MOVIE });
  const oldEpoch = r.core.epoch;
  ready(r, "a");
  r.core.handle("b", { type: "seek", pos: 300 });
  r.core.handle("b", { type: "status", rev: r.core.media.rev, epoch: r.core.epoch, ready: true, pos: 300 });
  r.core.handle("a", { type: "status", rev: r.core.media.rev, epoch: oldEpoch, ready: true, pos: 0 });
  assert.ok(r.core.playback.paused);
  ready(r, "a", { pos: 300 });
  assert.equal(r.core.playback.paused, false);
  assert.equal(r.core.playback.pos, 300);
});

test("room: buffering freezes everyone on the stalled frame, resumes together from it", () => {
  const r = room();
  r.core.join("a", {});
  r.core.join("b", {});
  r.core.handle("a", { type: "media", media: MOVIE });
  ready(r, "a");
  ready(r, "b");
  r.adv(START_LEAD_MS + 10_000); // 10 s in
  const expected = expectedPosition(r.core.playback, r.now());
  assert.ok(Math.abs(expected - 10) < 1e-9);
  // b stalls 120 ms behind where the room is
  r.core.handle("b", { type: "status", rev: r.core.media.rev, epoch: r.core.epoch, ready: false, buffering: true, pos: 9.88 });
  assert.ok(r.core.playback.paused, "room held");
  assert.equal(r.core.playback.pos, 9.88, "held on the stalled phone's frame, nobody ahead");
  assert.equal(r.core.holdReason, "buffering");
  assert.equal(r.core.intent, "play", "still wants to play");
  r.adv(3000);
  ready(r, "a", { pos: 9.88 });
  assert.ok(r.core.playback.paused, "still waiting on b");
  assert.deepEqual(r.core.waitingOn(), ["b"]);
  ready(r, "b", { pos: 9.88 });
  assert.equal(r.core.playback.paused, false);
  assert.equal(r.core.playback.pos, 9.88, "resumes from that exact point");
});

test("room: pause / seek / play from any member apply to all", () => {
  const r = room();
  r.core.join("a", {});
  r.core.join("b", {});
  r.core.handle("a", { type: "media", media: MOVIE });
  ready(r, "a");
  ready(r, "b");
  r.adv(START_LEAD_MS + 5000);
  r.core.handle("b", { type: "pause", pos: 5.01 });
  assert.ok(r.core.playback.paused);
  assert.equal(r.core.intent, "pause");
  assert.equal(r.core.playback.pos, 5.01);
  ready(r, "a", { pos: 5.01 });
  ready(r, "b", { pos: 5.01 });
  assert.ok(r.core.playback.paused, "a pause stays paused when everyone is ready");
  r.core.handle("a", { type: "seek", pos: 600 });
  assert.equal(r.core.playback.pos, 600);
  r.core.handle("a", { type: "play" });
  ready(r, "a", { pos: 600 });
  ready(r, "b", { pos: 600 });
  assert.equal(r.core.playback.paused, false);
  assert.equal(r.core.playback.pos, 600);
});

test("room: anyone can pick the next title; everyone switches with server + language", () => {
  const r = room();
  r.core.join("host", {});
  r.core.join("guest", {});
  r.core.handle("host", { type: "media", media: EP(1) });
  const rev1 = r.core.media.rev;
  r.core.handle("host", { type: "stream", rev: rev1, url: "https://cdn.example/ep1.m3u8", headers: { Referer: "https://x/" }, server: "vidnest", audioLang: "en" });
  assert.equal(r.core.media.stream.url, "https://cdn.example/ep1.m3u8");
  // guest picks episode 2
  r.core.handle("guest", { type: "media", media: { ...EP(2), server: "vidnest", audioLang: "en", subLang: "es" } });
  const st = r.last("host");
  assert.equal(st.media.episode, 2);
  assert.equal(st.media.by, "guest");
  assert.equal(st.media.server, "vidnest");
  assert.equal(st.media.subLang, "es");
  assert.equal(st.media.stream, null, "old stream dropped");
  assert.ok(st.playback.paused && st.playback.pos === 0);
  // a stream for the old title is ignored
  r.core.handle("host", { type: "stream", rev: rev1, url: "https://cdn.example/ep1.m3u8" });
  assert.equal(r.core.media.stream, null);
  // only the picker's stream is shared
  r.core.handle("guest", { type: "stream", rev: r.core.media.rev, url: "https://cdn.example/ep2.m3u8", server: "vidnest" });
  r.core.handle("host", { type: "stream", rev: r.core.media.rev, url: "https://other.example/ep2.m3u8" });
  assert.equal(r.core.media.stream.url, "https://cdn.example/ep2.m3u8");
  // both phones hitting Up Next at once: one switch
  const rev = r.core.media.rev;
  r.core.handle("host", { type: "media", media: EP(2) });
  assert.equal(r.core.media.rev, rev);
});

test("room: a dropped phone holds the room; reconnect or grace timeout releases it", () => {
  const r = room();
  r.core.join("a", {});
  r.core.join("b", {});
  r.core.handle("a", { type: "media", media: MOVIE });
  ready(r, "a");
  ready(r, "b");
  r.adv(START_LEAD_MS + 3000);
  r.core.drop("b");
  assert.ok(r.core.playback.paused);
  assert.equal(r.core.holdReason, "reconnecting");
  r.core.join("b", {});
  ready(r, "a");
  ready(r, "b");
  assert.equal(r.core.playback.paused, false, "back together after reconnect");
  r.adv(START_LEAD_MS + 1000);
  r.core.drop("b");
  ready(r, "a");
  assert.ok(r.core.playback.paused);
  r.adv(RECONNECT_GRACE_MS);
  r.core.prune();
  assert.equal(r.core.members.has("b"), false);
  ready(r, "a");
  assert.equal(r.core.playback.paused, false, "the one left carries on");
});

test("room: leave removes at once; snapshot/restore survives an eviction (held)", () => {
  const r = room();
  r.core.join("a", {});
  r.core.join("b", {});
  r.core.handle("a", { type: "media", media: MOVIE });
  ready(r, "a");
  ready(r, "b");
  r.adv(START_LEAD_MS + 2000);
  r.core.handle("b", { type: "leave" });
  assert.equal(r.core.members.size, 1);
  const snap = JSON.parse(JSON.stringify(r.core.snapshot()));
  const again = new RoomCore({ code: "ABC234", now: r.now, send: () => {} });
  again.restore(snap);
  assert.ok(again.playback.paused);
  assert.ok(Math.abs(again.playback.pos - 2) < 0.01);
  assert.equal(again.media.key, mediaKey(MOVIE));
});

// ── Engine (client decisions against a scripted adapter) ─────────────────
test("engine: schedules the start at the local instant of the room's start", () => {
  const cmds = [];
  let t = 50_000;
  const clock = new ClockSync();
  clock.add(t - 100, t - 50 + 2000, t); // server 2000 ms ahead
  const adapter = {
    read: () => ({ key: mediaKey(MOVIE), ready: true, status: "paused", pos: 0, sampledAt: t, rate: 1 }),
    pause: (p) => cmds.push(["pause", p]),
    playAt: (p, at, r) => cmds.push(["playAt", p, at, r]),
    setRate: (r) => cmds.push(["rate", r]),
  };
  const sent = [];
  const e = new SyncEngine({ adapter, clock, now: () => t, send: (m) => sent.push(m) });
  const media = { ...MOVIE, key: mediaKey(MOVIE), rev: 1 };
  e.setRoom({ media, epoch: 1, playback: { paused: true, pos: 0, at: 0, rate: 1 } });
  assert.deepEqual(cmds.at(-1), ["pause", 0]);
  assert.equal(sent.at(-1).ready, true);
  e.setRoom({ media, epoch: 1, playback: { paused: false, pos: 0, at: t + 2000 + 800, rate: 1 } });
  assert.deepEqual(cmds.at(-1), ["playAt", 0, t + 800, 1], "server start instant mapped to local time");
});

test("engine: a confirmed stall is reported as buffering; a short blip is not", () => {
  let t = 0;
  let status = "playing";
  const clock = new ClockSync();
  // on the room's timeline (started 10 s before t = 0)
  const adapter = { read: () => ({ key: "k", ready: true, status, pos: (t + 10_000) / 1000, sampledAt: t, rate: 1 }), pause() {}, playAt() {}, setRate() {} };
  const sent = [];
  const e = new SyncEngine({ adapter, clock, now: () => t, send: (m) => sent.push(m) });
  const st = { media: { key: "k", rev: 1 }, epoch: 3, playback: { paused: false, pos: 0, at: -10_000, rate: 1 } };
  e.setRoom(st);
  t = 2000;
  e.step();
  status = "waiting";
  t += 50;
  e.step();
  status = "playing";
  t += 50;
  e.step();
  assert.ok(!sent.some((m) => m.buffering), "50 ms blip ignored");
  status = "waiting";
  e.step();
  t += 200;
  e.step();
  assert.equal(sent.at(-1).buffering, true);
  assert.equal(sent.at(-1).epoch, 3);
});

// ── Mixed room: iPhone + web, simulated end to end ───────────────────────
function mixedRoom({ iosOpts = {}, webOpts = {} } = {}) {
  const vt = new VirtualTime();
  const net = new SimNet(vt);
  const ios = new SimPlayer(vt, { kind: "ios", skewMs: 850, seekMs: 90, ...iosOpts });
  const web = new SimPlayer(vt, { kind: "web", skewMs: -1730, seekMs: 160, startLatencyMs: 70, ...webOpts });
  const cIos = addDevice(vt, net, { id: "iphone", platform: "ios", player: ios, lat: { up: 45, down: 60, jitter: 15 }, loadMs: 1800 });
  const cWeb = addDevice(vt, net, { id: "browser", platform: "web", player: web, lat: { up: 15, down: 25, jitter: 8 }, loadMs: 2600 });
  const step = (_t, dt) => {
    ios.advance(dt);
    web.advance(dt);
  };
  return { vt, net, ios, web, cIos, cWeb, step, gap: () => Math.abs(ios.t - web.t) };
}

test("mixed room (iOS + web): same title, start together, drift < 100 ms, A/V locked", () => {
  const R = mixedRoom();
  R.vt.run(1000, R.step);
  assert.equal(R.net.core.connected.length, 2);
  R.cWeb.pickMedia(MOVIE); // the web member picks
  R.vt.run(6000, R.step);
  assert.equal(R.ios.key, mediaKey(MOVIE));
  assert.equal(R.web.key, mediaKey(MOVIE));
  assert.equal(R.net.core.playback.paused, false, "room playing");
  // both started from 0 and are running
  assert.ok(R.ios.t > 1 && R.web.t > 1, `ios ${R.ios.t} web ${R.web.t}`);
  let worst = 0;
  R.vt.run(60_000, (t, dt) => {
    R.step(t, dt);
    worst = Math.max(worst, R.gap());
  });
  console.log(`# mixed room: max gap over 60 s ${(worst * 1000).toFixed(1)} ms, settled ${(R.gap() * 1000).toFixed(1)} ms`);
  assert.ok(worst < 0.1, `max gap over 60 s: ${(worst * 1000).toFixed(1)} ms`);
  assert.ok(R.gap() < 0.04, `settled gap ${(R.gap() * 1000).toFixed(1)} ms`);
  assert.equal(R.ios.avMaxGap, 0, "iOS A/V offset stays 0 (rate applies to the whole item)");
  assert.equal(R.web.avMaxGap, 0, "web A/V offset stays 0");
  assert.ok(!R.ios.cmds.some((c) => c[0] === "rate" && Math.abs(c[1] - 1) > 0.05), "nudges stay within ±5%");
});

test("mixed room: a phone whose playback clock runs fast is held in sync by rate nudges only", () => {
  const R = mixedRoom({ iosOpts: { speedError: 0.004 } }); // 4 ms per second fast
  R.vt.run(1000, R.step);
  R.cIos.pickMedia(MOVIE);
  R.vt.run(8000, R.step);
  const seeksBefore = R.ios.cmds.filter((c) => c[0] === "playAt").length;
  let worst = 0;
  R.vt.run(120_000, (t, dt) => {
    R.step(t, dt);
    worst = Math.max(worst, R.gap());
  });
  console.log(`# fast clock: max gap over 120 s ${(worst * 1000).toFixed(1)} ms`);
  assert.ok(worst < 0.1, `max gap ${(worst * 1000).toFixed(1)} ms`);
  assert.equal(R.ios.cmds.filter((c) => c[0] === "playAt").length, seeksBefore, "no hard seeks needed");
  assert.ok(R.ios.cmds.some((c) => c[0] === "rate" && c[1] < 1), "slowed down a little");
});

test("mixed room: web stalls -> both pause on the same frame, wait, resume together from it", () => {
  const R = mixedRoom();
  R.vt.run(1000, R.step);
  R.cIos.pickMedia(MOVIE);
  R.vt.run(25_000, R.step);
  assert.equal(R.net.core.playback.paused, false);
  // web's network dies for 4 s right at the edge of its buffer
  R.web.bufEnd = R.web.t + 0.3;
  R.web.stallNet = true;
  R.vt.run(4000, R.step);
  assert.ok(R.net.core.playback.paused, "room held");
  assert.equal(R.net.core.holdReason, "buffering");
  const holdPos = R.net.core.playback.pos;
  assert.equal(R.ios.status, "paused");
  assert.ok(Math.abs(R.ios.t - holdPos) < 0.001, `iPhone on the stalled frame (${R.ios.t} vs ${holdPos})`);
  assert.ok(Math.abs(R.web.t - holdPos) < 0.001, "web on the same frame");
  assert.ok(holdPos > 20, "no restart from the beginning");
  // nobody moves while held
  const iosT = R.ios.t;
  R.vt.run(1000, R.step);
  assert.equal(R.ios.t, iosT, "iPhone did not play ahead");
  R.web.stallNet = false;
  let resumedGap = 0;
  let minT = Infinity;
  R.vt.run(6000, (t, dt) => {
    R.step(t, dt);
    minT = Math.min(minT, R.ios.t, R.web.t);
    if (!R.net.core.playback.paused) resumedGap = Math.max(resumedGap, R.gap());
  });
  assert.equal(R.net.core.playback.paused, false, "resumed");
  assert.ok(minT >= holdPos - 0.001, "resumed from the hold point, no jump back");
  assert.ok(R.ios.t > holdPos + 2 && R.web.t > holdPos + 2);
  console.log(`# stall: held at ${holdPos.toFixed(3)} s, gap after resume ${(resumedGap * 1000).toFixed(1)} ms`);
  assert.ok(resumedGap < 0.1, `gap after resume ${(resumedGap * 1000).toFixed(1)} ms`);
});

test("mixed room: pause and seek from either device, both follow", () => {
  const R = mixedRoom();
  R.vt.run(1000, R.step);
  R.cWeb.pickMedia(MOVIE);
  R.vt.run(10_000, R.step);
  R.ios.tap("pause");
  R.vt.run(1500, R.step);
  assert.equal(R.ios.status, "paused");
  assert.equal(R.web.status, "paused");
  assert.ok(R.gap() < 0.001, "same frame");
  R.web.tap("seek", { pos: 1200 });
  R.web.tap("play");
  R.vt.run(5000, R.step);
  assert.equal(R.net.core.playback.paused, false);
  assert.ok(R.ios.t > 1200 && R.web.t > 1200);
  assert.ok(R.gap() < 0.1);
});

test("mixed room: the guest picks the next episode, everyone switches and starts together", () => {
  const R = mixedRoom();
  R.vt.run(1000, R.step);
  R.cIos.pickMedia(EP(1));
  R.vt.run(8000, R.step);
  R.cWeb.pickMedia(EP(2));
  R.vt.run(8000, R.step);
  assert.equal(R.ios.key, mediaKey(EP(2)));
  assert.equal(R.web.key, mediaKey(EP(2)));
  assert.ok(R.ios.t > 1 && R.ios.t < 8, `started ep 2 from the top (${R.ios.t})`);
  assert.ok(R.gap() < 0.1);
});

test("mixed room: a dropped connection holds both; reconnect resumes in sync", () => {
  const R = mixedRoom();
  R.vt.run(1000, R.step);
  R.cIos.pickMedia(MOVIE);
  R.vt.run(10_000, R.step);
  R.net.links.get("browser").drop();
  R.vt.run(200, R.step);
  assert.ok(R.net.core.playback.paused);
  R.vt.run(8000, R.step); // client reconnects with backoff
  assert.equal(R.net.core.connected.length, 2);
  assert.equal(R.net.core.playback.paused, false);
  R.vt.run(3000, R.step);
  assert.ok(R.gap() < 0.1, `gap ${(R.gap() * 1000).toFixed(1)} ms`);
});

// ── Worker + Durable Object glue (fake runtime) ──────────────────────────
class FakeSocket {
  constructor() {
    this.listeners = {};
    this.sent = [];
    this.closed = null;
  }
  accept() {}
  addEventListener(t, fn) {
    (this.listeners[t] ||= []).push(fn);
  }
  send(d) {
    this.sent.push(JSON.parse(d));
  }
  close(code, reason) {
    if (this.closed) return;
    this.closed = { code, reason };
  }
  emit(t, e) {
    for (const fn of this.listeners[t] || []) fn(e);
  }
}

test("worker: create a room, join from two platforms, relay, expire when empty", async () => {
  const { handle, Room } = await import("./worker.js");
  const pairs = [];
  globalThis.WebSocketPair = class {
    constructor() {
      const c = new FakeSocket();
      const s = new FakeSocket();
      pairs.push(s);
      return { 0: c, 1: s };
    }
  };
  const OrigResponse = globalThis.Response;
  globalThis.Response = class extends OrigResponse {
    constructor(body, init = {}) {
      super(body, init.status === 101 ? { ...init, status: 200 } : init);
      if (init.status === 101) Object.defineProperty(this, "status", { value: 101 });
      this.webSocket = init.webSocket;
    }
  };
  let t = 5_000_000;
  const timers = { setTimeout: () => 0 };
  const objects = new Map();
  const env = {
    ROOMS: {
      idFromName: (n) => n,
      get: (id) => {
        if (!objects.has(id)) {
          const store = new Map();
          const storage = {
            alarm: null,
            get: async (k) => store.get(k),
            put: async (k, v) => store.set(k, structuredClone(v)),
            setAlarm: async (a) => (storage.alarm = a),
            deleteAll: async () => store.clear(),
          };
          objects.set(id, { obj: new Room({ storage }, env, { now: () => t, timers }), storage, store });
        }
        const o = objects.get(id).obj;
        return { fetch: (req, init) => o.fetch(typeof req === "string" ? new Request(req, init) : req) };
      },
    },
  };
  try {
    const created = await handle(new Request("https://w/rooms", { method: "POST" }), env);
    const { code } = await created.json();
    assert.ok(isValidCode(code));
    const info = await (await handle(new Request(`https://w/rooms/${code.toLowerCase()}`), env)).json();
    assert.deepEqual(info, { exists: true, members: 0 });
    const join = (id, platform) =>
      handle(new Request(`https://w/rooms/${code}/ws?id=${id}&platform=${platform}`, { headers: { upgrade: "websocket" } }), env);
    const r1 = await join("iphone", "ios");
    assert.equal(r1.status, 101);
    const sIos = pairs.at(-1);
    await join("browser", "web");
    const sWeb = pairs.at(-1);
    const last = (s) => s.sent.filter((m) => m.type === "state").at(-1);
    assert.deepEqual(last(sIos).members.map((m) => m.platform).sort(), ["ios", "web"]);
    // ping/pong clock
    sWeb.emit("message", { data: JSON.stringify({ type: "ping", t0: 1 }) });
    assert.deepEqual(sWeb.sent.at(-1), { type: "pong", t0: 1, ts: t });
    // the web member picks, both see it
    sWeb.emit("message", { data: JSON.stringify({ type: "media", media: MOVIE }) });
    assert.equal(last(sIos).media.key, mediaKey(MOVIE));
    // unknown code
    const bad = await handle(new Request(`https://w/rooms/ZZZ999/ws?id=x`, { headers: { upgrade: "websocket" } }), env);
    assert.equal(bad.status, 101);
    assert.equal(pairs.at(-1).closed.code, 4404);
    // reconnect replaces the old socket
    await join("browser", "web");
    assert.equal(sWeb.closed.code, 4000);
    // everyone leaves -> alarm -> storage wiped
    for (const s of pairs.slice(-1).concat([sIos])) s.emit("message", { data: JSON.stringify({ type: "leave" }) });
    const o = objects.get(code);
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(o.storage.alarm > t, "expiry alarm set");
    await o.obj.alarm();
    assert.equal(o.store.size, 0, "room deleted");
  } finally {
    globalThis.Response = OrigResponse;
    delete globalThis.WebSocketPair;
  }
});
