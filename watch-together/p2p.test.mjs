// Watch Party with no room server: the host device runs RoomCore and guests
// connect over (here: an in-memory stand-in for) PeerJS data channels.
// Real WatchClients on both sides, real timers. The real-broker check lives
// in scripts/p2p-e2e (browser) since node has no WebRTC.
import test from "node:test";
import assert from "node:assert/strict";
import { WatchClient } from "../src/watch/client.js";
import { P2PHost, guestSocketClass, setPeerImpl, peerIdFor, P2P_URL, NO_PARTY_MESSAGE, HOST_GONE_MS } from "../src/watch/p2p.js";
import { MAX_MEMBERS } from "../src/watch/protocol.js";

// ── In-memory PeerJS ──────────────────────────────────────────────────────
class Emitter {
  constructor() {
    this.h = {};
  }
  on(ev, fn) {
    (this.h[ev] ||= []).push(fn);
    return this;
  }
  emit(ev, ...a) {
    for (const fn of this.h[ev] || []) fn(...a);
  }
}
const broker = new Map();
let anon = 0;
const later = (fn) => setTimeout(fn, 2);
class FakeConn extends Emitter {
  constructor(peer) {
    super();
    this.peer = peer;
    this.open = false;
  }
  send(s) {
    assert.equal(typeof s, "string");
    if (!this.open) return;
    const o = this.other;
    later(() => o.open && o.emit("data", s));
  }
  close() {
    if (!this.open) return;
    this.open = false;
    const o = this.other;
    later(() => {
      this.emit("close");
      if (o.open) {
        o.open = false;
        o.emit("close");
      }
    });
  }
}
class FakePeer extends Emitter {
  constructor(id) {
    super();
    if (typeof id !== "string") id = `anon-${++anon}`;
    this.id = id;
    this.conns = [];
    later(() => {
      if (broker.has(id)) return this.emit("error", { type: "unavailable-id", message: "taken" });
      broker.set(id, this);
      this.emit("open", id);
    });
  }
  connect(id) {
    const a = new FakeConn(this);
    later(() => {
      const host = broker.get(id);
      if (!host || host.destroyed) return this.emit("error", { type: "peer-unavailable", message: "no peer" });
      const b = new FakeConn(host);
      a.other = b;
      b.other = a;
      a.open = b.open = true;
      this.conns.push(a);
      host.conns.push(b);
      host.emit("connection", b);
      later(() => {
        b.emit("open");
        a.emit("open");
      });
    });
    return a;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (broker.get(this.id) === this) broker.delete(this.id);
    for (const c of this.conns) c.close();
  }
}
setPeerImpl(FakePeer);

// ── Devices ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

function device(id, WebSocketImpl, url) {
  const player = {
    key: null,
    pos: 0,
    cmds: [],
    read() {
      return { key: this.key, ready: !!this.key, seeking: false, status: "paused", pos: this.pos, sampledAt: Date.now(), rate: 1 };
    },
    pause(p) {
      this.cmds.push(["pause", p]);
      this.pos = p;
    },
    playAt(p, at, r) {
      this.cmds.push(["playAt", p, at, r]);
      this.pos = p;
    },
    setRate() {},
  };
  const d = { player, statuses: [], chats: [] };
  d.client = new WatchClient({
    url,
    clientId: id,
    platform: id.startsWith("ios") ? "ios" : id.startsWith("and") ? "android" : "web",
    name: id,
    adapter: player,
    WebSocketImpl,
    onState: (st) => {
      if (st.media?.key) player.key = st.media.key;
    },
    onStatus: (s, info) => d.statuses.push([s, info?.message]),
    onChat: (all) => (d.chats = all),
  });
  d.client.connect();
  return d;
}
const MOVIE = { type: "movie", tmdbId: 603, title: "The Matrix" };

