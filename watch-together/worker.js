// Super Player Watch Together: room server. One Durable Object per room
// (code -> idFromName(code)); each holds the room's WebSockets and its
// authoritative state (src/watch/roomCore.js, shared with the apps' tests).
//
//   POST /rooms                 -> { code }            create a room
//   GET  /rooms/:code           -> { exists, members } check a code
//   GET  /rooms/:code/ws?id=&platform=&name=           join (WebSocket)
//
//   POST /turn                  -> { iceServers }      voice: STUN + short-lived TURN credentials
//   POST /presence {id,watching,platform} -> { online, watching, byPlatform }  live counter (heartbeat)
//   GET  /presence              -> same counts, read only
//
// Rooms are deleted EMPTY_ROOM_TTL_MS after the last person leaves.
// WebSockets use the Durable Object Hibernation API (state.acceptWebSocket):
// an idle room is evicted from memory while its sockets stay open, and it is
// rebuilt from storage on the next message. The member id rides in the
// socket's tag. A housekeeping alarm every SWEEP_MS evicts silent sockets
// (no ping for IDLE_EVICT_MS), frees seats whose grace ran out and deletes
// rooms that stayed empty.
import { RoomCore } from "../src/watch/roomCore.js";
import { makeCode, isValidCode, normalizeCode, EMPTY_ROOM_TTL_MS, RECONNECT_GRACE_MS, MAX_MEMBERS, fullMessage, IDLE_EVICT_MS } from "../src/watch/protocol.js";

export const SWEEP_MS = 10_000;
const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

export async function handle(request, env, fetchImpl = globalThis.fetch) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "superplayer-watch" });
  if (url.pathname === "/turn" && request.method === "POST") return json({ iceServers: await iceServers(env, fetchImpl) });
  if (url.pathname === "/presence" && env.PRESENCE) {
    const stub = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
    const body = request.method === "POST" ? await request.text() : "";
    const res = await stub.fetch("https://presence/", { method: request.method === "POST" ? "POST" : "GET", body: body || undefined });
    return json(await res.json());
  }
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

/**
 * Voice ICE servers. With Cloudflare Realtime TURN configured (worker secrets
 * TURN_KEY_ID + TURN_KEY_API_TOKEN) each call mints 24 h TURN credentials, so
 * phones behind strict / symmetric NATs still connect. Without them: STUN only.
 */
export async function iceServers(env, fetchImpl = globalThis.fetch) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN;
  try {
    const r = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: 86_400 }),
    });
    if (!r.ok) return STUN;
    const d = await r.json();
    const list = Array.isArray(d.iceServers) ? d.iceServers : d.iceServers ? [d.iceServers] : [];
    return list.length ? list : STUN;
  } catch {
    return STUN;
  }
}

const stubFor = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));

export default { fetch: (req, env) => handle(req, env) };

export class Room {
  constructor(state, env, { now = () => Date.now() } = {}) {
    this.state = state;
    this.env = env;
    this.now = now;
    this.core = null;
    this.loaded = false;
  }

  /** Open sockets for a member id (the Hibernation API keeps them across evictions). */
  socketsFor(id) {
    return this.state.getWebSockets(id);
  }

  socketOf(id) {
    return this.socketsFor(id).at(-1) || null;
  }

  idOf(ws) {
    return this.state.getTags?.(ws)?.[0] ?? ws.deserializeAttachment?.()?.id ?? null;
  }

  async load() {
    if (this.loaded) return this.core;
    this.loaded = true;
    const snap = await this.state.storage.get("room");
    if (snap) {
      this.core = this.makeCore(snap.code);
      this.core.restore(snap);
      this.core.emptySince = snap.emptySince ?? null;
      // Woken from hibernation: members whose socket is still open are still here.
      for (const m of this.core.members.values()) {
        if (this.socketsFor(m.id).length) Object.assign(m, { connected: true, droppedAt: null, lastSeen: this.now() });
      }
    }
    return this.core;
  }

  makeCore(code) {
    return new RoomCore({
      code,
      now: this.now,
      send: (id, msg) => this.sendTo(id, msg),
      // Serialize once, fan out the same frame to every socket.
      sendMany: (ids, frame) => {
        for (const id of ids) {
          try {
            this.socketOf(id)?.send(frame);
          } catch {}
        }
      },
    });
  }

  sendTo(id, msg) {
    const ws = this.socketOf(id);
    if (!ws) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  async save() {
    if (this.core) await this.state.storage.put("room", { ...this.core.snapshot(), emptySince: this.core.emptySince ?? null });
  }

  async armSweep() {
    const want = this.now() + SWEEP_MS;
    const cur = await this.state.storage.getAlarm?.();
    if (!cur || cur > want) await this.state.storage.setAlarm(want);
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.load();
    if (url.pathname === "/init") {
      if (this.core) return new Response("exists", { status: 409 });
      const { code } = await request.json();
      this.core = this.makeCore(code);
      this.core.emptySince = this.now();
      await this.save();
      await this.state.storage.setAlarm(this.now() + SWEEP_MS);
      return new Response("ok");
    }
    if (url.pathname === "/info") {
      return json({ exists: !!this.core, members: this.core ? this.core.connected.length : 0 });
    }
    return this.accept(url);
  }

  refuse(code, reason) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.close(code, reason);
    return new Response(null, { status: 101, webSocket: client });
  }

