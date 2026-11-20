// node --test dns-adblock/test.mjs : crafted DNS packets through the worker.
import test from "node:test";
import assert from "node:assert/strict";
import { parseQuery, isBlocked, buildBlockedResponse, parseBlocklist } from "./dns.js";
import { handle, UPSTREAM } from "./worker.js";
import { BLOCKLIST } from "./blocklist.js";
import { buildMobileconfig, PROFILE_UUID, PAYLOAD_UUID } from "./profile.js";

/** Craft a standard query: id, RD=1, one question, optional EDNS OPT record. */
function query(name, type, { id = 0xbeef, edns = true } = {}) {
  const parts = [id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, edns ? 1 : 0];
  for (const label of name.split(".")) {
    parts.push(label.length, ...Buffer.from(label, "ascii"));
  }
  parts.push(0, type >> 8, type & 0xff, 0, 1);
  if (edns) parts.push(0, 0, 41, 0x10, 0x00, 0, 0, 0, 0, 0, 0); // OPT, udp 4096
  return new Uint8Array(parts);
}
const b64url = (u8) => Buffer.from(u8).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const blockedHost = BLOCKLIST.find((h) => h === "doubleclick.net") || BLOCKLIST[0];
const noUpstream = () => {
  throw new Error("upstream must not be called for a blocked name");
};

test("blocklist is embedded from blocklist.txt", async () => {
  const { readFileSync } = await import("node:fs");
  const txt = parseBlocklist(readFileSync(new URL("./blocklist.txt", import.meta.url), "utf8"));
  assert.deepEqual(BLOCKLIST, txt);
  assert.equal(BLOCKLIST.length, 141);
});

test("parseQuery reads the crafted question", () => {
  const q = parseQuery(query("Ads.Example.COM", 1));
  assert.equal(q.name, "ads.example.com");
  assert.equal(q.type, 1);
  assert.equal(q.qclass, 1);
  assert.equal(q.id, 0xbeef);
  assert.equal(parseQuery(new Uint8Array(5)), null);
  assert.equal(parseQuery(new Uint8Array([0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c, 0, 1, 0, 1])), null);
});

test("isBlocked matches the host and its subdomains, not look-alikes", () => {
  const set = new Set(["ads.example.com"]);
  assert.ok(isBlocked("ads.example.com", set));
  assert.ok(isBlocked("x.y.ads.example.com.", set));
  assert.ok(!isBlocked("example.com", set));
  assert.ok(!isBlocked("badads.example.com", set));
});

for (const [type, len, zero] of [
  [1, 4, "0.0.0.0"],
  [28, 16, "::"],
]) {
  test(`blocked ${type === 1 ? "A" : "AAAA"} via GET ?dns= answers ${zero}, TTL 300, NOERROR`, async () => {
    const msg = query(`sub.${blockedHost}`, type);
    const res = await handle(new Request(`https://w.example/dns-query?dns=${b64url(msg)}`), noUpstream);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/dns-message");
    const r = new Uint8Array(await res.arrayBuffer());
    assert.equal((r[0] << 8) | r[1], 0xbeef, "id echoed");
    assert.ok(r[2] & 0x80, "QR set");
    assert.ok(r[2] & 0x01, "RD echoed");
    assert.ok(r[3] & 0x80, "RA set");
    assert.equal(r[3] & 0x0f, 0, "RCODE NOERROR");
    assert.equal((r[4] << 8) | r[5], 1, "QDCOUNT");
    assert.equal((r[6] << 8) | r[7], 1, "ANCOUNT");
    assert.equal((r[10] << 8) | r[11], 0, "ARCOUNT");
    const q = parseQuery(r);
    assert.equal(q.name, `sub.${blockedHost}`);
    let o = q.questionEnd;
    assert.deepEqual([...r.subarray(o, o + 2)], [0xc0, 0x0c], "answer name points at question");
    assert.equal((r[o + 2] << 8) | r[o + 3], type);
    assert.equal((r[o + 4] << 8) | r[o + 5], 1, "class IN");
    assert.equal(new DataView(r.buffer).getUint32(o + 6), 300, "TTL");
    assert.equal((r[o + 10] << 8) | r[o + 11], len);
    assert.deepEqual([...r.subarray(o + 12)], new Array(len).fill(0));
    assert.equal(r.length, o + 12 + len);
  });
}

