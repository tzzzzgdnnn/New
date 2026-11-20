// Super Player web relay (Deno Deploy). The web app can't call the stream
// APIs the iPhone/Android apps call through native HTTP (they send no CORS
// headers, or want a Referer/Origin a browser can't set), so this does
// server-side exactly what the native apps already do, for an allowlist of
// those hosts only:
//
//   GET /health                      -> { ok: true }
//   GET /anipm?u=<url>&r=<referer>   ani.pm API (+ its player, embed.settlar.io), JSON
//                                    (same contract as watch-together/worker.js /anipm)
//   GET /relay?u=<url>[&r=<referer>] API GET to an allowlisted host with the headers
//                                    the native code sends (src/utils/servers/*.js);
//                                    a few signing headers are forwarded from the app (Flixer)
//   GET /media?u=<url>&p=<profile>[&s=<sig>]
//                                    media (playlists, segments, keys) with the Referer/Origin
//                                    the native player adds. Range passes through. HLS playlists
//                                    are rewritten so every URI in them comes back here, signed
//                                    (s = HMAC(RELAY_SECRET, profile|url)); unsigned URLs only on
//                                    the profile's known media hosts (+ RELAY_MEDIA_HOSTS).
//
// Nothing here solves captchas, defeats DRM or touches a site's bot checks:
// a host that answers 403 to the relay just answers 403 to the app.
//
// Env: RELAY_SECRET (signing key; set it in the Deno Deploy project),
//      RELAY_ORIGINS (extra allowed web origins, comma separated),
//      RELAY_MEDIA_HOSTS (extra "profile:host-suffix" pairs, comma separated).

const env = (k: string): string => {
  try {
    return Deno.env.get(k) ?? "";
  } catch {
    return "";
  }
};

export const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ── Web app origins (CORS) ────────────────────────────────────────────────
const ORIGINS = [
  "https://tzzzzgdnnn.github.io",
  "https://gdntzzzzz.github.io",
  "capacitor://localhost",
  "http://localhost",
  "https://localhost",
  ...env("RELAY_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean),
];
const originOk = (o: string | null) =>
  !!o && (ORIGINS.includes(o) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));

// Headers the app may send to /relay (Flixer's request signing). Everything
// else (Origin, Referer, User-Agent) is set here per host.
const FORWARD = [
  "accept",
  "range",
  "x-fingerprint-lite",
  "x-api-key",
  "x-request-timestamp",
  "x-request-nonce",
  "x-request-signature",
  "x-client-fingerprint",
  "x-only-sources",
  "x-server",
  "bw90agfmywth",
];

function cors(req: Request, extra: Record<string, string> = {}): Headers {
  const h = new Headers(extra);
  const o = req.headers.get("origin");
  h.set("access-control-allow-origin", originOk(o) ? o! : ORIGINS[0]);
  h.set("vary", "Origin");
  h.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  h.set("access-control-allow-headers", ["content-type", ...FORWARD].join(", "));
  h.set("access-control-expose-headers", "content-length, content-range, accept-ranges, content-type, x-relay-error");
  h.set("access-control-max-age", "86400");
  return h;
}

const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors(req, { "content-type": "application/json", "x-relay-error": status >= 400 ? String((body as { error?: string })?.error || "") : "" }) });

