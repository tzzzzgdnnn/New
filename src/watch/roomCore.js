// Watch Together room: the authoritative state of one room, with no
// Cloudflare (or any) API in it, so the Durable Object and the tests run the
// exact same logic. The server never plays anything; it decides *when*:
//
//  - Anyone in the room can pick the title (movie or episode). Everyone
//    switches to it, paused at its start, then starts together.
//  - Play only starts when every connected member has the title loaded and
//    buffered at the hold position; the start is scheduled START_LEAD_MS
//    ahead so all phones begin on the same instant.
//  - Any member stalling (buffering) while playing freezes the room at the
//    stalled member's position (the frame it stopped on); nobody plays ahead.
//    When everyone reports ready at that exact position, all resume together.
//  - Pause / seek / play from any member applies to all.
//  - A member that drops its connection holds the room (same as buffering)
//    until it reconnects or RECONNECT_GRACE_MS passes.
//
// Every hold/seek bumps `epoch`; a member's "ready" only counts for the
// epoch (and media revision) it was reported for, so a stale ready from
// before a seek can never trigger a start.
import {
  START_LEAD_MS,
  RECONNECT_GRACE_MS,
  MAX_MEMBERS,
  PLATFORMS,
  cleanMedia,
  expectedPosition,
} from "./protocol.js";

const finite = (n) => typeof n === "number" && Number.isFinite(n);

export class RoomCore {
  /**
   * @param {{code: string, now?: () => number, send: (id: string, msg: object) => void}} o
   */
  constructor({ code, now = () => Date.now(), send }) {
    this.code = code;
    this.now = now;
    this.send = send;
    this.members = new Map();
    this.media = null; // cleanMedia + { rev, by, stream }
    this.rev = 0;
    this.epoch = 0;
    this.intent = "pause"; // what the room wants: "play" | "pause"
    this.playback = { paused: true, pos: 0, at: now(), rate: 1 };
    this.seq = 0;
    this.createdAt = now();
  }

  // ── Persistence (Durable Object storage) ────────────────────────────────
  snapshot() {
    return {
      code: this.code,
      media: this.media,
      rev: this.rev,
      epoch: this.epoch,
      intent: this.intent,
      playback: this.playback,
      createdAt: this.createdAt,
      members: [...this.members.values()].map((m) => ({ ...m, connected: false, droppedAt: this.now() })),
    };
  }

  restore(s) {
    if (!s) return;
    Object.assign(this, {
      media: s.media ?? null,
      rev: s.rev ?? 0,
      epoch: s.epoch ?? 0,
      intent: s.intent ?? "pause",
      playback: s.playback ?? this.playback,
      createdAt: s.createdAt ?? this.createdAt,
    });
    // After an eviction everyone has to reconnect: hold where we were.
    if (!this.playback.paused) this.hold(expectedPosition(this.playback, this.now()));
    for (const m of s.members || []) this.members.set(m.id, m);
  }

  get connected() {
    return [...this.members.values()].filter((m) => m.connected);
  }

  get empty() {
    return this.connected.length === 0;
  }

  // ── Members ─────────────────────────────────────────────────────────────
  join(id, { platform, name } = {}) {
    const known = this.members.get(id);
    if (!known && this.members.size >= MAX_MEMBERS) return { ok: false, error: "room-full" };
    const m = known || { id, joinedAt: this.now() };
    Object.assign(m, {
      platform: PLATFORMS.includes(platform) ? platform : "web",
      name: String(name || m.name || "Guest").slice(0, 24),
      connected: true,
      droppedAt: null,
      ready: false,
      buffering: false,
      rev: -1,
      epoch: -1,
      pos: null,
    });
    this.members.set(id, m);
    // Someone (re)joining has to load and buffer first: hold for them.
    if (!this.playback.paused) this.hold(expectedPosition(this.playback, this.now()), "joining");
    this.broadcast();
    return { ok: true };
  }

  /** The socket dropped (no Leave): hold the room for them for a while. */
  drop(id) {
    const m = this.members.get(id);
    if (!m || !m.connected) return;
    m.connected = false;
    m.droppedAt = this.now();
    m.ready = false;
    if (!this.playback.paused && this.connected.length > 0) this.hold(expectedPosition(this.playback, this.now()), "reconnecting");
    this.broadcast();
  }

  /** Left on purpose (Leave button): gone at once, the others carry on. */
  leave(id) {
    if (!this.members.delete(id)) return;
    this.evaluate();
    this.broadcast();
  }

  /** Drops members whose grace ran out. Returns true if anything changed. */
  prune() {
    const now = this.now();
    let changed = false;
    for (const m of [...this.members.values()]) {
      if (!m.connected && now - (m.droppedAt ?? 0) >= RECONNECT_GRACE_MS) {
        this.members.delete(m.id);
        changed = true;
      }
    }
    if (changed) {
      this.evaluate();
      this.broadcast();
    }
    return changed;
  }

  // ── Messages ────────────────────────────────────────────────────────────
  handle(id, msg) {
    const m = this.members.get(id);
    if (!m || !msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "ping":
        this.send(id, { type: "pong", t0: msg.t0, ts: this.now() });
        return;
      case "media":
        return this.setMedia(id, msg.media);
      case "stream":
        return this.setStream(id, msg);
      case "status":
        return this.status(m, msg);
      case "play":
        return this.play(msg.pos);
      case "pause":
        return this.pause(msg.pos);
      case "seek":
        return this.seek(msg.pos);
      case "rate":
        return this.setRate(msg.rate);
      case "leave":
        return this.leave(id);
      default:
    }
  }