  async accept(url) {
    const id = (url.searchParams.get("id") || "").slice(0, 64);
    if (!this.core) return this.refuse(4404, "no such room");
    if (!id) return this.refuse(4400, "missing id");
    if (!this.core.members.has(id) && this.core.members.size >= MAX_MEMBERS) return this.refuse(4409, fullMessage()); // "Party is full (9/9)"
    // Same device reconnecting: the new socket replaces the old one.
    for (const old of this.socketsFor(id)) {
      try {
        old.close(4000, "replaced");
      } catch {}
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server, [id]);
    server.serializeAttachment?.({ id });
    this.core.join(id, { platform: url.searchParams.get("platform"), name: url.searchParams.get("name") });
    this.core.emptySince = null;
    await this.save();
    await this.armSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Hibernation API handlers ──────────────────────────────────────────
  async webSocketMessage(ws, data) {
    await this.load();
    const id = this.idOf(ws);
    if (!this.core || !id) return;
    if (this.socketOf(id) !== ws) return; // a replaced socket
    let msg;
    try {
      msg = JSON.parse(typeof data === "string" ? data : "");
    } catch {
      return;
    }
    // A socket the room had already let go (idle-evicted, seat expired): rejoin it.
    if (!this.core.members.get(id)?.connected && msg.type !== "leave") {
      if (!this.core.members.has(id) && this.core.members.size >= MAX_MEMBERS) return ws.close(4409, fullMessage());
      this.core.join(id, this.core.members.get(id) || {});
    }
    this.core.handle(id, msg);
    if (msg.type === "leave") return this.gone(id, ws, true);
    if (this.core?.ended) return this.endRoom();
    if (msg.type !== "ping" && msg.type !== "status") await this.save();
  }

  async webSocketClose(ws) {
    await this.load();
    const id = this.idOf(ws);
    if (id) await this.gone(id, ws, false);
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }

  async gone(id, ws, left) {
    try {
      ws.close(1000, "bye");
    } catch {}
    if (!this.core) return;
    const stillOpen = this.socketsFor(id).some((s) => s !== ws && s.readyState !== 3);
    if (stillOpen && !left) return; // replaced by a newer socket
    if (!left) this.core.drop(id);
    await this.afterChange();
  }

  async afterChange() {
    if (!this.core) return;
    if (this.core.empty && this.core.emptySince == null) this.core.emptySince = this.now();
    await this.save();
    await this.armSweep();
  }

  /** Host pressed End: close every socket (4410) and delete the room. */
  async endRoom() {
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.close(4410, "ended by host");
      } catch {}
    }
    this.core = null;
    await this.state.storage.deleteAll();
  }

  /** Housekeeping: idle sockets, expired seats, empty rooms. */
  async alarm() {
    await this.load();
    if (!this.core) {
      await this.state.storage.deleteAll();
      return;
    }
    for (const id of this.core.evictIdle()) {
      for (const ws of this.socketsFor(id)) {
        try {
          ws.close(4408, "idle");
        } catch {}
      }
    }
    this.core.prune();
    if (this.core.empty) {
      this.core.emptySince ??= this.now();
      if (this.now() - this.core.emptySince >= EMPTY_ROOM_TTL_MS) {
        this.core = null;
        await this.state.storage.deleteAll();
        return;
      }
    } else this.core.emptySince = null;
    await this.save();
    await this.state.storage.setAlarm(this.now() + SWEEP_MS);
  }
}


// ── Live counter ─────────────────────────────────────────────────────────
// One object for the whole app. Each open app (iPhone, Android, web) sends a
// heartbeat every PRESENCE_BEAT_MS with a random device id and whether a
// video is playing; anyone heard from in the last PRESENCE_TTL_MS counts.
// Only counts are kept: no names, no titles, nothing written to storage.
export const PRESENCE_TTL_MS = 75_000;
const PLATFORMS = ["ios", "android", "web"];
export class Presence {
  constructor(state, env, { now = () => Date.now() } = {}) {
    this.now = now;
    this.seen = new Map(); // id -> { at, watching, platform }
  }
  counts() {
    const cut = this.now() - PRESENCE_TTL_MS;
    let online = 0, watching = 0;
    const byPlatform = { ios: 0, android: 0, web: 0 };
    for (const [id, v] of this.seen) {
      if (v.at < cut) { this.seen.delete(id); continue; }
      online++;
      if (v.watching) watching++;
      byPlatform[v.platform]++;
    }
    return { online, watching, byPlatform };
  }
  async fetch(request) {
    if (request.method === "POST") {
      let b = {};
      try { b = JSON.parse(await request.text()); } catch {}
      const id = typeof b.id === "string" ? b.id.slice(0, 64) : "";
      if (/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
        if (b.leaving) this.seen.delete(id);
        else if (this.seen.has(id) || this.seen.size < 200_000) {
          this.seen.set(id, { at: this.now(), watching: !!b.watching, platform: PLATFORMS.includes(b.platform) ? b.platform : "web" });
        }
      }
    }
    return new Response(JSON.stringify(this.counts()), { headers: { "content-type": "application/json" } });
  }
}
