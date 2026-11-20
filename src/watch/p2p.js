// Watch Party with no room server of our own (fallback when no Cloudflare
// room server is configured or it can't be reached).
//
// The party host's device runs the room itself: the very same RoomCore the
// Cloudflare Worker runs (src/watch/roomCore.js), so the rules are identical
// (anyone's Pause pauses everyone; buffering holds everyone on one frame and
// all restart together, START_WAIT_MS safety; chat / typing / keyboard /
// full screen / rotation / backgrounding never pause; anyone can Pick; up to
// 9 people). Guests reach the host peer-to-peer over a WebRTC data channel;
// the free public PeerJS broker (0.peerjs.com) only introduces them. The
// 6-character party code is the host's peer id: "superplayer-" + code.
//
// Both sides hand WatchClient a WebSocket look-alike (WebSocketImpl), so the
// client, the sync engine and the UI are unchanged:
//   - the host's own client talks to the room through a loopback socket;
//   - a guest's socket is a PeerJS data connection to the host.
// Wire (strings, JSON): guest -> {"type":"hello",id,platform,name} first;
// host -> {"type":"welcome"} (socket "open"), then room messages as from the
// Worker; {"type":"_close",code,reason} stands in for a WebSocket close code
// (4404 no party, 4409 full, 4410 ended by host, 4411 host left).
import { RoomCore } from "./roomCore.js";
import { MAX_MEMBERS, fullMessage, makeCode } from "./protocol.js";

export const PEER_PREFIX = "superplayer-";
export const peerIdFor = (code) => PEER_PREFIX + code;
export const P2P_URL = (code) => `p2p://party/${code}`;
export const SWEEP_MS = 5_000;
/** Guest: the host can't be reached for this long after having been in the party -> the party is over. */
export const HOST_GONE_MS = 45_000;
/** Broker / data channel must open within this. */
export const OPEN_TIMEOUT_MS = 15_000;
export const NO_PARTY_MESSAGE = "No party with that code";
export const HOST_LEFT_MESSAGE = "The host left, so the party ended";

let PeerOverride = null;
/** Tests (node) inject a Peer class; the apps load peerjs lazily. */
export function setPeerImpl(Impl) {
  PeerOverride = Impl;
}
async function loadPeer() {
  if (PeerOverride) return PeerOverride;
  const m = await import("peerjs");
  return m.Peer || m.default?.Peer || m.default;
}

/** A PeerJS peer that is registered with the broker (rejects with the PeerJS error type). */
export async function openPeer(id, { timers = globalThis } = {}) {
  const Peer = await loadPeer();
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
    let done = false;
    const t = timers.setTimeout(() => {
      if (done) return;
      done = true;
      try {
        peer.destroy();
      } catch {}
      reject(Object.assign(new Error("Couldn't reach Watch Party (check your connection)"), { type: "timeout" }));
    }, OPEN_TIMEOUT_MS);
    peer.on("open", () => {
      if (done) return;
      done = true;
      timers.clearTimeout(t);
      resolve(peer);
    });
    peer.on("error", (e) => {
      if (done) return;
      done = true;
      timers.clearTimeout(t);
      try {
        peer.destroy();
      } catch {}
      reject(Object.assign(new Error(e?.message || "Couldn't reach Watch Party"), { type: e?.type || "error" }));
    });
  });
}

const parseQuery = (url) => {
  const i = String(url).indexOf("?");
  return new URLSearchParams(i >= 0 ? String(url).slice(i + 1) : "");
};
const closeFrame = (code, reason) => JSON.stringify({ type: "_close", code, reason: reason || "" });
const isCtl = (s, type) => typeof s === "string" && s.startsWith(`{"type":"${type}"`);

// ── Host ─────────────────────────────────────────────────────────────────
export class P2PHost {
  /** Registers a fresh party code with the broker (retries on a taken code). */
  static async create({ timers = globalThis, now = () => Date.now(), code = null } = {}) {
    let lastErr = null;
    for (let i = 0; i < 5; i++) {
      const c = code && i === 0 ? code : makeCode();
      try {
        const peer = await openPeer(peerIdFor(c), { timers });
        return new P2PHost({ peer, code: c, timers, now });
      } catch (e) {
        lastErr = e;
        if (e.type !== "unavailable-id") break; // only a taken code is worth another try
      }
    }
    throw lastErr || new Error("Couldn't start a party");
  }

