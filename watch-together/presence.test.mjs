// Live counter (Presence object in worker.js): online now + total users,
// deduped per install, expiring, and hard to inflate.
import test from "node:test";
import assert from "node:assert/strict";
import { Presence, handle, PRESENCE_TTL_MS, PRESENCE_TOTAL_AFTER_MS, PRESENCE_TOKENS_PER_IP_HOUR, PRESENCE_ONLINE_PER_IP, PRESENCE_REQ_PER_IP_MIN } from "./worker.js";

function storage() {
  const m = new Map();
  return {
    m,
    async get(k) {
      return m.get(k);
    },
    async put(k, v) {
      if (typeof k === "object") for (const [a, b] of Object.entries(k)) m.set(a, b);
      else m.set(k, v);
    },
  };
}

function counter(t0 = 1_700_000_000_000) {
  const clock = { t: t0 };
  const st = storage();
  const p = new Presence({ storage: st }, {}, { now: () => clock.t });
  const beat = async (body, ip = "1.1.1.1") => {
    const r = await p.fetch(new Request("https://presence/", { method: "POST", body: JSON.stringify(body), headers: { "x-client-ip": ip } }));
    return { status: r.status, ...(await r.json()) };
  };
  return { p, clock, st, beat };
}

test("presence: one person = one user across tabs, reopens and updates; closed apps drop off", async () => {
  const { clock, beat } = counter();
  const first = await beat({ tab: "tab-aaaa1", platform: "ios" });
  assert.match(first.token, /^[A-Za-z0-9_-]{22}\.[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
  assert.equal(first.online, 1);
  assert.equal(first.total, 0, "not in the total until the app stayed open a moment");
  const token = first.token;
  // Second tab, same install.
  let r = await beat({ token, tab: "tab-bbbb2", platform: "web", watching: true });
  assert.equal(r.online, 1, "two tabs = one person");
  assert.equal(r.token, undefined, "no new token for a known install");
  clock.t += PRESENCE_TOTAL_AFTER_MS;
  r = await beat({ token, tab: "tab-aaaa1", platform: "ios" });
  assert.equal(r.total, 1);
  assert.equal(r.watching, 1);
  // One tab closes: still online through the other.
  r = await beat({ token, tab: "tab-aaaa1", leaving: true });
  assert.equal(r.online, 1);
  r = await beat({ token, tab: "tab-bbbb2", leaving: true });
  assert.equal(r.online, 0, "closed = gone at once");
  // Reopen / app update: same token, same user, total unchanged.
  clock.t += 3_600_000;
  r = await beat({ token, tab: "tab-cccc3", platform: "ios" });
  assert.deepEqual([r.online, r.total], [1, 1]);
  // Silent (killed app, no goodbye): expires.
  clock.t += PRESENCE_TTL_MS + 1;
  r = await beat({ token: "garbage", tab: "tab-dddd4", leaving: true });
  assert.equal(r.online, 0);
});

test("presence: counts every platform; reconnects / repeated beats never double count", async () => {
  const { clock, beat } = counter();
  const toks = {};
  for (const [who, plat, ip] of [["i", "ios", "10.0.0.1"], ["a", "android", "10.0.0.2"], ["w", "web", "10.0.0.3"]])
    toks[who] = (await beat({ tab: `tab-${who}xxxx`, platform: plat }, ip)).token;
  clock.t += PRESENCE_TOTAL_AFTER_MS;
  let r;
  for (let i = 0; i < 5; i++) for (const who of Object.keys(toks)) r = await beat({ token: toks[who], tab: `tab-${who}xxxx`, platform: { i: "ios", a: "android", w: "web" }[who] }, "10.0.0.9");
  assert.equal(r.online, 3);
  assert.equal(r.total, 3);
  assert.deepEqual(r.byPlatform, { ios: 1, android: 1, web: 1 });
});

test("presence: forged / malformed tokens and bodies are ignored; the total survives a restart", async () => {
  const { st, clock, beat } = counter();
  const { token } = await beat({ tab: "tab-real01" });
  clock.t += PRESENCE_TOTAL_AFTER_MS;
  await beat({ token, tab: "tab-real01" });
  const [uid, issued] = token.split(".");
  const forged = `${uid}.${issued}.${"A".repeat(22)}`;
  let r = await beat({ token: forged, tab: "tab-forge1" });
  assert.notEqual(r.token, forged, "a forged token is replaced, never trusted");
  for (const bad of [{ tab: "x" }, { token, tab: "<script>" }, { token, tab: 5 }]) assert.equal((await beat(bad)).status, 400);
  const big = await beat({ token, tab: "tab-real01", pad: "x".repeat(5000) });
  assert.equal(big.status, 400, "oversized body");
  // A fresh object (eviction / deploy) keeps the total and accepts old tokens.
  const p2 = new Presence({ storage: st }, {}, { now: () => clock.t });
  const res = await p2.fetch(new Request("https://presence/", { method: "POST", body: JSON.stringify({ token, tab: "tab-real01" }), headers: { "x-client-ip": "1.1.1.1" } }));
  r = await res.json();
  assert.equal(r.total, 1);
  assert.equal(r.token, undefined, "same signing key after restart");
});

test("presence: inflation limits (new tokens per IP, online per IP, requests per IP)", async () => {
  const { beat, clock } = counter();
  let issued = 0;
  for (let i = 0; i < PRESENCE_TOKENS_PER_IP_HOUR + 5; i++) if ((await beat({ tab: `tab-spam${i}` }, "6.6.6.6")).token) issued++;
  assert.equal(issued, PRESENCE_TOKENS_PER_IP_HOUR, "token minting is capped per IP");
  clock.t += 61_000;
  const r = await beat({ tab: "tab-check1" }, "7.7.7.7");
  assert.ok(r.online <= PRESENCE_TOKENS_PER_IP_HOUR + 1);
  assert.equal(r.total, 0, "minted-and-dropped tokens never reach the total");
  let limited = 0;
  for (let i = 0; i < PRESENCE_REQ_PER_IP_MIN + 10; i++) if ((await beat({ tab: "tab-flood1" }, "8.8.8.8")).status === 429) limited++;
  assert.ok(limited >= 10, "request flood is cut off");
  assert.ok(PRESENCE_ONLINE_PER_IP >= 20, "shared IPs (carrier NAT) still count real people");
});

test("worker /presence: passes Cloudflare's client IP, returns counts", async () => {
  const seen = [];
  const env = {
    PRESENCE: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (_u, init) => {
          seen.push(init.headers["x-client-ip"]);
          return new Response(JSON.stringify({ online: 1, watching: 0, total: 1, byPlatform: { ios: 1, android: 0, web: 0 } }));
        },
      }),
    },
  };
  const res = await handle(new Request("https://w/presence", { method: "POST", body: "{}", headers: { "cf-connecting-ip": "9.9.9.9", "x-client-ip": "spoof" } }), env);
  assert.equal((await res.json()).total, 1);
  assert.deepEqual(seen, ["9.9.9.9"], "only Cloudflare's header is trusted");
});