test("blocked name via POST application/dns-message", async () => {
  const msg = query(blockedHost, 1, { id: 7 });
  const res = await handle(
    new Request("https://w.example/dns-query", { method: "POST", headers: { "content-type": "application/dns-message" }, body: msg }),
    noUpstream,
  );
  const r = new Uint8Array(await res.arrayBuffer());
  assert.equal((r[0] << 8) | r[1], 7);
  assert.equal((r[6] << 8) | r[7], 1);
});

test("blocked name, other type (HTTPS) gets NOERROR with no answer", () => {
  const msg = query(blockedHost, 65);
  const r = buildBlockedResponse(msg, parseQuery(msg));
  assert.equal(r[3] & 0x0f, 0);
  assert.equal((r[6] << 8) | r[7], 0);
});

test("allowed name via POST is forwarded raw to Cloudflare", async () => {
  const msg = query("example.org", 1);
  const fake = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  let seen;
  const upstream = async (url, init) => {
    seen = { url, init };
    return new Response(fake, { status: 200, headers: { "content-type": "application/dns-message", "cache-control": "max-age=42" } });
  };
  const res = await handle(
    new Request("https://w.example/dns-query", { method: "POST", headers: { "content-type": "application/dns-message" }, body: msg }),
    upstream,
  );
  assert.equal(seen.url, UPSTREAM);
  assert.equal(seen.init.method, "POST");
  assert.deepEqual([...new Uint8Array(seen.init.body)], [...msg], "raw message forwarded unchanged");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...fake]);
  assert.equal(res.headers.get("cache-control"), "max-age=42");
});

test("allowed name via GET is forwarded with the same ?dns=", async () => {
  const msg = query("example.org", 28);
  let seenUrl;
  const res = await handle(new Request(`https://w.example/dns-query?dns=${b64url(msg)}`), async (url) => {
    seenUrl = url;
    return new Response(new Uint8Array(12), { headers: { "content-type": "application/dns-message" } });
  });
  assert.equal(seenUrl, `${UPSTREAM}?dns=${b64url(msg)}`);
  assert.equal(res.status, 200);
});

test("bad requests are refused", async () => {
  assert.equal((await handle(new Request("https://w.example/dns-query"), noUpstream)).status, 400);
  assert.equal((await handle(new Request("https://w.example/dns-query?dns=***"), noUpstream)).status, 400);
  assert.equal(
    (await handle(new Request("https://w.example/dns-query", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }), noUpstream)).status,
    415,
  );
  assert.equal((await handle(new Request("https://w.example/dns-query", { method: "PUT" }), noUpstream)).status, 405);
});

test("profile is a DoH com.apple.dnsSettings.managed payload with stable UUIDs", async () => {
  const xml = buildMobileconfig("https://superplayer-dns.abc.workers.dev/dns-query");
  for (const s of [
    "<string>com.apple.dnsSettings.managed</string>",
    "<string>HTTPS</string>",
    "<string>https://superplayer-dns.abc.workers.dev/dns-query</string>",
    "<string>Super Player Ad Block</string>",
    "<string>com.superplayer.dnsadblock</string>",
    PROFILE_UUID,
    PAYLOAD_UUID,
  ])
    assert.ok(xml.includes(s), s);
  assert.equal(xml, buildMobileconfig("https://superplayer-dns.abc.workers.dev/dns-query"), "deterministic");
  const res = await handle(new Request("https://superplayer-dns.abc.workers.dev/profile.mobileconfig"), noUpstream);
  assert.equal(res.headers.get("content-type"), "application/x-apple-aspen-config");
  assert.ok((await res.text()).includes("https://superplayer-dns.abc.workers.dev/dns-query"));
});