  constructor({ peer, code, timers = globalThis, now = () => Date.now() }) {
    Object.assign(this, { peer, code, timers, now });
    this.links = new Map(); // member id -> link { send(frame), close(code, reason) }
    this.ended = false;
    this.destroyed = false;
    this.core = new RoomCore({
      code,
      now,
      send: (id, msg) => this.links.get(id)?.send(JSON.stringify(msg)),
      sendMany: (ids, frame) => ids.forEach((id) => this.links.get(id)?.send(frame)),
    });
    peer.on("connection", (conn) => this.onConnection(conn));
    // Lost the broker (network blip, app in background): existing data
    // channels keep working; re-register so new guests can still find us.
    peer.on("disconnected", () => {
      if (this.destroyed) return;
      this.timers.setTimeout(() => {
        if (!this.destroyed && peer.disconnected && !peer.destroyed) {
          try {
            peer.reconnect();
          } catch {}
        }
      }, 1500);
    });
    peer.on("error", () => {}); // per-connection problems are handled on the connection
    this.sweep = timers.setInterval(() => this.housekeeping(), SWEEP_MS);
  }

  housekeeping() {
    if (this.destroyed) return;
    for (const id of this.core.evictIdle()) this.links.get(id)?.close(4408, "idle");
    this.core.prune();
    if (this.peer.disconnected && !this.peer.destroyed) {
      try {
        this.peer.reconnect();
      } catch {}
    }
  }

  onConnection(conn) {
    let id = null;
    let link = null;
    conn.on("data", (raw) => {
      const s = typeof raw === "string" ? raw : String(raw);
      if (id) return this.receive(id, link, s);
      let hello;
      try {
        hello = JSON.parse(s);
      } catch {
        return;
      }
      if (hello?.type !== "hello" || typeof hello.id !== "string" || !hello.id) return;
      id = hello.id.slice(0, 64);
      link = {
        send: (frame) => {
          try {
            if (conn.open) conn.send(frame);
          } catch {}
        },
        close: (code, reason) => {
          link.closed = true;
          try {
            if (conn.open) conn.send(closeFrame(code, reason));
          } catch {}
          this.timers.setTimeout(() => {
            try {
              conn.close();
            } catch {}
          }, 300);
        },
      };
      this.attach(id, link, { platform: hello.platform, name: hello.name });
    });
    const gone = () => id && link && !link.closed && this.detach(id, link, false);
    conn.on("close", gone);
    conn.on("error", gone);
  }

  /** A member's socket opened (guest data channel or the host's loopback). */
  attach(id, link, info) {
    if (this.ended) return link.close(4410, "ended by host");
    if (!this.core.members.has(id) && this.core.members.size >= MAX_MEMBERS) return link.close(4409, fullMessage());
    const old = this.links.get(id);
    if (old && old !== link) {
      this.links.delete(id);
      old.close(4000, "replaced");
    }
    this.links.set(id, link);
    link.send(JSON.stringify({ type: "welcome" }));
    this.core.join(id, info);
  }

  /** Same handling as the Worker's webSocketMessage. */
  receive(id, link, data) {
    if (this.ended || this.links.get(id) !== link) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!this.core.members.get(id)?.connected && msg.type !== "leave") {
      if (!this.core.members.has(id) && this.core.members.size >= MAX_MEMBERS) return link.close(4409, fullMessage());
      this.core.join(id, this.core.members.get(id) || {});
    }
    this.core.handle(id, msg);
    if (msg.type === "leave") {
      this.links.delete(id);
      return;
    }
    if (this.core.ended) this.endParty();
  }

  detach(id, link, left) {
    if (this.links.get(id) !== link) return;
    this.links.delete(id);
    if (!left) this.core.drop(id);
  }

  /** Ends the party for everyone (host's End, host's Leave, host closing the app). */
  endParty() {
    if (this.destroyed) return;
    if (!this.ended) {
      this.ended = true;
      if (!this.core.ended) this.core.fanout({ type: "ended", reason: "host", by: this.core.hostId });
    }
    for (const link of [...this.links.values()]) link.close(4410, "ended by host");
    this.links.clear();
    this.destroyed = true;
    this.timers.clearInterval(this.sweep);
    this.timers.setTimeout(() => {
      try {
        this.peer.destroy();
      } catch {}
    }, 800);
  }

  /** WebSocket look-alike for the host's own WatchClient (no network). */
  socketClass() {
    const host = this;
    return class LoopSocket {
      constructor(url) {
        const q = parseQuery(url);
        this.id = q.get("id");
        this.open = false;
        this.link = {
          send: (frame) => host.timers.setTimeout(() => this.deliver(frame), 0),
          close: (code, reason) => host.timers.setTimeout(() => this.finish(code, reason), 0),
        };
        host.timers.setTimeout(() => host.attach(this.id, this.link, { platform: q.get("platform"), name: q.get("name") }), 0);
      }
      deliver(frame) {
        if (this.done) return;
        if (isCtl(frame, "welcome")) {
          this.open = true;
          return this.onopen?.();
        }
        this.onmessage?.({ data: frame });
      }
      send(data) {
        if (!this.open || this.done) return;
        host.timers.setTimeout(() => host.receive(this.id, this.link, data), 0);
      }
      finish(code, reason) {
        if (this.done) return;
        this.done = true;
        this.open = false;
        this.onclose?.({ code, reason });
      }
      close() {
        // The host's own client leaving = the party ends (the room lives on this device).
        host.timers.setTimeout(() => {
          host.detach(this.id, this.link, true);
          this.finish(1000, "bye");
        }, 0);
      }
    };
  }
}

