// Room client: one WebSocket to the room, the shared clock, the sync engine.
// Platform-free (the WebSocket constructor and timers are injectable), so the
// iPhone app, the Android app, the web app and the tests all run this file.
import { ClockSync } from "./clock.js";
import { SyncEngine } from "./engine.js";

export const TICK_MS = 100;
export const PING_EVERY_MS = 4000;

export class WatchClient {
  /**
   * @param {object} o
   * @param {string} o.url        wss://…/rooms/CODE/ws
   * @param {string} o.clientId   stable per device (reconnects keep the seat)
   * @param {"ios"|"android"|"web"} o.platform
   * @param {object} o.adapter    player adapter (see engine.js)
   */
  constructor({ url, clientId, platform, name, adapter, WebSocketImpl = globalThis.WebSocket, now = () => Date.now(), timers = globalThis, onState, onStatus, onChat, onRtc, onVoice }) {
    Object.assign(this, { url, clientId, platform, name, adapter, WebSocketImpl, now, timers, onState, onStatus, onChat, onRtc, onVoice });
    this.clock = new ClockSync();
    this.engine = new SyncEngine({ adapter, clock: this.clock, now, send: (m) => this.sendMsg(m) });
    this.state = null;
    this.ws = null;
    this.closed = false;
    this.retry = 0;
    this.connected = false;
    this.cseq = 0; // per-client message sequence: the room drops anything older than what it already applied
    this.lastSeq = -1; // newest room state applied (stale / reordered states are ignored)
    this.pendingSeek = null; // a seek this device asked for that the room has not echoed yet
    adapter.onIntent = (i) => this.intent(i);
    // Native players push their state ~4x a second: step on each push too, so
    // sync keeps running when the page's own timers are throttled (Android
    // WebView behind the full-screen player, iPhone web view under its player).
    adapter.onPush = () => this.connected && this.engine.step();
  }

