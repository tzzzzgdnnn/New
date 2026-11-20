// Super Player Watch Together: room server. One Durable Object per room
// (code -> idFromName(code)); each holds the room's WebSockets and its
// authoritative state (src/watch/roomCore.js, shared with the apps' tests).
//
//   POST /rooms                 -> { code }            create a room
//   GET  /rooms/:code           -> { exists, members } check a code
//   GET  /rooms/:code/ws?id=&platform=&name=           join (WebSocket)
//
// Rooms are deleted EMPTY_ROOM_TTL_MS after the last person leaves.
import { RoomCore } from "../src/watch/roomCore.js";
import { makeCode, isValidCode, normalizeCode, EMPTY_ROOM_TTL_MS, RECONNECT_GRACE_MS, MAX_MEMBERS } from "../src/watch/protocol.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

export async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "superplayer-watch" });
  if (url.pathname === "/rooms" && request.method === "POST") {
    for (let i = 0; i < 6; i++) {
      const code = makeCode();
      const res = await stubFor(env, code).fetch("https://room/init", { method: "POST", body: JSON.stringify({ code }) });
      if (res.status === 200) return json({ code });
    }
    return json({ error: "busy" }, 503);
  }
  const m = /^\/rooms\/([^/]+)(\/ws)?$/.exec(url.pathname);
  if (m) {
    const code = normalizeCode(decodeURIComponent(m[1]));
    if (!isValidCode(code)) return json({ error: "bad-code" }, 400);
    const stub = stubFor(env, code);
    if (m[2]) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected websocket" }, 426);
      return stub.fetch(request);
    }
    return stub.fetch("https://room/info");
  }
  return json({ error: "not-found" }, 404);
}

const stubFor = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));

export default { fetch: (req, env) => handle(req, env) };

export class Room {
  constructor(state, env, { now = () => Date.now(), timers = globalThis } = {}) {
    this.state = state;
    this.env = env;
    this.now = now;
    this.timers = timers;
    this.core = null;
    this.sockets = new Map(); // member id -> WebSocket
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this.core;
    this.loaded = true;
    const snap = await this.state.storage.get("room");
    if (snap) {
      this.core = this.makeCore(snap.code);
      this.core.restore(snap);
    }
    return this.core;
  }

  makeCore(code) {
    return new RoomCore({ code, now: this.now, send: (id, msg) => this.sendTo(id, msg) });
  }

  sendTo(id, msg) {
    const ws = this.sockets.get(id);
    if (!ws) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  async save() {
    if (this.core) await this.state.storage.put("room", this.core.snapshot());
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.load();
    if (url.pathname === "/init") {
      if (this.core) return new Response("exists", { status: 409 });
      const { code } = await request.json();
      this.core = this.makeCore(code);
      await this.save();
      await this.state.storage.setAlarm(this.now() + EMPTY_ROOM_TTL_MS);
      return new Response("ok");
    }
    if (url.pathname === "/info") {
      return json({ exists: !!this.core, members: this.core ? this.core.connected.length : 0 });
    }
    return this.accept(url);
  }

  accept(url) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const id = (url.searchParams.get("id") || "").slice(0, 64);
    if (!this.core) {
      server.close(4404, "no such room");
      return new Response(null, { status: 101, webSocket: client });
    }
    if (!id) {
      server.close(4400, "missing id");
      return new Response(null, { status: 101, webSocket: client });
    }
    const known = this.core.members.has(id);
    if (!known && this.core.members.size >= MAX_MEMBERS) {
      server.close(4409, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }
    // Same device reconnecting: the new socket replaces the old one.
    const old = this.sockets.get(id);
    this.sockets.set(id, server);
    if (old) {
      try {
        old.close(4000, "replaced");
      } catch {}
    }
    this.core.join(id, { platform: url.searchParams.get("platform"), name: url.searchParams.get("name") });
    this.save();
    server.addEventListener("message", (e) => {
      let msg;
      try {
        msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      } catch {
        return;
      }
      if (this.sockets.get(id) !== server) return;
      this.core.handle(id, msg);
      if (msg.type !== "ping" && msg.type !== "status") this.save();
      if (msg.type === "leave") this.gone(id, server, true);
    });
    const onClose = () => this.gone(id, server, false);
    server.addEventListener("close", onClose);
    server.addEventListener("error", onClose);
    return new Response(null, { status: 101, webSocket: client });
  }

  gone(id, server, left) {
    if (this.sockets.get(id) !== server) return;
    this.sockets.delete(id);
    if (!left) this.core.drop(id);
    try {
      server.close(1000, "bye");
    } catch {}
    this.timers.setTimeout(() => {
      this.core?.prune();
      this.afterChange();
    }, RECONNECT_GRACE_MS + 50);
    this.afterChange();
  }

  async afterChange() {
    await this.save();
    if (this.core?.empty) await this.state.storage.setAlarm(this.now() + EMPTY_ROOM_TTL_MS);
  }

  async alarm() {
    await this.load();
    if (this.core && !this.core.empty) return;
    this.core = null;
    this.sockets.clear();
    await this.state.storage.deleteAll();
  }
}
