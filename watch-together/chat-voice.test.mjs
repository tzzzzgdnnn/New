// Watch Together: profile names + pictures, chat across iPhone / Android /
// web (including the Android native player's chat bridge), and voice chat
// (listen-only by default, mic opt-in, late joiners, reconnects) with a fake
// WebRTC stack. Runs the real room (RoomCore), client, adapters and VoiceMesh.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomCore, cleanAvatar, cleanName, AVATAR_DATA_MAX, RATE_BURST } from "../src/watch/roomCore.js";
import { WatchClient } from "../src/watch/client.js";
import { VoiceMesh, ICE_SERVERS, tuneOpus, MIC_CONSTRAINTS, DUCK_VOLUME } from "../src/watch/voice.js";
import { chatView } from "../src/watch/chat.js";
import { createAndroidAdapter } from "../src/watch/adapters/android.js";
import { VirtualTime, SimPlayer, SimNet } from "./sim.mjs";

const flush = () => new Promise((r) => setImmediate(r));
/** Advance virtual time and let the async WebRTC handshakes run in between. */
async function settle(vt, ms = 3000, step = 100) {
  for (let t = 0; t < ms; t += step) {
    vt.run(step);
    await flush();
    await flush();
  }
}

// ── Fake WebRTC: pairs offer/answer by pc id; "hearing" = the other side's sender has a live, enabled mic track ──
let pcs = new Map();
let pcSeq = 0;
class FakeTrack {
  constructor(label) {
    Object.assign(this, { kind: "audio", label, enabled: true, readyState: "live" });
  }
  stop() {
    this.readyState = "ended";
  }
}
class FakeStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}
class FakePC {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = ++pcSeq;
    pcs.set(this.id, this);
    Object.assign(this, { tx: [], signalingState: "stable", connectionState: "new", localDescription: null, remoteDescription: null, ice: [], gotTrack: false });
  }
  mkT(direction) {
    const t = { direction, receiver: { track: { kind: "audio" } }, sender: { track: null, replaceTrack: async (tr) => void (t.sender.track = tr) } };
    this.tx.push(t);
    return t;
  }
  addTransceiver(_kind, { direction }) {
    return this.mkT(direction);
  }
  getTransceivers() {
    return this.tx;
  }
  async createOffer() {
    return { type: "offer", sdp: `pc:${this.id}` };
  }
  async createAnswer() {
    return { type: "answer", sdp: `pc:${this.id}` };
  }
  async setLocalDescription(d) {
    this.localDescription = d;
    this.signalingState = d.type === "offer" ? "have-local-offer" : "stable";
    for (let i = 0; i < 8; i++) this.onicecandidate?.({ candidate: { candidate: `cand-${this.id}-${i}` } });
    if (d.type === "answer") this.connect();
  }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
    this.other = Number(String(d.sdp).split(":")[1]);
    if (d.type === "offer") {
      this.signalingState = "have-remote-offer";
      if (!this.tx.length) this.mkT("recvonly");
    } else {
      this.signalingState = "stable";
      this.connect();
    }
  }
  async addIceCandidate(c) {
    this.ice.push(c);
  }
  connect() {
    this.connectionState = "connected";
    this.ontrack?.({ track: { kind: "audio" }, streams: [new FakeStream()] });
    this.gotTrack = true;
  }
  close() {
    this.connectionState = "closed";
  }
}
const sendingTrack = (pc) => pc.tx.find((t) => t.direction === "sendrecv" && t.sender.track?.readyState === "live" && t.sender.track.enabled)?.sender.track;

const fakeDoc = () => ({
  body: { appendChild() {} },
  createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, play: async () => {}, remove() {} }),
  addEventListener() {},
  removeEventListener() {},
});

