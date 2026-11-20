// Deterministic simulation for the Watch Together tests: a virtual clock,
// a network with latency/jitter, the real RoomCore as the server, real
// WatchClients, and simulated players that behave like AVPlayer (iOS app,
// exact scheduled start) or a web <video> (start latency, coarse seeks).
import { RoomCore } from "../src/watch/roomCore.js";
import { WatchClient } from "../src/watch/client.js";
import { mediaKey } from "../src/watch/protocol.js";

export class VirtualTime {
  constructor() {
    this.t = 1_700_000_000_000;
    this.q = [];
    this.seq = 0;
    this.ids = 0;
    this.live = new Set();
  }
  now = () => this.t;
  setTimeout = (fn, ms = 0) => {
    const id = ++this.ids;
    this.live.add(id);
    this.q.push({ at: this.t + Math.max(0, ms), fn, id, once: true, seq: this.seq++ });
    return id;
  };
  setInterval = (fn, ms) => {
    const id = ++this.ids;
    this.live.add(id);
    const tick = () => {
      fn();
      if (this.live.has(id)) this.q.push({ at: this.t + ms, fn: tick, id, seq: this.seq++ });
    };
    this.q.push({ at: this.t + ms, fn: tick, id, seq: this.seq++ });
    return id;
  };
  clearTimeout = (id) => this.live.delete(id);
  clearInterval = (id) => this.live.delete(id);
  /** Run `ms` of virtual time; `each(t)` is called every `stepMs` (the players' physics). */
  run(ms, each, stepMs = 10) {
    const end = this.t + ms;
    let nextEach = this.t + stepMs;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const nextJob = this.q.length ? this.q[0].at : Infinity;
      const nextT = Math.min(nextJob, each ? nextEach : Infinity);
      if (nextT > end) break;
      if (each && nextEach <= nextJob) {
        this.t = nextEach;
        each(this.t, stepMs / 1000);
        nextEach += stepMs;
        continue;
      }
      this.t = nextJob;
      const job = this.q.shift();
      if (!this.live.has(job.id)) continue;
      if (job.once) this.live.delete(job.id);
      job.fn();
    }
    this.t = end;
  }
}

/**
 * A player with one item clock carrying both tracks: `video` and `audio`
 * positions both derive from the same item time, so whatever the engine does
 * (rate nudges, seeks), A/V stay locked on this device.
 */
export class SimPlayer {
  constructor(vt, { kind = "ios", skewMs = 0, speedError = 0, seekMs = 80, startLatencyMs = 0, downloadRate = 3 } = {}) {
    Object.assign(this, { vt, kind, skewMs, speedError, seekMs, startLatencyMs, downloadRate });
    this.key = null;
    this.t = 0; // item time (s)
    this.bufEnd = 0;
    this.rate = 0; // actual playing rate (0 = not advancing)
    this.wantRate = 1;
    this.status = "paused";
    this.seeking = false;
    this.pending = null;
    this.stallNet = false; // network stopped (forces a stall)
    this.loading = false;
    this.cmds = [];
    this.avMaxGap = 0;
    this.onIntent = null;
  }
  localNow = () => this.vt.now() + this.skewMs;

  load(key, ms = 1500) {
    this.key = null;
    this.loading = true;
    this.t = 0;
    this.bufEnd = 0;
    this.rate = 0;
    this.status = "paused";
    this.vt.setTimeout(() => {
      this.loading = false;
      this.key = key;
    }, ms);
  }

  // Adapter API ----------------------------------------------------------
  read() {
    return {
      key: this.key,
      ready: !this.loading && this.bufEnd - this.t >= 2 && !this.seeking,
      seeking: this.seeking,
      status: this.status,
      pos: this.t,
      sampledAt: this.localNow(),
      rate: this.rate || this.wantRate,
    };
  }
  pause(pos) {
    this.cmds.push(["pause", pos]);
    this.rate = 0;
    this.status = "paused";
    this.pending = null;
    this.seekTo(pos);
  }
  playAt(pos, atLocal, rate) {
    this.cmds.push(["playAt", pos, atLocal, rate]);
    this.rate = 0;
    this.status = "paused";
    this.wantRate = rate;
    if (Math.abs(this.t - pos) > 0.001) this.seekTo(pos);
    this.pending = { pos, atLocal };
  }
  setRate(r) {
    this.cmds.push(["rate", r]);
    this.wantRate = r;
    if (this.status === "playing") this.rate = r;
  }
  seekTo(pos) {
    this.seeking = true;
    this.t = pos;
    if (this.bufEnd < pos || this.bufEnd > pos + 60) this.bufEnd = pos; // jump outside the buffer
    this.vt.setTimeout(() => (this.seeking = false), this.seekMs);
  }

