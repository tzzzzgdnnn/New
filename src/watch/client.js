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
  constructor({ url, clientId, platform, name, adapter, WebSocketImpl = globalThis.WebSocket, now = () => Date.now(), timers = globalThis, onState, onStatus }) {
    Object.assign(this, { url, clientId, platform, name, adapter, WebSocketImpl, now, timers, onState, onStatus });
    this.clock = new ClockSync();
    this.engine = new SyncEngine({ adapter, clock: this.clock, now, send: (m) => this.sendMsg(m) });
    this.state = null;
    this.ws = null;
    this.closed = false;
    this.retry = 0;
    this.connected = false;
    adapter.onIntent = (i) => this.intent(i);
  }

  connect() {
    if (this.closed) return;
    const q = new URLSearchParams({ id: this.clientId, platform: this.platform, name: this.name || "" });
    const ws = new this.WebSocketImpl(`${this.url}?${q}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
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
      if (e?.code === 4404 || e?.code === 4409) {
        this.closed = true;
        this.onStatus?.(e.code === 4404 ? "no-room" : "room-full");
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
    if (msg.type === "state") {
      const prev = this.state;
      this.state = msg;
      this.onState?.(msg, prev);
      this.engine.setRoom(msg);
    }
  }

  sendMsg(m) {
    if (this.ws && this.connected) {
      try {
        this.ws.send(JSON.stringify(m));
      } catch {}
    }
  }

  /** The person tapped play / pause / seek / speed on this device. */
  intent({ action, pos, rate }) {
    if (action === "play") this.sendMsg({ type: "play", pos });
    else if (action === "pause") this.sendMsg({ type: "pause", pos: Number.isFinite(pos) ? pos : this.engine.target() });
    else if (action === "seek" && Number.isFinite(pos)) this.sendMsg({ type: "seek", pos });
    else if (action === "rate" && Number.isFinite(rate)) this.sendMsg({ type: "rate", rate });
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
