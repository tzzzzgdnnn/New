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
  START_WAIT_MS,
  SEEK_WAIT_MS,
  IDLE_EVICT_MS,
  RECONNECT_GRACE_MS,
  PLATFORMS,
  cleanMedia,
  expectedPosition,
  MAX_MEMBERS,
  fullMessage,
} from "./protocol.js";

const finite = (n) => typeof n === "number" && Number.isFinite(n);

export const CHAT_MAX_LEN = 280;
export const CHAT_HISTORY = 50;
export const CHAT_PER_10S = 5;
export const RATE_BURST = 20;
export const RATE_PER_S = 10;
// Voice signalling (offer / answer / ICE trickle, mic + speaking flags) has its
// own bucket: a mesh handshake sends dozens of ICE candidates at once, which
// must neither be dropped nor eat the tokens Play / Pause / Seek need.
export const SIGNAL_BURST = 200;
export const SIGNAL_PER_S = 50;
// Relayed voice frames (voiceRelay.js): 25 per second per talker, some slack.
export const AUDIO_BURST = 100;
export const AUDIO_PER_S = 40;
/** Largest data: URL avatar (a ~64 px JPEG thumbnail) a member may carry. */
export const AVATAR_DATA_MAX = 8000;
const AVATAR_HOSTS = ["image.tmdb.org", "static.tvmaze.com"];
/**
 * A profile picture every client can draw, or null: a built-in gradient id
 * ("sp:ocean"), a TMDB image path ("/abc.jpg"), an https image on a known
 * host, or a small base64 JPEG / PNG / WebP thumbnail. Anything else is dropped.
 */
export function cleanAvatar(a) {
  if (typeof a !== "string") return null;
  if (/^sp:[a-z]{1,16}$/.test(a)) return a;
  if (/^\/[A-Za-z0-9_-]{1,64}\.(jpe?g|png|webp)$/.test(a)) return a;
  if (a.length <= AVATAR_DATA_MAX && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(a)) return a;
  if (a.length <= 300 && /^https:\/\/[^\s"'<>\\]+$/.test(a)) {
    try {
      const u = new URL(a);
      if (u.protocol === "https:" && AVATAR_HOSTS.includes(u.hostname) && !u.username && !u.password && !u.port) return a;
    } catch {}
  }
  return null;
}
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Display name: one line, no control characters, at most 24 characters. */
export const cleanName = (n) =>
  typeof n === "string" ? n.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 24) : "";