/** One device: real WatchClient + VoiceMesh over the simulated room. */
function device(vt, net, id, platform, name, avatar) {
  const p = new SimPlayer(vt, { kind: platform === "web" ? "web" : "ios" });
  const d = { id, chats: [], state: null };
  const client = new WatchClient({
    url: "wss://sim/rooms/ABC234/ws",
    clientId: id,
    platform,
    name,
    avatar,
    adapter: p,
    WebSocketImpl: net.socketClass({ up: 30, down: 30, jitter: 5 }),
    now: p.localNow,
    timers: vt,
    onState: (st) => {
      d.state = st;
      d.mesh.sync(st);
    },
    onStatus: (s) => s === "connected" && d.mesh?.reconnected(),
    onChat: (list) => (d.chats = list),
    onRtc: (m) => d.mesh.onSignal(m),
    onVoice: (m) => d.mesh.onVoice(m),
  });
  d.client = client;
  d.mesh = new VoiceMesh({
    client,
    RTCPeerConnectionImpl: FakePC,
    MediaStreamImpl: FakeStream,
    doc: fakeDoc(),
    getUserMedia: async () => new FakeStream([new FakeTrack(`mic-${id}`)]),
  });
  client.connect();
  return d;
}

/** Does `listener` hear `speaker`? Their link is up and the speaker's side sends a live mic. */
function hears(listener, speaker) {
  const mine = listener.mesh.peers.get(speaker.id)?.pc;
  const theirs = speaker.mesh.peers.get(listener.id)?.pc;
  if (!mine || !theirs || mine.connectionState !== "connected" || theirs.connectionState !== "connected") return false;
  if (mine.other !== theirs.id && theirs.other !== mine.id) return false;
  return mine.gotTrack && !!sendingTrack(theirs);
}

const THUMB = "data:image/jpeg;base64," + "A".repeat(200);

test("avatars + names: only drawable pictures and one-line names reach the room", () => {
  assert.equal(cleanAvatar("sp:ocean"), "sp:ocean");
  assert.equal(cleanAvatar("/kqjL17yufvn9OVLyXYpvtyrFfak.jpg"), "/kqjL17yufvn9OVLyXYpvtyrFfak.jpg");
  assert.equal(cleanAvatar("https://static.tvmaze.com/uploads/images/medium_portrait/1/1.jpg"), "https://static.tvmaze.com/uploads/images/medium_portrait/1/1.jpg");
  assert.equal(cleanAvatar(THUMB), THUMB);
  for (const bad of [
    "https://evil.example/track.png",
    "http://static.tvmaze.com/x.jpg",
    "https://user:pw@static.tvmaze.com/x.jpg",
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/jpeg;base64," + "A".repeat(AVATAR_DATA_MAX),
    "sp:<b>",
    "/../../etc/passwd",
    42,
    null,
  ])
    assert.equal(cleanAvatar(bad), null, String(bad).slice(0, 40));
  assert.equal(cleanName("  Montez\n\u0007 J  "), "Montez J");
  assert.equal(cleanName("x".repeat(40)).length, 24);
});

test("profile: name + picture sent on connect, updated live; chat lines carry the sender's picture", async () => {
  const vt = new VirtualTime();
  const net = new SimNet(vt);
  const a = device(vt, net, "a1", "ios", "Montez", "sp:ember");
  const b = device(vt, net, "b2", "android", "Amy", THUMB);
  await settle(vt, 1500);
  const members = b.state.members;
  assert.deepEqual(
    members.map((m) => [m.name, m.avatar]),
    [
      ["Montez", "sp:ember"],
      ["Amy", THUMB],
    ],
  );
  a.client.sendChat("hi <b>all</b>");
  await settle(vt, 300);
  b.client.sendChat("hey");
  await settle(vt, 800);
  const viewA = chatView(a.chats, a.state.members, "a1", () => "sp:graphite");
  assert.deepEqual(
    viewA.map((m) => [m.name, m.text, m.avatar, m.mine]),
    [
      ["Montez", "hi <b>all</b>", "sp:ember", true],
      ["Amy", "hey", THUMB, false],
    ],
  );
  assert.equal(viewA[0].rawText, "hi &lt;b&gt;all&lt;/b&gt;", "native players get the escaped text");
  assert.equal(a.chats[1].avatar, null, "a data: thumbnail is not copied into chat history");
  // Rename / new picture mid-party.
  a.client.setProfile("Tez", "/abc123.jpg");
  b.client.sendMsg({ type: "profile", name: "Amy", avatar: "https://evil.example/x.png" });
  await settle(vt, 800);
  const m = Object.fromEntries(b.state.members.map((x) => [x.id, x]));
  assert.equal(m.a1.name, "Tez");
  assert.equal(m.a1.avatar, "/abc123.jpg");
  assert.equal(m.b2.avatar, THUMB, "a bad picture never replaces a good one");
});

