// Super Player Watch Together: room server. One Durable Object per room
// (code -> idFromName(code)); each holds the room's WebSockets and its
// authoritative state (src/watch/roomCore.js, shared with the apps' tests).
//
//   POST /rooms                 -> { code }            create a room
//   GET  /rooms/:code           -> { exists, members } check a code
//   GET  /rooms/:code/ws?id=&platform=&name=           join (WebSocket)
//
//   POST /turn                  -> { iceServers }      voice: STUN + short-lived TURN credentials
//   POST /presence {token,tab,watching,platform[,leaving]} -> { online, watching, total, byPlatform[, token] }  live counter
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
    const body = request.method === "POST" ? (await request.text()).slice(0, 1024) : "";
    const res = await stub.fetch("https://presence/", {
      method: request.method === "POST" ? "POST" : "GET",
      body: body || undefined,
      // The counter limits per IP; only Cloudflare's own header is trusted.
      headers: { "x-client-ip": request.headers.get("cf-connecting-ip") || "unknown" },
    });
    return json(await res.json(), res.status);
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
// One object for the whole app: how many people have the app open right now
// (iPhone, Android, web) and how many people have used it in total.
//
// Identity: the first heartbeat from an install gets a server-signed user
// token (random id + issue time + HMAC with a key this object generated and
// keeps in its storage). The app keeps it (localStorage, plus the Keychain
// on iPhone, so it survives app updates and reinstalls there) and sends it
// with every heartbeat, so one person is one user however many tabs,
// reopens or updates. Tabs of one install share the token and send their own
// tab id: the person is online while any tab is.
//
// Anti-inflation: only server-issued, signature-checked tokens count;
// malformed or forged ones are ignored. New tokens are rate limited per IP,
// requests per IP are rate limited, at most PRESENCE_ONLINE_PER_IP people
// count as online from one IP, and an install only joins the all-time total
// once it has stayed open PRESENCE_TOTAL_AFTER_MS (a script minting tokens
// adds nothing). Online expires PRESENCE_TTL_MS after the last heartbeat
// (apps beat every 30 s; a closing tab says so at once).
export const PRESENCE_TTL_MS = 75_000;
export const PRESENCE_TOTAL_AFTER_MS = 20_000;
export const PRESENCE_TOKENS_PER_IP_HOUR = 30;
export const PRESENCE_REQ_PER_IP_MIN = 120;
export const PRESENCE_ONLINE_PER_IP = 50;
const PRESENCE_TABS_PER_USER = 8;
const PLATFORMS = ["ios", "android", "web"];
const TOKEN_RE = /^([A-Za-z0-9_-]{22})\.([0-9a-z]{6,12})\.([A-Za-z0-9_-]{22})$/;
const TAB_RE = /^[A-Za-z0-9_-]{6,40}$/;

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class Presence {
  constructor(state, env, { now = () => Date.now() } = {}) {
    this.state = state;
    this.now = now;
    this.online = new Map(); // uid -> { ip, tabs: Map(tab -> { at, watching, platform }) }
    this.ips = new Map(); // ip -> { at, req, tokens: number[] }
    this.counted = new Set(); // uids already in the total (cache of storage "u:<uid>")
    this.total = null;
    this.key = null;
  }

  async hmacKey() {
    if (this.key) return this.key;
    let raw = await this.state.storage.get("hmac");
    if (!raw) {
      raw = b64url(crypto.getRandomValues(new Uint8Array(32)));
      await this.state.storage.put("hmac", raw);
    }
    const bytes = Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (raw.length % 4)) % 4)), (c) => c.charCodeAt(0));
    this.key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return this.key;
  }

  async sign(uid, issued) {
    const mac = await crypto.subtle.sign("HMAC", await this.hmacKey(), new TextEncoder().encode(`${uid}.${issued}`));
    return b64url(mac).slice(0, 22);
  }

  async issue() {
    const uid = b64url(crypto.getRandomValues(new Uint8Array(16))).slice(0, 22);
    const issued = this.now().toString(36);
    return { uid, issuedAt: this.now(), token: `${uid}.${issued}.${await this.sign(uid, issued)}` };
  }

  /** { uid, issuedAt } for a genuine token, else null. */
  async verify(token) {
    const m = typeof token === "string" ? TOKEN_RE.exec(token) : null;
    if (!m) return null;
    const issuedAt = parseInt(m[2], 36);
    if (!Number.isFinite(issuedAt) || issuedAt > this.now() + 60_000) return null;
    const want = await this.sign(m[1], m[2]);
    // Constant-time compare.
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[3].charCodeAt(i);
    return diff === 0 ? { uid: m[1], issuedAt } : null;
  }

  ipState(ip) {
    const now = this.now();
    let s = this.ips.get(ip);
    if (!s || now - s.at > 60_000) {
      s = { at: now, req: 0, tokens: s?.tokens || [] };
      this.ips.set(ip, s);
    }
    s.tokens = s.tokens.filter((t) => now - t < 3_600_000);
    if (this.ips.size > 100_000) this.ips.clear();
    return s;
  }

  async loadTotal() {
    if (this.total === null) this.total = (await this.state.storage.get("total")) || 0;
    return this.total;
  }

  async countUser(uid) {
    if (this.counted.has(uid)) return;
    if (await this.state.storage.get(`u:${uid}`)) {
      this.counted.add(uid);
      return;
    }
    await this.loadTotal();
    this.total += 1;
    this.counted.add(uid);
    await this.state.storage.put({ [`u:${uid}`]: 1, total: this.total });
  }

  prune() {
    const cut = this.now() - PRESENCE_TTL_MS;
    for (const [uid, u] of this.online) {
      for (const [tab, t] of u.tabs) if (t.at < cut) u.tabs.delete(tab);
      if (!u.tabs.size) this.online.delete(uid);
    }
  }

  async counts() {
    this.prune();
    let watching = 0;
    const byPlatform = { ios: 0, android: 0, web: 0 };
    for (const u of this.online.values()) {
      const tabs = [...u.tabs.values()];
      if (tabs.some((t) => t.watching)) watching++;
      const latest = tabs.reduce((a, b) => (b.at > a.at ? b : a));
      byPlatform[latest.platform]++;
    }
    return { online: this.online.size, watching, total: await this.loadTotal(), byPlatform };
  }

  onlineFromIp(ip) {
    let n = 0;
    for (const u of this.online.values()) if (u.ip === ip) n++;
    return n;
  }

  async fetch(request) {
    const ip = (request.headers.get("x-client-ip") || "unknown").slice(0, 64);
    const reply = async (extra = {}, status = 200) =>
      new Response(JSON.stringify({ ...(await this.counts()), ...extra }), { status, headers: { "content-type": "application/json" } });
    if (request.method !== "POST") return reply();
    const lim = this.ipState(ip);
    if (++lim.req > PRESENCE_REQ_PER_IP_MIN) return reply({ limited: true }, 429);
    let b = {};
    try {
      const text = await request.text();
      if (text.length <= 1024) b = JSON.parse(text);
    } catch {}
    if (!b || typeof b !== "object") return reply({}, 400);
    const tab = typeof b.tab === "string" && TAB_RE.test(b.tab) ? b.tab : null;
    if (!tab) return reply({}, 400);
    let who = await this.verify(b.token);
    let issued = null;
    if (!who) {
      if (b.leaving) return reply();
      if (lim.tokens.length >= PRESENCE_TOKENS_PER_IP_HOUR) return reply({ limited: true }, 429);
      lim.tokens.push(this.now());
      who = await this.issue();
      issued = who.token;
    }
    const u = this.online.get(who.uid);
    if (b.leaving) {
      u?.tabs.delete(tab);
      if (u && !u.tabs.size) this.online.delete(who.uid);
      return reply();
    }
    if (!u && this.onlineFromIp(ip) >= PRESENCE_ONLINE_PER_IP) return reply(issued ? { token: issued } : {});
    const entry = u || { ip, tabs: new Map() };
    entry.ip = ip;
    if (entry.tabs.has(tab) || entry.tabs.size < PRESENCE_TABS_PER_USER)
      entry.tabs.set(tab, { at: this.now(), watching: b.watching === true, platform: PLATFORMS.includes(b.platform) ? b.platform : "web" });
    this.online.set(who.uid, entry);
    if (this.now() - who.issuedAt >= PRESENCE_TOTAL_AFTER_MS) await this.countUser(who.uid);
    return reply(issued ? { token: issued } : {});
  }
}