  connect() {
    if (this.closed) return;
    const q = new URLSearchParams({ id: this.clientId, platform: this.platform, name: this.name || "" });
    const ws = new this.WebSocketImpl(`${this.url}?${q}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.lastSeq = -1; // the room sends a full state on join: accept it whatever its seq
      this.cseq = 0;
      this.retry = 0;
      this.onStatus?.("connected");
      // A quick burst first so the clock is good before the first start.
      for (let i = 0; i < 6; i++) this.timers.setTimeout(() => this.ping(), i * 120);
      this.timers.clearInterval(this.pingTimer);
      this.pingTimer = this.timers.setInterval(() => this.ping(), PING_EVERY_MS);
      this.timers.clearInterval(this.tickTimer);
      this.tickTimer = this.timers.setInterval(() => this.engine.step(), TICK_MS);
    };
    ws.onmessage = (e) => this.receive(e.data);
    ws.onclose = (e) => {
      this.connected = false;
      this.timers.clearInterval(this.pingTimer);
      this.timers.clearInterval(this.tickTimer);
      if (this.closed) return;
      if (e?.code === 4410 || e?.code === 4411) {
        // 4410: host pressed End. 4411: peer-to-peer party whose host left / stayed unreachable.
        this.closed = true;
        this.ended = true;
        this.onStatus?.("ended", { reason: "host", message: e.code === 4411 ? e.reason || "The host left, so the party ended" : "The party was ended by the host" });
        return;
      }
      if (e?.code === 4404 || e?.code === 4409) {
        this.closed = true;
        this.onStatus?.(e.code === 4404 ? "no-room" : "room-full", { message: e.code === 4409 ? e.reason || "Party is full (9/9)" : "No party with that code" });
        return;
      }
      this.onStatus?.("reconnecting");
      const wait = Math.min(8000, 300 * 2 ** this.retry++);
      this.timers.setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => {};
  }

  ping() {
    this.sendMsg({ type: "ping", t0: this.now() });
  }

  receive(raw) {
    let msg;
    try {
      msg = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (msg.type === "pong") {
      this.clock.add(msg.t0, msg.ts, this.now());
      return;
    }
    if (msg.type === "ended") {
      this.ended = true;
      this.onStatus?.("ended", msg);
      this.close();
      return;
    }
    if (msg.type === "rtc") return void this.onRtc?.(msg);
    if (msg.type === "voice") return void this.onVoice?.(msg);
    if (msg.type === "chat") {
      this.chat = [...(this.chat || []), msg].slice(-50);
      this.onChat?.(this.chat, msg);
      return;
    }
    if (msg.type === "chat-history") {
      const seen = new Set((this.chat || []).map((c) => c.id));
      this.chat = [...(this.chat || []), ...(msg.messages || []).filter((c) => !seen.has(c.id))].sort((a, b) => a.id - b.id).slice(-50);
      this.onChat?.(this.chat, null);
      return;
    }
    if (msg.type === "state") {
      // A fresh room (new code / restart after eviction) restarts its seq; otherwise older states are stale.
      if (Number.isFinite(msg.seq) && this.state && msg.code === this.state.code && msg.seq <= this.lastSeq && !msg.resync) return;
      if (Number.isFinite(msg.seq)) this.lastSeq = msg.seq;
      if (this.pendingSeek && msg.playback && Math.abs(msg.playback.pos - this.pendingSeek.pos) < 0.05) this.pendingSeek = null;
      const prev = this.state;
      this.state = msg;
      this.onState?.(msg, prev);
      this.engine.setRoom(msg);
    }
  }

  sendMsg(m) {
    if (this.ws && this.connected) {
      try {
        if (m.type !== "ping") m = { ...m, cseq: ++this.cseq };
        this.ws.send(JSON.stringify(m));
      } catch {}
    }
  }

  /** The person tapped play / pause / seek / speed on this device. */
  intent({ action, pos, rate, key, stop }) {
    // Closing the player stops the party only while it is playing (closing
    // during a hold / a title switch is not a Pause).
    if (stop && (!this.state?.playback || this.state.playback.paused)) return;
    // A tap on a player still showing an older title (closing it while the
    // party switched) must not pause / seek the party's new title.
    if (key && this.state?.media?.key && key !== this.state.media.key) return;
    // Seek then Play (scrub, then tap play) go out back to back. The player has
    // not moved yet when Play is tapped, so its position is the old frame; Play
    // must carry the seek target or the room would jump back to where it was.
    if (action === "play") this.sendMsg({ type: "play", pos: this.pendingSeek ? this.pendingSeek.pos : pos });
    else if (action === "pause") this.sendMsg({ type: "pause", pos: Number.isFinite(pos) ? pos : this.engine.target() });
    else if (action === "seek" && Number.isFinite(pos)) {
      this.pendingSeek = { pos: Math.max(0, pos) };
      this.sendMsg({ type: "seek", pos });
    }
    else if (action === "rate" && Number.isFinite(rate)) this.sendMsg({ type: "rate", rate });
  }

  /** In-room chat. Text arrives HTML-escaped from the room: render it as text, never as HTML. */
  sendChat(text) {
    if (typeof text === "string" && text.trim()) this.sendMsg({ type: "chat", text: text.slice(0, 280) });
  }

  get isHost() {
    return !!this.state && this.state.host === this.clientId;
  }

  /** Host only (the room ignores anyone else): ends the party for everyone. */
  endParty() {
    this.sendMsg({ type: "end" });
  }

  pickMedia(media) {
    this.sendMsg({ type: "media", media });
  }

  shareStream(s) {
    this.sendMsg({ type: "stream", ...s });
  }

  leave() {
    this.sendMsg({ type: "leave" });
    this.close();
  }

  close() {
    this.closed = true;
    this.timers.clearInterval(this.pingTimer);
    this.timers.clearInterval(this.tickTimer);
    try {
      this.ws?.close(1000);
    } catch {}
  }
}