test("chat reaches every device mix: iPhone app, Android native player (bridge) and web", async () => {
  const vt = new VirtualTime();
  const net = new SimNet(vt);
  const ios = device(vt, net, "i1", "ios", "iPhone", "sp:ocean");
  const web = device(vt, net, "w3", "web", "Web", "sp:gold");
  // Android: the real adapter with a fake SbPlayer plugin (what PlayerActivity's chat column gets / sends).
  const sent = [];
  const listeners = {};
  const plugin = { watch: (m) => (sent.push(m), Promise.resolve()), addListener: (ev, fn) => ((listeners[ev] = fn), { remove() {} }) };
  const adapter = createAndroidAdapter({ plugin, getKey: () => null, now: vt.now });
  const andr = { id: "a2", chats: [] };
  const client = new WatchClient({
    url: "wss://sim/rooms/ABC234/ws",
    clientId: "a2",
    platform: "android",
    name: "Android",
    avatar: "sp:violet",
    adapter,
    WebSocketImpl: net.socketClass({ up: 30, down: 30, jitter: 5 }),
    now: vt.now,
    timers: vt,
    onState: (st) => (andr.state = st),
    onChat: (list) => {
      andr.chats = list;
      const view = chatView(list, andr.state?.members, "a2");
      adapter.setChat(view.map((m) => ({ id: m.id, name: m.rawName, text: m.rawText, ts: m.ts, mine: m.mine, avatarUrl: "", avatarFrom: "#bf5af2", avatarTo: "#3a0a6b", initial: m.name[0] })));
    },
  });
  adapter.onChatSend = (t) => client.sendChat(t);
  adapter.begin();
  client.connect();
  await settle(vt, 1500);

  ios.client.sendChat("from iPhone");
  await settle(vt, 300);
  listeners.watchChatSend({ text: "from Android player" }); // typed in PlayerActivity's chat column
  await settle(vt, 300);
  web.client.sendChat("from web");
  await settle(vt, 800);

  const texts = (list) => list.map((c) => c.text);
  const all = ["from iPhone", "from Android player", "from web"];
  assert.deepEqual(texts(ios.chats), all);
  assert.deepEqual(texts(web.chats), all);
  assert.deepEqual(texts(andr.chats), all);
  const native = sent.filter((m) => m.cmd === "chat").at(-1).messages;
  assert.deepEqual(native.map((m) => [m.name, m.text, m.mine]), [
    ["iPhone", "from iPhone", false],
    ["Android", "from Android player", true],
    ["Web", "from web", false],
  ]);
  assert.ok(native.every((m) => m.avatarFrom && m.initial), "native rows get a picture");
});

test("voice signalling has its own rate bucket: an ICE burst is relayed whole and Pause still works", () => {
  let t = 0;
  const got = [];
  const core = new RoomCore({ code: "ABC234", now: () => t, send: (id, m) => got.push([id, m]) });
  core.join("a");
  core.join("b");
  for (let i = 0; i < 120; i++) core.handle("a", { type: "rtc", to: "b", data: { ice: { candidate: `c${i}` } } });
  assert.equal(got.filter(([id, m]) => id === "b" && m.type === "rtc").length, 120);
  for (let i = 0; i < RATE_BURST - 1; i++) core.handle("a", { type: "rate", rate: 1 });
  core.handle("a", { type: "pause", pos: 5 });
  assert.equal(core.intent, "pause");
  assert.equal(core.view().members.find((m) => m.id === "a").mic, false);
  core.handle("a", { type: "voice", mic: true });
  assert.equal(core.view().members.find((m) => m.id === "a").mic, true, "mic flag in the room state");
  core.drop("a");
  assert.equal(core.view().members.find((m) => m.id === "a").mic, false, "a dropped device is never shown talking");
});