  /** Advance the simulation by dt seconds of true time. */
  advance(dt) {
    if (this.key && !this.stallNet) this.bufEnd = Math.min(this.bufEnd + this.downloadRate * dt, this.t + 120);
    if (this.pending && !this.seeking && this.localNow() >= this.pending.atLocal) {
      const late = (this.localNow() - this.pending.atLocal) / 1000;
      // iOS: setRate(_:time:atHostTime:) starts exactly; a late call starts at pos + lateness.
      // Web: play() after a timer, plus the element's own start latency.
      this.t = this.pending.pos + (this.kind === "ios" ? late : 0);
      this.pending = null;
      if (this.kind === "ios") {
        this.status = "playing";
        this.rate = this.wantRate;
      } else {
        this.status = "waiting";
        this.vt.setTimeout(() => {
          if (this.status === "waiting" && this.bufEnd > this.t) {
            this.status = "playing";
            this.rate = this.wantRate;
          }
        }, this.startLatencyMs);
      }
    }
    if (this.status === "playing") {
      this.t += dt * this.rate * (1 + this.speedError);
      if (this.t >= this.bufEnd) {
        this.t = this.bufEnd;
        this.status = "waiting"; // stalled: AVPlayer waitingToPlayAtSpecifiedRate
        this.rate = 0;
      }
    } else if (this.status === "waiting" && this.bufEnd - this.t >= 2 && !this.pending && this.kind === "ios") {
      // AVPlayer resumes by itself once it can keep up.
      this.status = "playing";
      this.rate = this.wantRate;
    }
    // One item clock: both tracks are read from it.
    const video = this.t;
    const audio = this.t;
    this.avMaxGap = Math.max(this.avMaxGap, Math.abs(video - audio));
  }

  // The person using this device.
  tap(action, extra = {}) {
    this.onIntent?.({ action, pos: this.t, ...extra });
  }
}

/** Room server + network: the RoomCore in a fake Durable Object. */
export class SimNet {
  constructor(vt, { code = "ABC234" } = {}) {
    this.vt = vt;
    this.links = new Map(); // id -> socket
    this.core = new RoomCore({ code, now: vt.now, send: (id, msg) => this.links.get(id)?.down(msg) });
  }
  latencyFor(id) {
    return this.links.get(id)?.lat || { up: 30, down: 30, jitter: 5 };
  }
  socketClass(lat) {
    const net = this;
    return class FakeWS {
      constructor(url) {
        const q = new URL(url).searchParams;
        this.id = q.get("id");
        this.lat = lat;
        this.open = true;
        net.links.set(this.id, this);
        const j = () => Math.random() * lat.jitter;
        this.j = j;
        net.vt.setTimeout(() => {
          if (!this.open) return;
          net.core.join(this.id, { platform: q.get("platform"), name: q.get("name") });
          this.onopen?.();
        }, lat.up);
      }
      send(data) {
        if (!this.open) return;
        net.vt.setTimeout(() => this.open && net.core.handle(this.id, JSON.parse(data)), this.lat.up + this.j());
      }
      down(msg) {
        if (!this.open) return;
        const s = JSON.stringify(msg);
        net.vt.setTimeout(() => this.open && this.onmessage?.({ data: s }), this.lat.down + this.j());
      }
      close() {
        this.drop(true);
      }
      drop(left = false) {
        if (!this.open) return;
        this.open = false;
        if (net.links.get(this.id) === this) net.links.delete(this.id);
        if (!left) net.core.drop(this.id);
        this.onclose?.({ code: 1006 });
      }
    };
  }
}

/** A device in the room: player + real WatchClient, loading what the room picks. */
export function addDevice(vt, net, { id, platform, player, lat = { up: 30, down: 30, jitter: 5 }, loadMs = 1500 }) {
  const client = new WatchClient({
    url: "wss://sim/rooms/ABC234/ws",
    clientId: id,
    platform,
    name: id,
    adapter: player,
    WebSocketImpl: net.socketClass(lat),
    now: player.localNow,
    timers: vt,
    onState: (st) => {
      const key = st.media?.key;
      if (key && key !== player.key && key !== player.loadingKey) {
        player.loadingKey = key;
        player.load(key, loadMs);
      }
    },
  });
  client.connect();
  return client;
}

export { mediaKey };
