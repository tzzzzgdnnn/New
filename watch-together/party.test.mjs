// Watch Together: party behaviour (9-seat cap, host handoff, end, chat,
// late join, drops, loss/jitter, conflicting commands, 9-client room).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomCore, escapeHtml, CHAT_MAX_LEN } from "../src/watch/roomCore.js";
import { MAX_MEMBERS, START_LEAD_MS } from "../src/watch/protocol.js";
import { VirtualTime, SimPlayer, SimNet, addDevice } from "./sim.mjs";

const MOVIE = { type: "movie", tmdbId: 603, title: "The Matrix", server: "cinejoy", audioLang: "en", subLang: "en" };

function party(n, { lat = { up: 40, down: 40, jitter: 20 } } = {}) {
  const vt = new VirtualTime();
  const net = new SimNet(vt);
  const devs = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 2 ? "web" : "ios";
    const p = new SimPlayer(vt, { kind, skewMs: (i * 397) % 2000 - 1000, seekMs: 80 + i * 10, startLatencyMs: kind === "web" ? 60 : 0 });
    const chats = [];
    const statuses = [];
    const c = addDevice(vt, net, { id: `d${i}`, platform: kind, player: p, lat, loadMs: 1500 + i * 100 });
    c.onChat = (all) => chats.splice(0, chats.length, ...all);
    c.onStatus = (s, info) => statuses.push([s, info]);
    devs.push({ p, c, chats, statuses });
    vt.run(50);
  }
  const step = (_t, dt) => devs.forEach((d) => d.p.advance(dt));
  const live = () => devs.filter((d) => net.links.has(d.c.clientId) && d.p.key);
  const spread = () => {
    const ts = live().map((d) => d.p.t);
    return Math.max(...ts) - Math.min(...ts);
  };
  return { vt, net, devs, step, spread };
}

test("cap: 9 seats; the 10th gets 'Party is full (9/9)'; a dropped seat is kept through grace", () => {
  let t = 0;
  const core = new RoomCore({ code: "ABC234", now: () => t, send: () => {} });
  for (let i = 0; i < MAX_MEMBERS; i++) assert.ok(core.join(`m${i}`).ok);
  const r = core.join("m9");
  assert.equal(r.ok, false);
  assert.equal(r.message, "Party is full (9/9)");
  assert.equal(core.view().count, 9);
  assert.equal(core.view().max, 9);
  core.drop("m3");
  assert.equal(core.join("x").ok, false, "seat held during grace");
  assert.ok(core.join("m3").ok, "reconnect within grace keeps the seat");
  core.drop("m3");
  t += 60 * 60_000;
  core.prune();
  assert.ok(core.join("x").ok, "seat freed after grace");
  core.leave("x");
  assert.ok(core.join("y").ok, "leave frees at once");
});

test("host: first joiner hosts; handoff on drop and on leave; only the host can end", () => {
  const sent = [];
  const core = new RoomCore({ code: "ABC234", now: () => 0, send: (id, m) => sent.push([id, m]) });
  core.join("a");
  core.join("b");
  core.join("c");
  assert.equal(core.hostId, "a");
  assert.equal(core.end("b"), false, "guest cannot end");
  core.drop("a");
  assert.equal(core.hostId, "b");
  core.join("a");
  assert.equal(core.hostId, "b", "host stays with b after a reconnects");
  core.leave("b");
  assert.ok(core.hostId === "a" || core.hostId === "c");
  const host = core.hostId;
  core.handle(host, { type: "end" });
  assert.ok(core.ended);
  const ends = sent.filter(([, m]) => m.type === "ended");
  assert.equal(ends.length, 2, "every connected member told");
});

test("chat: escaped not filtered, length cap, per-user rate limit, history for joiners", () => {
  let t = 0;
  const sent = [];
  const core = new RoomCore({ code: "ABC234", now: () => t, send: (id, m) => sent.push([id, m]) });
  core.join("a", { name: "<b>Al</b>" });
  core.join("b", { name: "Bo" });
  core.handle("a", { type: "chat", text: "<script>x()</script> damn this is good" });
  const msg = sent.filter(([id, m]) => id === "b" && m.type === "chat").at(-1)[1];
  assert.equal(msg.text, "&lt;script&gt;x()&lt;/script&gt; damn this is good", "no word filter, HTML escaped");
  assert.equal(msg.name, escapeHtml("<b>Al</b>"));
  assert.ok(Number.isFinite(msg.ts));
  core.handle("a", { type: "chat", text: "x".repeat(1000) });
  assert.equal(core.chatLog.at(-1).text.length, CHAT_MAX_LEN);
  for (let i = 0; i < 10; i++) core.handle("a", { type: "chat", text: `spam ${i}` });
  const fromA = core.chatLog.filter((c) => c.from === "a").length;
  assert.equal(fromA, 5, "5 per 10 s per user");
  core.handle("b", { type: "chat", text: "b still can talk" });
  assert.equal(core.chatLog.at(-1).from, "b", "limit is per user, not per room");
  core.join("c");
  const hist = sent.filter(([id, m]) => id === "c" && m.type === "chat-history").at(-1)[1];
  assert.equal(hist.messages.length, core.chatLog.length);
});

test("ordering: stale / replayed commands are ignored (cseq)", () => {
  const core = new RoomCore({ code: "ABC234", now: () => 0, send: () => {} });
  core.join("a");
  core.handle("a", { type: "media", media: MOVIE, cseq: 1 });
  core.handle("a", { type: "seek", pos: 500, cseq: 3 });
  core.handle("a", { type: "seek", pos: 10, cseq: 2 }); // arrived late
  assert.equal(core.playback.pos, 500);
});