test("voice: listeners hear a speaker without a mic of their own; late joiners and reconnects hear too", async () => {
  pcs = new Map();
  const vt = new VirtualTime();
  const net = new SimNet(vt);
  const ios = device(vt, net, "a-ios", "ios", "iPhone");
  const andr = device(vt, net, "b-android", "android", "Android");
  const web = device(vt, net, "c-web", "web", "Web");
  await settle(vt, 1500);
  assert.equal(ios.mesh.peers.size + andr.mesh.peers.size + web.mesh.peers.size, 0, "no connections until someone turns a mic on");
  assert.deepEqual(ios.mesh.iceServers, ICE_SERVERS);
  assert.ok(ICE_SERVERS.some((s) => [].concat(s.urls).some((u) => u.startsWith("turn:"))), "a TURN relay is configured");

  // The web member (highest id: it is the answerer everywhere) talks first.
  await web.mesh.start();
  await settle(vt, 3000);
  assert.ok(hears(ios, web), "iPhone hears web");
  assert.ok(hears(andr, web), "Android hears web");
  assert.ok(!hears(web, ios), "iPhone's mic is off");

  // Android turns its mic on: same connections, no renegotiation needed for web, a new one to iPhone.
  await andr.mesh.start();
  await settle(vt, 3000);
  assert.ok(hears(ios, andr) && hears(web, andr), "everyone hears Android");
  assert.ok(hears(ios, web) && hears(andr, web), "still hear web");

  // Mute: tracks disabled, links stay.
  web.mesh.setMuted(true);
  await settle(vt, 500);
  assert.ok(!hears(ios, web) && !hears(andr, web), "muted");
  web.mesh.setMuted(false);
  await settle(vt, 1500);
  assert.ok(hears(ios, web), "unmuted");

  // Late joiner.
  const late = device(vt, net, "d-late", "web", "Late");
  await settle(vt, 3000);
  assert.ok(hears(late, web) && hears(late, andr), "late joiner hears both speakers");

  // iPhone drops and reconnects (lowest id: it offers): links rebuilt, still hears.
  net.links.get("a-ios").drop();
  await settle(vt, 2500);
  assert.ok(hears(ios, web) && hears(ios, andr), "reconnected iPhone hears again");

  // Android drops and reconnects with its mic on: the room is told again, everyone hears it.
  net.links.get("b-android").drop();
  await settle(vt, 4000);
  assert.ok(andr.state.members.find((m) => m.id === "b-android").mic, "mic flag restored after reconnect");
  assert.ok(hears(ios, andr) && hears(web, andr) && hears(late, andr), "everyone hears Android after its reconnect");

  for (const d of [ios, andr, web, late]) d.mesh.stop();
  assert.ok([...pcs.values()].every((pc) => pc.connectionState === "closed" || ![...[ios, andr, web, late]].some((d) => [...d.mesh.peers.values()].some((p) => p.pc === pc))));
});

test("voice quality: Opus 64 kbps mono, FEC on, DTX off; mic asks for 48 kHz mono with echo cancellation", () => {
  const sdp = ["v=0", "m=audio 9 UDP/TLS/RTP/SAVPF 111 0", "a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=0;usedtx=1", "a=rtpmap:0 PCMU/8000", ""].join("\r\n");
  const out = tuneOpus(sdp);
  const fmtp = out.split("\r\n").find((l) => l.startsWith("a=fmtp:111 "));
  for (const kv of ["minptime=10", "maxaveragebitrate=64000", "stereo=0", "sprop-stereo=0", "useinbandfec=1", "usedtx=0", "maxplaybackrate=48000"]) assert.ok(fmtp.includes(kv), kv);
  assert.ok(!fmtp.includes("usedtx=1") && !fmtp.includes("useinbandfec=0"));
  const bare = tuneOpus(["m=audio 9 UDP/TLS/RTP/SAVPF 109", "a=rtpmap:109 opus/48000/2", ""].join("\r\n"));
  assert.match(bare, /a=rtpmap:109 opus\/48000\/2\r\na=fmtp:109 maxaveragebitrate=64000;/);
  assert.equal(tuneOpus("v=0\r\n"), "v=0\r\n", "no Opus, untouched");
  const a = MIC_CONSTRAINTS.audio;
  assert.deepEqual([a.echoCancellation, a.noiseSuppression, a.autoGainControl, a.sampleRate, a.channelCount], [true, true, true, 48000, 1]);
});