  setMedia(by, raw) {
    const media = cleanMedia(raw);
    if (!media) return;
    // Two phones picking the same thing at once (e.g. both hit Up Next): one switch.
    if (this.media && this.media.key === media.key) {
      if (this.intent !== "play") this.play();
      return;
    }
    this.rev += 1;
    this.media = { ...media, rev: this.rev, by, stream: null };
    this.epoch += 1;
    this.playback = { paused: true, pos: media.startAt, at: this.now(), rate: 1 };
    this.intent = "play";
    for (const m of this.members.values()) Object.assign(m, { ready: false, buffering: false });
    this.broadcast();
  }

  /** The picker's phone found the stream: shared so everyone plays the same source. */
  setStream(by, { rev, url, headers, server, audioLang }) {
    if (!this.media || rev !== this.media.rev || typeof url !== "string" || !/^https?:\/\//.test(url)) return;
    if (this.media.stream && this.media.by !== by) return; // first stream of the picker wins
    const h = {};
    if (headers && typeof headers === "object") {
      for (const [k, v] of Object.entries(headers).slice(0, 12)) if (typeof v === "string") h[k] = v.slice(0, 1000);
    }
    this.media.stream = { url: url.slice(0, 4000), headers: h, server: typeof server === "string" ? server : null };
    if (typeof server === "string") this.media.server = server;
    if (typeof audioLang === "string" && audioLang) this.media.audioLang = audioLang.slice(0, 16);
    this.broadcast();
  }

  status(m, s) {
    m.ready = !!s.ready;
    m.buffering = !!s.buffering;
    m.rev = finite(s.rev) ? s.rev : -1;
    m.epoch = finite(s.epoch) ? s.epoch : -1;
    m.pos = finite(s.pos) ? s.pos : null;
    m.lastStatus = this.now();
    if (this.evaluate()) this.broadcast();
    else this.broadcastMembersIfChanged();
  }

  play(pos) {
    this.intent = "play";
    if (finite(pos) && this.playback.paused && Math.abs(pos - this.playback.pos) > 0.05) this.hold(Math.max(0, pos));
    this.evaluate();
    this.broadcast();
  }

  pause(pos) {
    this.intent = "pause";
    const expected = expectedPosition(this.playback, this.now());
    // The frame the person saw when they tapped, if it is plausible.
    const at = finite(pos) && Math.abs(pos - expected) < 2 ? pos : expected;
    this.hold(Math.max(0, at));
    this.broadcast();
  }

  seek(pos) {
    if (!finite(pos)) return;
    this.hold(Math.max(0, pos));
    this.evaluate();
    this.broadcast();
  }

  setRate(rate) {
    if (!finite(rate) || rate < 0.5 || rate > 2) return;
    const pos = expectedPosition(this.playback, this.now());
    const wasPlaying = !this.playback.paused;
    this.hold(pos);
    this.playback.rate = rate;
    if (wasPlaying) this.evaluate();
    this.broadcast();
  }

  // ── State machine ───────────────────────────────────────────────────────
  /** Freeze at `pos` (new epoch: everyone must be ready there again). */
  hold(pos, reason = null) {
    this.epoch += 1;
    this.playback = { paused: true, pos, at: this.now(), rate: this.playback.rate || 1 };
    this.holdReason = reason;
  }

  /** Members the room is waiting on (not loaded / not buffered at the hold). */
  waitingOn() {
    if (!this.media) return [];
    const out = [];
    for (const m of this.members.values()) {
      if (!m.connected) {
        out.push(m.id); // dropped, still in grace
        continue;
      }
      const current = m.rev === this.media.rev && m.epoch === this.epoch;
      if (!current || !m.ready || m.buffering) out.push(m.id);
    }
    return out;
  }

  /** Applies the rules; true when the playback state changed. */
  evaluate() {
    if (!this.media || this.connected.length === 0) return false;
    const now = this.now();
    if (!this.playback.paused) {
      // Someone stalled: everyone stops on the stalled phone's frame.
      const stalled = this.connected.filter((m) => m.buffering && m.rev === this.media.rev && m.epoch === this.epoch);
      if (stalled.length) {
        const expected = expectedPosition(this.playback, now);
        const at = stalled
          .map((m) => m.pos)
          .filter((p) => finite(p) && Math.abs(p - expected) < 5)
          .reduce((a, b) => Math.min(a, b), expected);
        this.hold(Math.max(0, at), "buffering");
        return true;
      }
      return false;
    }
    if (this.intent !== "play") return false;
    if (this.waitingOn().length) return false;
    // Everyone is loaded and buffered at the hold position: start together.
    this.playback = { paused: false, pos: this.playback.pos, at: now + START_LEAD_MS, rate: this.playback.rate || 1 };
    this.holdReason = null;
    return true;
  }

  // ── Output ──────────────────────────────────────────────────────────────
  view() {
    return {
      type: "state",
      code: this.code,
      seq: this.seq,
      media: this.media,
      epoch: this.epoch,
      intent: this.intent,
      playback: this.playback,
      holdReason: this.holdReason || null,
      waiting: this.waitingOn(),
      members: [...this.members.values()].map(({ id, platform, name, connected, ready, buffering }) => ({
        id,
        platform,
        name,
        connected,
        ready,
        buffering,
      })),
      serverNow: this.now(),
    };
  }

  broadcast() {
    this.seq += 1;
    this.lastMembersSig = this.membersSig();
    const v = this.view();
    for (const m of this.members.values()) if (m.connected) this.send(m.id, { ...v, you: m.id });
  }

  membersSig() {
    return JSON.stringify([...this.members.values()].map((m) => [m.id, m.connected, m.ready, m.buffering]));
  }

  broadcastMembersIfChanged() {
    if (this.membersSig() !== this.lastMembersSig) this.broadcast();
  }
}