// ── Guest ────────────────────────────────────────────────────────────────
/**
 * WebSocket look-alike for a guest: one PeerJS data connection to the host
 * peer of `code`. `party` is shared across the client's reconnects so a host
 * that stays unreachable ends the party instead of retrying forever.
 */
export function guestSocketClass(code, { timers = globalThis, now = () => Date.now() } = {}) {
  const party = { everOpen: false, lostSince: null };
  return class PeerSocket {
    constructor(url) {
      const q = parseQuery(url);
      this.hello = JSON.stringify({ type: "hello", id: q.get("id"), platform: q.get("platform"), name: q.get("name") || "" });
      this.open = false;
      this.done = false;
      this.start();
    }
    async start() {
      try {
        this.peer = await openPeer(null, { timers });
      } catch {
        return this.fail(null);
      }
      if (this.done) return this.cleanup();
      this.peer.on("error", (e) => this.fail(e?.type));
      this.peer.on("disconnected", () => {}); // broker gone; the data channel may still be fine
      const conn = this.peer.connect(peerIdFor(code), { reliable: true, serialization: "raw" });
      this.conn = conn;
      this.timer = timers.setTimeout(() => !this.open && this.fail("timeout"), OPEN_TIMEOUT_MS);
      conn.on("open", () => {
        try {
          conn.send(this.hello);
        } catch {}
      });
      conn.on("data", (raw) => this.recv(typeof raw === "string" ? raw : String(raw)));
      conn.on("close", () => this.fail("closed"));
      conn.on("error", () => this.fail("closed"));
    }
    recv(s) {
      if (this.done) return;
      if (isCtl(s, "welcome")) {
        this.open = true;
        party.everOpen = true;
        party.lostSince = null;
        timers.clearTimeout(this.timer);
        return this.onopen?.();
      }
      if (isCtl(s, "_close")) {
        let c = {};
        try {
          c = JSON.parse(s);
        } catch {}
        return this.finish(c.code || 1006, c.reason);
      }
      this.onmessage?.({ data: s });
    }
    /** Connection failed or dropped: map to the close code WatchClient understands. */
    fail(kind) {
      if (this.done) return;
      if (!party.everOpen) {
        // Never got in: the broker says no such peer -> wrong / expired code.
        if (kind === "peer-unavailable") return this.finish(4404, NO_PARTY_MESSAGE);
        if (kind === "timeout") return this.finish(4404, NO_PARTY_MESSAGE);
        return this.finish(1006, "");
      }
      // Was in the party: retry (WatchClient backs off) until the host is gone too long.
      party.lostSince ??= now();
      if (now() - party.lostSince >= HOST_GONE_MS) return this.finish(4411, HOST_LEFT_MESSAGE);
      this.finish(1006, "");
    }
    finish(code, reason) {
      if (this.done) return;
      this.done = true;
      this.open = false;
      timers.clearTimeout(this.timer);
      this.cleanup(300);
      this.onclose?.({ code, reason });
    }
    cleanup(delay = 0) {
      const peer = this.peer;
      if (!peer) return;
      timers.setTimeout(() => {
        try {
          peer.destroy();
        } catch {}
      }, delay);
    }
    send(data) {
      if (!this.open || this.done) return;
      try {
        this.conn?.send(data);
      } catch {}
    }
    close() {
      // Let a just-sent "leave" go out before the channel closes.
      if (this.done) return;
      this.done = true;
      this.open = false;
      timers.clearTimeout(this.timer);
      const conn = this.conn;
      timers.setTimeout(() => {
        try {
          conn?.close();
        } catch {}
      }, 250);
      this.cleanup(400);
      timers.setTimeout(() => this.onclose?.({ code: 1000, reason: "bye" }), 0);
    }
  };
}