test("ducking: the movie drops while someone else talks and comes back when they stop (never for my own voice)", () => {
  const ducks = [];
  const mesh = new VoiceMesh({ client: { clientId: "me", sendMsg() {} }, RTCPeerConnectionImpl: FakePC, doc: fakeDoc(), onDuck: (l) => ducks.push(l) });
  mesh.onVoice({ id: "me", speaking: true });
  assert.deepEqual(ducks, [], "own voice");
  mesh.onVoice({ id: "amy", speaking: true });
  mesh.onVoice({ id: "tez", speaking: true });
  mesh.onVoice({ id: "amy", speaking: false });
  assert.deepEqual(ducks, [DUCK_VOLUME], "ducked once while anyone talks");
  mesh.onVoice({ id: "tez", speaking: false });
  assert.deepEqual(ducks, [DUCK_VOLUME, 1], "back to full");
  assert.ok(DUCK_VOLUME >= 0.3 && DUCK_VOLUME <= 0.4);
});

// ── ani.pm relay (web app anime) and relayed voice frames ───────────────
import { handle as workerHandle } from "./worker.js";
import { muEncode, muDecode } from "../src/watch/voiceRelay.js";

test("worker /anipm relays ani.pm API GETs with CORS, refuses other hosts", async () => {
  const seen = [];
  const fake = async (u, init) => {
    seen.push([u, init.headers.Referer]);
    return new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } });
  };
  const ok = await workerHandle(new Request("https://w.dev/anipm?u=" + encodeURIComponent("https://api.ani.pm/x?a=1") + "&r=" + encodeURIComponent("https://ani.pm/w")), {}, fake);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), "*");
  assert.equal(await ok.text(), '{"ok":1}');
  assert.deepEqual(seen[0], ["https://api.ani.pm/x?a=1", "https://ani.pm/w"]);
  const bad = await workerHandle(new Request("https://w.dev/anipm?u=" + encodeURIComponent("https://evil.example/x")), {}, fake);
  assert.equal(bad.status, 403);
  assert.equal(seen.length, 1);
});

test("voice relay: mu-law round trip keeps speech-level samples close", () => {
  const f = new Float32Array(160).map((_, i) => 0.5 * Math.sin(i / 5));
  const back = muDecode(muEncode(f));
  for (let i = 0; i < f.length; i++) assert.ok(Math.abs(back[i] - f[i]) < 0.02, `sample ${i}: ${f[i]} -> ${back[i]}`);
});

test("room: relayed voice frames go to everyone else, only from a member with the mic on", () => {
  const sent = [];
  const core = new RoomCore({ code: "ABC234", now: () => 1000, send: (to, m) => sent.push([to, typeof m === "string" ? JSON.parse(m) : m]) });
  core.join("a", {});
  core.join("b", {});
  core.join("c", {});
  sent.length = 0;
  core.handle("a", { type: "vaud", c: "o", s: 1, d: "AAAA" });
  assert.equal(sent.filter(([, m]) => m.type === "vaud").length, 0, "mic off: dropped");
  core.handle("a", { type: "voice", mic: true, speaking: false });
  sent.length = 0;
  core.handle("a", { type: "vaud", c: "o", s: 2, d: "AAAA" });
  const out = sent.filter(([, m]) => m.type === "vaud");
  assert.deepEqual(out.map(([to]) => to).sort(), ["b", "c"]);
  assert.equal(out[0][1].from, "a");
});