// ── API hosts: the requests src/utils/servers/*.js make ───────────────────
type Api = { re: RegExp; headers: (target: URL, r: string | null) => Record<string, string>; forward?: boolean };
const refIf = (r: string | null, ok: RegExp, dflt: string) => (r && ok.test(r) ? r : dflt);
export const APIS: Record<string, Api> = {
  // anipm.js: ani.pm API (Referer https://ani.pm/), then the settlar player session (Referer = the embed URL).
  anipm: {
    re: /^(?:[a-z0-9-]+\.)*ani\.pm$/i,
    headers: (_t, r) => ({ Accept: "application/json, text/plain, */*", Referer: refIf(r, /^https:\/\/([a-z0-9-]+\.)*ani\.pm\//i, "https://ani.pm/"), "User-Agent": UA }),
  },
  settlar: {
    re: /^(?:[a-z0-9-]+\.)*settlar\.io$/i,
    headers: (t, r) => ({ Accept: "application/json", Referer: refIf(r, /^https:\/\/([a-z0-9-]+\.)*settlar\.io\//i, `${t.origin}/`), "User-Agent": UA }),
  },
  // movy.js: Movy's stream API.
  movy: {
    re: /^api\.wecollege\.net$/i,
    headers: () => ({ Accept: "application/json, text/plain, */*", Origin: "https://www.movy.sx", Referer: "https://www.movy.sx/", "User-Agent": UA }),
  },
  // sevenmovies.js: Vidrift embed page (Referer 7movies.ac) and /api/source (Referer the embed page).
  sevenmovies: {
    re: /^embed\.vidrift\.net$/i,
    headers: (_t, r) => ({ Referer: refIf(r, /^https:\/\/(7movies\.ac|embed\.vidrift\.net)\//i, "https://7movies.ac/"), "User-Agent": UA }),
  },
  // flixer.js: its API + WASM assets, Origin/Referer = the Flixer site of that API host; signing headers forwarded.
  flixer: {
    re: /^plsdontscrapemelove\.flixer\.(gd|su|cx)$/i,
    headers: (t) => {
      const site = `https://${t.hostname.replace(/^plsdontscrapemelove\./i, "")}`;
      return { "User-Agent": UA, Origin: site, Referer: `${site}/` };
    },
    forward: true,
  },
  // rivestream.js: Rivestream's backendfetch.
  rive: {
    re: /^www\.rivestream\.app$/i,
    headers: () => ({ "User-Agent": UA, Accept: "application/json", Referer: "https://www.rivestream.app/" }),
  },
};
const apiFor = (host: string) => Object.entries(APIS).find(([, a]) => a.re.test(host));

// ── Media profiles: what the native players add (Referer = origin + "/", Origin = origin) ──
// hosts: where a first (unsigned) media URL may point. Anything a playlist
// links to is signed by the relay and needs no host match.
export const MEDIA: Record<string, { page?: string; hosts: string[] }> = {
  // media.settlar.io refuses Origin ani.pm ("origin-not-allowed"); its own player origin works.
  anipm: { page: "https://embed.settlar.io", hosts: ["settlar.io", "ani.pm"] },
  orion: { page: "https://embed.vidrift.net", hosts: ["vidrift.net"] },
  evion: { hosts: ["bigbang.observer", "vidrift.net"] },
  movy: { hosts: ["wecollege.net", "movy.sx"] },
  "flixer-gd": { page: "https://flixer.gd", hosts: ["flixer.gd"] },
  "flixer-su": { page: "https://flixer.su", hosts: ["flixer.su"] },
  "flixer-cx": { page: "https://flixer.cx", hosts: ["flixer.cx"] },
  rive: { page: "https://www.rivestream.app", hosts: ["ngcloud.tech", "hscow.com", "rivestream.app"] },
};
for (const pair of env("RELAY_MEDIA_HOSTS").split(",")) {
  const [p, h] = pair.split(":").map((s) => s?.trim());
  if (p && h && MEDIA[p]) MEDIA[p].hosts.push(h.replace(/^\*?\./, ""));
}
const hostIn = (host: string, list: string[]) => list.some((s) => host === s || host.endsWith("." + s));

// ── Signing (stateless, works across Deploy isolates) ─────────────────────
const SECRET = env("RELAY_SECRET") || "super-player-relay-dev-secret";
let keyP: Promise<CryptoKey> | null = null;
const key = () =>
  (keyP ??= crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
export async function sign(profile: string, url: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(`${profile}|${url}`)));
  let s = "";
  for (const b of mac.subarray(0, 18)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── HLS playlist rewriting ────────────────────────────────────────────────
export async function rewritePlaylist(text: string, base: string, profile: string, self: string): Promise<string> {
  const wrap = async (ref: string) => {
    let abs: string;
    try {
      abs = new URL(ref, base).href;
    } catch {
      return ref;
    }
    if (!/^https?:/.test(abs)) return ref; // data: / skd: keys stay as they are
    return `${self}/media?p=${encodeURIComponent(profile)}&u=${encodeURIComponent(abs)}&s=${await sign(profile, abs)}`;
  };
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) out.push(line);
    else if (t.startsWith("#")) {
      // URI="..." in EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA / EXT-X-I-FRAME-STREAM-INF / EXT-X-SESSION-KEY ...
      const m = /URI="([^"]+)"/.exec(t);
      out.push(m ? line.replace(m[0], `URI="${await wrap(m[1])}"`) : line);
    } else out.push(await wrap(t));
  }
  return out.join("\n");
}

const isPlaylist = (url: URL, ct: string) => /mpegurl/i.test(ct) || /\.m3u8?$/i.test(url.pathname);

// ── Upstream fetch ────────────────────────────────────────────────────────
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const PASS_BACK = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag", "cache-control"];

async function proxy(req: Request, target: URL, headers: Record<string, string>, fetchImpl: Fetch, timeoutMs: number) {
  const up = await fetchImpl(target.href, {
    method: req.method === "HEAD" ? "HEAD" : "GET",
    headers,
    redirect: "follow",
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  return up;
}

function parseTarget(raw: string | null): URL | null {
  try {
    const u = new URL(raw || "");
    return u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

export function makeHandler(fetchImpl: Fetch = fetch) {
  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    if (req.method !== "GET" && req.method !== "HEAD") return json(req, { error: "method" }, 405);
    const self = `${req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "")}://${req.headers.get("host") || url.host}`;
    try {
      if (url.pathname === "/" || url.pathname === "/health") return json(req, { ok: true, service: "super-player-relay", routes: ["/anipm", "/relay", "/media"] });

      // ── API relay ──
      if (url.pathname === "/anipm" || url.pathname === "/relay") {
        const target = parseTarget(url.searchParams.get("u"));
        if (!target) return json(req, { error: "bad url" }, 400);
        const hit = apiFor(target.hostname);
        if (!hit || (url.pathname === "/anipm" && hit[0] !== "anipm" && hit[0] !== "settlar")) return json(req, { error: "host not allowed" }, 403);
        const [name, api] = hit;
        const headers = api.headers(target, url.searchParams.get("r"));
        if (api.forward) for (const k of FORWARD) { const v = req.headers.get(k); if (v) headers[k === "bw90agfmywth" ? "bW90aGFmYWth" : k] = v; }
        else { const a = req.headers.get("accept"); if (a && !headers.Accept) headers.Accept = a; }
        const up = await proxy(req, target, headers, fetchImpl, 20_000);
        const h = cors(req, { "cache-control": name === "anipm" ? "public, max-age=300" : "no-store" });
        for (const k of ["content-type", "content-length"]) { const v = up.headers.get(k); if (v) h.set(k, v); }
        if (up.status >= 400) h.set("x-relay-error", `upstream ${up.status}`);
        return new Response(req.method === "HEAD" ? null : up.body, { status: up.status, headers: h });
      }

      // ── Media relay ──
      if (url.pathname === "/media") {
        const target = parseTarget(url.searchParams.get("u"));
        const profile = url.searchParams.get("p") || "";
        const prof = MEDIA[profile];
        if (!target || !prof) return json(req, { error: "bad url or profile" }, 400);
        const s = url.searchParams.get("s");
        const signed = !!s && s === (await sign(profile, target.href));
        if (!signed && !hostIn(target.hostname, prof.hosts)) return json(req, { error: `media host not allowed: ${target.hostname}` }, 403);
        const headers: Record<string, string> = { "User-Agent": UA, Accept: "*/*" };
        if (prof.page) { headers.Referer = prof.page + "/"; headers.Origin = prof.page; }
        for (const k of ["range", "if-range"]) { const v = req.headers.get(k); if (v) headers[k] = v; }
        const up = await proxy(req, target, headers, fetchImpl, 0);
        const ct = up.headers.get("content-type") || "";
        const h = cors(req);
        if (up.ok && isPlaylist(new URL(up.url || target.href), ct) && req.method === "GET") {
          const text = await up.text();
          if (/^\s*#EXTM3U/.test(text)) {
            const body = await rewritePlaylist(text, up.url || target.href, profile, self);
            h.set("content-type", "application/vnd.apple.mpegurl");
            h.set("cache-control", "no-store");
            return new Response(body, { status: 200, headers: h });
          }
          for (const k of PASS_BACK) { const v = up.headers.get(k); if (v && k !== "content-length") h.set(k, v); }
          return new Response(text, { status: up.status, headers: h });
        }
        for (const k of PASS_BACK) { const v = up.headers.get(k); if (v) h.set(k, v); }
        if (!h.has("accept-ranges")) h.set("accept-ranges", "bytes");
        if (up.status >= 400) h.set("x-relay-error", `upstream ${up.status}`);
        return new Response(req.method === "HEAD" ? null : up.body, { status: up.status, headers: h });
      }
      return json(req, { error: "not found" }, 404);
    } catch (e) {
      return json(req, { error: `relay: ${(e as Error)?.message || e}` }, 502);
    }
  };
}
