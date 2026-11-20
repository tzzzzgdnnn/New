// Super Player ad-block DNS: a DNS-over-HTTPS (RFC 8484) endpoint for the iOS
// configuration profile. Names on the app's own ad/tracker list (or under one)
// resolve to 0.0.0.0 / ::; everything else is passed to Cloudflare's resolver.
import { BLOCKLIST } from "./blocklist.js";
import { parseQuery, isBlocked, buildBlockedResponse, base64UrlToBytes } from "./dns.js";
import { buildMobileconfig } from "./profile.js";

export const UPSTREAM = "https://cloudflare-dns.com/dns-query";
const DNS_MESSAGE = "application/dns-message";
const BLOCKED = new Set(BLOCKLIST);

const dnsResponse = (body, extra = {}) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": DNS_MESSAGE, "cache-control": "max-age=300", ...extra },
  });

/** Answer one DNS query (raw bytes): blocked locally or forwarded upstream. */
export async function resolve(msg, { method, dnsParam } = {}, fetchImpl = fetch) {
  const q = parseQuery(msg);
  if (q && isBlocked(q.name, BLOCKED)) {
    return dnsResponse(buildBlockedResponse(msg, q), { "x-superplayer-blocked": "1" });
  }
  const upstream =
    method === "GET" && dnsParam
      ? await fetchImpl(`${UPSTREAM}?dns=${dnsParam}`, { headers: { accept: DNS_MESSAGE } })
      : await fetchImpl(UPSTREAM, {
          method: "POST",
          headers: { "content-type": DNS_MESSAGE, accept: DNS_MESSAGE },
          body: msg,
        });
  const headers = { "content-type": upstream.headers.get("content-type") || DNS_MESSAGE };
  const cc = upstream.headers.get("cache-control");
  if (cc) headers["cache-control"] = cc;
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function handle(request, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname === "/profile.mobileconfig" || url.pathname === "/SuperPlayer-AdBlock.mobileconfig") {
    return new Response(buildMobileconfig(`${url.origin}/dns-query`), {
      headers: {
        "content-type": "application/x-apple-aspen-config",
        "content-disposition": 'attachment; filename="SuperPlayer-AdBlock.mobileconfig"',
      },
    });
  }
  if (url.pathname !== "/dns-query") {
    return new Response(`Super Player ad-block DNS. ${BLOCKED.size} hosts blocked. DoH endpoint: /dns-query\n`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (request.method === "GET") {
    const dnsParam = url.searchParams.get("dns");
    const msg = base64UrlToBytes(dnsParam);
    if (!msg || msg.length < 12) return new Response("Missing or invalid ?dns= parameter\n", { status: 400 });
    return resolve(msg, { method: "GET", dnsParam }, fetchImpl);
  }
  if (request.method === "POST") {
    const ct = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (ct !== DNS_MESSAGE) return new Response("Content-Type must be application/dns-message\n", { status: 415 });
    const msg = new Uint8Array(await request.arrayBuffer());
    if (msg.length < 12 || msg.length > 65535) return new Response("Invalid DNS message\n", { status: 400 });
    return resolve(msg, { method: "POST" }, fetchImpl);
  }
  return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, POST" } });
}

export default {
  fetch: (request) => handle(request),
};