test("create + join by code: same title, pause/seek from either side reach the other, chat", async () => {
  const host = await P2PHost.create();
  assert.match(host.code, /^[A-Z2-9]{6}$/);
  assert.ok(broker.has(peerIdFor(host.code)), "code registered with the broker as superplayer-CODE");
  const A = device("ios-host", host.socketClass(), P2P_URL(host.code));
  await until(() => A.client.connected && A.client.state, 2000, "host connected");
  assert.equal(A.client.isHost, true);
  A.client.pickMedia(MOVIE);
  const B = device("web-guest", guestSocketClass(host.code), P2P_URL(host.code));
  const C = device("android-guest", guestSocketClass(host.code), P2P_URL(host.code));
  await until(() => B.client.state?.media?.tmdbId === 603 && C.client.state?.media?.tmdbId === 603, 3000, "guests get the host's title");
  assert.equal(B.client.state.count, 3);
  assert.deepEqual(B.client.state.members.map((m) => m.platform).sort(), ["android", "ios", "web"]);
  assert.equal(B.client.isHost, false);
  // Everyone has it loaded + buffered -> the room starts together.
  await until(() => [A, B, C].every((d) => d.client.state?.playback && !d.client.state.playback.paused), 4000, "start together");
  // Guest pauses -> everyone paused.
  B.client.intent({ action: "pause", pos: B.client.engine.target() });
  await until(() => [A, C].every((d) => d.client.state.intent === "pause" && d.client.state.playback.paused), 2000, "guest pause reaches host");
  // Host seeks -> guests see the new position.
  A.client.intent({ action: "seek", pos: 600 });
  await until(() => [B, C].every((d) => Math.abs(d.client.state.playback.pos - 600) < 0.01), 2000, "host seek reaches guests");
  await until(() => B.player.cmds.some(([c, p]) => c === "pause" && Math.abs(p - 600) < 0.01), 2000, "guest player moved to 600");
  // Guest plays again -> host's room plays.
  C.client.intent({ action: "play", pos: 600 });
  await until(() => A.client.state.intent === "play" && !A.client.state.playback.paused, 4000, "guest play reaches host");
  // Guest seek while playing.
  B.client.intent({ action: "seek", pos: 1200 });
  await until(() => Math.abs(A.client.state.playback.pos - 1200) < 0.01, 2000, "guest seek reaches host");
  // Chat both ways; chat never pauses.
  const before = A.client.state.epoch;
  B.client.sendChat("hi from web");
  A.client.sendChat("hi from iphone");
  await until(() => [A, B, C].every((d) => d.chats.length === 2), 2000, "chat");
  assert.equal(A.client.state.epoch, before, "chat did not hold the room");
  // Host ends -> guests told.
  A.client.endParty();
  await until(() => [B, C].every((d) => d.statuses.some(([s]) => s === "ended")), 2000, "guests see the end");
  await until(() => !broker.has(peerIdFor(host.code)), 2000, "host peer released");
  for (const d of [A, B, C]) d.client.close();
});

test("wrong / expired code -> 'No party with that code' (no hang)", async () => {
  const B = device("web-x", guestSocketClass("ZZZZZZ"), P2P_URL("ZZZZZZ"));
  await until(() => B.statuses.length, 2000, "a status");
  assert.deepEqual(B.statuses[0], ["no-room", NO_PARTY_MESSAGE]);
});

test("host leaving (Leave / closing the app) ends the party for guests", async () => {
  const host = await P2PHost.create();
  const A = device("ios-h2", host.socketClass(), P2P_URL(host.code));
  const B = device("web-g2", guestSocketClass(host.code), P2P_URL(host.code));
  await until(() => B.client.state?.count === 2, 2000, "joined");
  host.endParty(); // what the UI does on host Leave / pagehide
  await until(() => B.statuses.some(([s]) => s === "ended"), 2000, "guest ended");
  A.client.close();
});

test("guest reconnects into the same seat; host unreachable too long -> party ended", async () => {
  const host = await P2PHost.create();
  const A = device("ios-h3", host.socketClass(), P2P_URL(host.code));
  let skew = 0;
  const B = device("web-g3", guestSocketClass(host.code, { now: () => Date.now() + skew }), P2P_URL(host.code));
  await until(() => B.client.state?.count === 2, 2000, "joined");
  // Drop the guest's channel (network blip): it reconnects, same seat.
  const conn = broker.get(peerIdFor(host.code)).conns.at(-1);
  conn.close();
  await until(() => B.statuses.some(([s]) => s === "reconnecting"), 2000, "reconnecting");
  await until(() => B.client.connected && B.client.state?.members.find((m) => m.id === "web-g3")?.connected, 4000, "back in");
  assert.equal(B.client.state.count, 2, "same seat, no duplicate");
  // Host vanishes without saying goodbye (app killed).
  host.peer.destroy();
  clearInterval(host.sweep);
  host.destroyed = true;
  await until(() => B.statuses.filter(([s]) => s === "reconnecting").length >= 2, 4000, "retrying");
  skew = HOST_GONE_MS + 1000;
  await until(() => B.statuses.some(([s]) => s === "ended"), 15000, "host gone -> ended");
  A.client.close();
  B.client.close();
});

test("party of 9; the 10th gets 'Party is full (9/9)'", async () => {
  const host = await P2PHost.create();
  const devs = [device("h4", host.socketClass(), P2P_URL(host.code))];
  for (let i = 1; i < MAX_MEMBERS; i++) devs.push(device(`g4-${i}`, guestSocketClass(host.code), P2P_URL(host.code)));
  await until(() => devs[0].client.state?.count === MAX_MEMBERS, 4000, "9 in");
  const extra = device("g4-x", guestSocketClass(host.code), P2P_URL(host.code));
  await until(() => extra.statuses.length, 3000, "refused");
  assert.equal(extra.statuses[0][0], "room-full");
  host.endParty();
  for (const d of devs) d.client.close();
});