export class RoomCore {
  /**
   * @param {{code: string, now?: () => number, send: (id: string, msg: object) => void}} o
   */
  constructor({ code, now = () => Date.now(), send, sendMany = null }) {
    this.code = code;
    this.sendMany = sendMany; // (ids, serialized) => void: fan out one serialized frame
    this.hostId = null;
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
      hostId: this.hostId,
      chatLog: this.chatLog || [],
      chatSeq: this.chatSeq || 0,
      seq: this.seq || 0,
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
      hostId: s.hostId ?? null,
      chatLog: s.chatLog || [],
      chatSeq: s.chatSeq || 0,
    });
    // Playback is a timeline on the server clock, so it simply carries on
    // across a hibernation / eviction: only a Pause tap pauses the party.
    this.seq = Math.max(this.seq || 0, s.seq ?? 0);
    for (const m of s.members || []) this.members.set(m.id, m);
  }

  get connected() {
    return [...this.members.values()].filter((m) => m.connected);
  }

  get empty() {
    return this.connected.length === 0;
  }

  // ── Members ─────────────────────────────────────────────────────────────
  join(id, { platform, name, avatar } = {}) {
    const known = this.members.get(id);
    // Up to MAX_MEMBERS seats; a dropped member keeps theirs until prune() (grace) frees it.
    if (!known && this.members.size >= MAX_MEMBERS) return { ok: false, error: "room-full", message: fullMessage() };
    const m = known || { id, joinedAt: this.now() };
    Object.assign(m, {
      platform: PLATFORMS.includes(platform) ? platform : "web",
      name: cleanName(name) || m.name || "Guest",
      avatar: cleanAvatar(avatar) || m.avatar || null,
      mic: false, // a (re)connected device opens its mic again on its own
      speaking: false,
      connected: true,
      droppedAt: null,
      ready: false,
      buffering: false,
      rev: -1,
      epoch: -1,
      pos: null,
      cseq: 0,
      lastSeen: this.now(),
      synced: false, // becomes true once it has been ready at the room's current position
    });
    this.members.set(id, m);
    if (!this.hostId || !this.members.get(this.hostId)?.connected) this.hostId = id;
    // A late joiner (or a reconnect) never disturbs the others: playback carries
    // on, and the joiner's engine loads, seeks to the latency-adjusted position
    // and starts on its own. It is not waited on and cannot trigger a stall hold
    // until it has caught up (synced).
    this.broadcast();
    this.sendChatHistory(id);
    return { ok: true };
  }

  /** The socket dropped (no Leave): hold the room for them for a while. */
  drop(id) {
    const m = this.members.get(id);
    if (!m || !m.connected) return;
    m.connected = false;
    m.droppedAt = this.now();
    m.ready = false;
    m.synced = false;
    // A drop never pauses, seeks or ends anything for the others.
    this.handoff(id);
    this.evaluate();
    this.broadcast();
  }

  /** Left on purpose (Leave button): gone at once, the others carry on. */
  leave(id) {
    if (!this.members.delete(id)) return;
    this.handoff(id);
    this.evaluate();
    this.broadcast();
  }

  /** Connected members silent for IDLE_EVICT_MS (no ping): dropped. Returns their ids. */
  evictIdle() {
    const now = this.now();
    const idle = this.connected.filter((m) => now - (m.lastSeen ?? now) >= IDLE_EVICT_MS).map((m) => m.id);
    for (const id of idle) this.drop(id);
    return idle;
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
    if (!m || !msg || typeof msg !== "object" || typeof msg.type !== "string") return;
    m.lastSeen = this.now();
    // Per-member ordering: a command older than one already applied is stale.
    if (msg.type !== "ping" && Number.isInteger(msg.cseq)) {
      if (msg.cseq <= (m.cseq || 0)) return;
      m.cseq = msg.cseq;
    }
    // Rate limit: a token bucket per member (pings exempt; 20 burst, 10/s).
    // Voice signalling has its own, larger bucket (see SIGNAL_BURST).
    if (msg.type === "vaud") {
      if (!this.allow(m, "aud", AUDIO_BURST, AUDIO_PER_S)) return;
    } else if (msg.type === "rtc" || msg.type === "voice") {
      if (!this.allow(m, "sig", SIGNAL_BURST, SIGNAL_PER_S)) return;
    } else if (msg.type !== "ping" && msg.type !== "status" && !this.allow(m)) return; // status is an idempotent overwrite (sent every tick)
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
        return this.pause(msg.pos, id);
      case "seek":
        return this.seek(msg.pos);
      case "rate":
        return this.setRate(msg.rate);
      case "leave":
        return this.leave(id);
      case "chat":
        return this.chat(m, msg.text);
      case "profile": // name + picture of the person on this device (sent on every connect, and when they switch profile)
        return this.profile(m, msg);
      case "end":
        return this.end(id);
      case "rtc": // voice: WebRTC offer/answer/ICE relayed to one member, never inspected
        if (typeof msg.to === "string" && this.members.get(msg.to)?.connected && msg.data && typeof msg.data === "object" && JSON.stringify(msg.data).length < 16_000)
          this.send(msg.to, { type: "rtc", from: id, data: msg.data });
        return;
      case "vaud": // relayed voice frame (no WebRTC link to someone): to everyone else, mic on only
        if (m.mic && typeof msg.d === "string" && msg.d.length < 4000) {
          const out = JSON.stringify({ type: "vaud", from: id, c: msg.c === "o" ? "o" : "m", s: Number.isInteger(msg.s) ? msg.s : 0, d: msg.d });
          const ids = [];
          for (const o of this.members.values()) if (o.connected && o.id !== id) ids.push(o.id);
          if (this.sendMany) this.sendMany(ids, out);
          else for (const o of ids) this.send(o, JSON.parse(out));
        }
        return;
      case "voice": // mic state + speaking indicator, fanned out to everyone
        {
          const micChanged = m.mic !== !!msg.mic;
          m.mic = !!msg.mic;
          m.speaking = !!msg.speaking && m.mic;
          this.fanout({ type: "voice", id, mic: m.mic, speaking: m.speaking });
          if (micChanged) this.broadcast(); // members[].mic tells every device whom to open voice to
        }
        return;
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
    if (m.ready && !m.buffering && this.media && m.rev === this.media.rev && m.epoch === this.epoch) m.synced = true;
    m.lastStatus = this.now();
    if (this.evaluate()) this.broadcast();
    else this.broadcastMembersIfChanged();
  }

  play(pos) {
    this.intent = "play";
    this.pausedBy = null;
    if (finite(pos) && this.playback.paused && Math.abs(pos - this.playback.pos) > 0.05) this.hold(Math.max(0, pos));
    this.evaluate();
    this.broadcast();
  }

  pause(pos, by = null) {
    this.intent = "pause";
    this.pausedBy = by;
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

  /** If `id` held the host role, pass it to the longest-standing connected member. */
  handoff(id) {
    if (this.hostId !== id) return;
    const next = this.connected.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))[0];
    this.hostId = next ? next.id : null;
  }

  /** Host only: ends the party for everyone. Returns true if it ended. */
  end(id) {
    if (id !== this.hostId) return false;
    this.ended = true;
    this.fanout({ type: "ended", reason: "host", by: id });
    return true;
  }

  allow(m, kind = "bucket", burst = RATE_BURST, perS = RATE_PER_S) {
    const now = this.now();
    const b = m[kind] || (m[kind] = { tokens: burst, at: now });
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perS);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  // ── Chat ────────────────────────────────────────────────────────────────
  chat(m, text) {
    if (typeof text !== "string") return;
    const clean = escapeHtml(text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, CHAT_MAX_LEN));
    if (!clean) return;
    const now = this.now();
    // Separate, stricter chat limit: CHAT_PER_10S messages per 10 s per member.
    m.chatTimes = (m.chatTimes || []).filter((t) => now - t < 10_000);
    if (m.chatTimes.length >= CHAT_PER_10S) return;
    m.chatTimes.push(now);
    this.chatSeq = (this.chatSeq || 0) + 1;
    // The picture travels with the message (so it stays after they leave),
    // except a data: thumbnail, which clients take from members[] instead
    // (kept out of the stored history to keep it small).
    const avatar = m.avatar && !m.avatar.startsWith("data:") ? m.avatar : null;
    const entry = { id: this.chatSeq, from: m.id, name: escapeHtml(m.name), avatar, text: clean, ts: now };
    this.chatLog = [...(this.chatLog || []), entry].slice(-CHAT_HISTORY);
    this.fanout({ type: "chat", ...entry });
  }

  profile(m, { name, avatar } = {}) {
    const n = cleanName(name) || m.name;
    const a = avatar === null ? null : cleanAvatar(avatar) ?? m.avatar ?? null;
    if (n === m.name && a === m.avatar) return;
    m.name = n;
    m.avatar = a;
    this.broadcast();
  }

  /** Recent chat for someone (re)joining. */
  sendChatHistory(id) {
    if (this.chatLog?.length) this.send(id, { type: "chat-history", messages: this.chatLog });
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
      if (!m.connected) continue; // dropped members are never waited on
      if (!this.playback.paused && !m.synced) continue; // late joiner catching up on its own
      const current = m.rev === this.media.rev && m.epoch === this.epoch;
      if (!current || !m.ready || m.buffering) out.push(m.id);
    }
    return out;
  }

  /** Applies the rules; true when the playback state changed. */
  evaluate() {
    if (!this.media || this.connected.length === 0) return false;
    const now = this.now();
    // A Pause tap or a phone that is buffering pauses the party; chat, the
    // keyboard or the app in the background never do. Once every phone is
    // buffered again at that frame, they all start back on the same instant.
    if (!this.playback.paused) {
      const stalled = this.connected.filter((m) => m.synced && m.buffering && m.rev === this.media.rev && m.epoch === this.epoch);
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
    // Start once everyone is buffered at the hold. Safety net: a phone stuck
    // for START_WAIT_MS (its stream died) is left to catch up on its own.
    const waiting = this.waitingOn();
    if (waiting.length) {
      const held = now - (this.playback.at || 0);
      const onFrame = (id) => {
        const m = this.members.get(id);
        return m && m.rev === this.media.rev && m.epoch === this.epoch && m.synced;
      };
      const stuckSeek = this.holdReason !== "buffering" && waiting.every(onFrame) && held >= SEEK_WAIT_MS;
      if (!stuckSeek && held < START_WAIT_MS) return false;
    }
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
      pausedBy: this.intent === "play" ? null : this.pausedBy || null,
      host: this.hostId || null,
      count: this.members.size,
      max: MAX_MEMBERS,
      waiting: this.waitingOn(),
      members: [...this.members.values()].map(({ id, platform, name, avatar, mic, connected, ready, buffering }) => ({
        id,
        platform,
        name,
        avatar: avatar || null,
        mic: !!mic && connected,
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
    this.fanout(this.view());
  }

  /** One message to every connected member, serialized once when the host supports it. */
  fanout(msg) {
    const ids = [];
    for (const m of this.members.values()) if (m.connected) ids.push(m.id);
    if (this.sendMany) return this.sendMany(ids, JSON.stringify(msg));
    for (const id of ids) this.send(id, msg);
  }

  membersSig() {
    return JSON.stringify([...this.members.values()].map((m) => [m.id, m.connected, m.ready, m.buffering]));
  }

  broadcastMembersIfChanged() {
    if (this.membersSig() !== this.lastMembersSig) this.broadcast();
  }
}