test("3 clients: host drops mid-play, the others keep playing with no pause; host rejoins in sync", () => {
  const R = party(3);
  R.devs[0].c.pickMedia(MOVIE);
  R.vt.run(10_000, R.step);
  assert.equal(R.net.core.playback.paused, false);
  assert.equal(R.net.core.hostId, "d0");
  const epoch = R.net.core.epoch;
  let paused = false;
  R.net.links.get("d0").drop();
  R.vt.run(300, R.step);
  assert.notEqual(R.net.core.hostId, "d0", "host handed off");
  R.vt.run(9000, (t, dt) => {
    R.step(t, dt);
    if (R.net.core.playback.paused || R.devs[1].p.status === "paused" || R.devs[2].p.status === "paused") paused = true;
  });
  assert.equal(paused, false, "no pause for the others");
  assert.equal(R.net.core.epoch, epoch, "no hold or seek");
  assert.equal(R.net.core.connected.length, 3, "host reconnected");
  R.vt.run(5000, R.step);
  assert.ok(R.spread() < 0.15, `spread ${(R.spread() * 1000).toFixed(0)} ms`);
});

test("late join while playing: loads the same title, lands on the live position, nobody else paused", () => {
  const R = party(2);
  R.devs[0].c.pickMedia(MOVIE);
  R.devs[0].c.sendChat("hi");
  R.vt.run(15_000, R.step);
  const epoch = R.net.core.epoch;
  const p = new SimPlayer(R.vt, { kind: "web", skewMs: 333, startLatencyMs: 60 });
  const chats = [];
  const c = addDevice(R.vt, R.net, { id: "late", platform: "web", player: p });
  c.onChat = (all) => chats.splice(0, chats.length, ...all);
  R.devs.push({ p, c, chats });
  let paused = false;
  R.vt.run(10_000, (t, dt) => {
    R.step(t, dt);
    if (R.net.core.playback.paused || R.devs[0].p.status === "paused") paused = true;
  });
  assert.equal(paused, false, "existing viewers undisturbed");
  assert.equal(R.net.core.epoch, epoch);
  assert.equal(p.key, R.devs[0].p.key, "same title");
  assert.ok(chats.some((m) => m.text === "hi"), "got chat history");
  assert.ok(Math.abs(p.t - R.devs[0].p.t) < 0.15, `late joiner gap ${(Math.abs(p.t - R.devs[0].p.t) * 1000).toFixed(0)} ms`);
});

test("conflicting commands at the same instant from two devices converge to one state", () => {
  const R = party(3);
  R.devs[0].c.pickMedia(MOVIE);
  R.vt.run(10_000, R.step);
  R.devs[0].p.tap("seek", { pos: 300 });
  R.devs[1].p.tap("seek", { pos: 900 });
  R.devs[2].p.tap("pause");
  R.vt.run(3000, R.step);
  R.devs[1].p.tap("play");
  R.vt.run(6000, R.step);
  const keyPos = R.devs.map((d) => d.p.t);
  assert.ok(R.spread() < 0.15, `all on one timeline ${keyPos.map((x) => x.toFixed(2))}`);
  assert.equal(R.net.core.playback.paused, false);
});

test("jitter + lossy pings/chat (states reliable like TCP): stays in sync", () => {
  const R = party(4, { lat: { up: 80, down: 120, jitter: 150, loss: 0.2 } });
  R.devs[0].c.pickMedia(MOVIE);
  R.vt.run(15_000, R.step);
  assert.equal(R.net.core.playback.paused, false);
  let worst = 0;
  R.vt.run(30_000, (t, dt) => {
    R.step(t, dt);
    worst = Math.max(worst, R.spread());
  });
  console.log(`# jitter/loss: worst spread ${(worst * 1000).toFixed(1)} ms`);
  assert.ok(worst < 0.2, `worst spread ${(worst * 1000).toFixed(1)} ms`);
});

test("9 clients: play, pause, seek, chat, drops and rejoins", () => {
  const R = party(9);
  R.vt.run(500, R.step);
  assert.equal(R.net.core.view().count, 9);
  R.devs[4].c.pickMedia(MOVIE);
  R.vt.run(12_000, R.step);
  assert.equal(R.net.core.playback.paused, false);
  assert.ok(R.spread() < 0.15, `start spread ${(R.spread() * 1000).toFixed(0)} ms`);
  R.devs[7].p.tap("pause");
  R.vt.run(1500, R.step);
  assert.ok(R.devs.every((d) => d.p.status === "paused"), "pause for all");
  assert.ok(R.spread() < 0.001);
  R.devs[2].p.tap("seek", { pos: 2400 });
  R.devs[2].p.tap("play");
  R.vt.run(6000, R.step);
  assert.ok(R.devs.every((d) => d.p.t > 2400), "seek for all");
  R.devs[3].c.sendChat("nice");
  R.vt.run(500, R.step);
  assert.ok(R.devs.every((d) => d.chats.some((m) => m.text === "nice")), "chat to all");
  R.net.links.get("d1").drop();
  R.net.links.get("d6").drop();
  R.vt.run(9000, R.step);
  assert.equal(R.net.core.connected.length, 9, "both rejoined");
  assert.equal(R.net.core.playback.paused, false);
  R.vt.run(5000, R.step);
  assert.ok(R.spread() < 0.15, `spread after rejoins ${(R.spread() * 1000).toFixed(0)} ms`);
  const t0 = R.devs[0].p.t;
  R.devs[8].c.leave();
  R.vt.run(2000, R.step);
  assert.equal(R.net.core.members.size, 8);
  assert.ok(R.devs[0].p.t > t0 + 1.5, "leave does not stop the others");
});
