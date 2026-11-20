// Flixer (flixer.gd / flixer.su / flixer.cx) stream API, taken from its web
// player (assets/client/tmdb-image-enhancer.js). The "images" route is really
// the source list: answers are encrypted, and the key and the decrypter come
// from Flixer's own WASM (assets/wasm/img_data*.{js,wasm}), which reads the
// page's window/navigator/screen/canvas, so it runs in the web view.
// Every request is signed: HMAC-SHA256(key, "key:serverTime:nonce:path").
// Pure logic; the caller passes the HTTP GET and the WASM loader.

// Its sites, in the order tried (the first to answer wins and is remembered).
export const FLIXER_DOMAINS = ["flixer.gd", "flixer.su", "flixer.cx"];
export const flixerApi = (domain) => `https://plsdontscrapemelove.${domain}`;
export const FLIXER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
// The site adds this header to every source request (its fetch wrapper).
const FINGERPRINT_LITE = "b4f8a1fc72e8O5d63e";
// Server codes as the site orders them; "alpha" serves a multi-quality HLS master.
export const FLIXER_ORDER = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

export const flixerPath = (q) =>
  q.type === "tv"
    ? `/api/tmdb/tv/${q.tmdbId}/season/${q.season ?? 1}/episode/${q.episode ?? 1}/images`
    : `/api/tmdb/movie/${q.tmdbId}/images`;

const b64 = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return typeof btoa === "function" ? btoa(s) : globalThis.Buffer.from(bytes).toString("base64");
};

/** HMAC-SHA256 signature the API checks, base64. */
export async function flixerSignature(key, ts, nonce, path) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`${key}:${ts}:${nonce}:${path}`))));
}

const nonce = () => {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return b64(a).replace(/[/+=]/g, "").substring(0, 22);
};

/** URL of the stream in one decrypted answer, or "". */
export function flixerUrl(data, server) {
  const s = data?.sources;
  if (Array.isArray(s)) {
    const hit = s.find((x) => x?.server?.toLowerCase?.() === server) || s.find((x) => x?.url);
    return typeof hit?.url === "string" ? hit.url.trim() : "";
  }
  const f = s?.file || s?.url;
  return typeof f === "string" ? f.trim() : "";
}

/**
 * Resolve one title/episode on one Flixer domain.
 * @param {(url: string, headers: object) => Promise<string>} http GET -> body text (throws on HTTP errors)
 * @param {{ key: string, decrypt: (text: string, key: string) => Promise<string>|string }} wasm
 * @returns {Promise<{ ok: true, source: string, server: string, domain: string, ms: number }>}
 */
export async function resolveFlixerOn(http, wasm, domain, q, { now = Date.now, preferWaitMs = 2500 } = {}) {
  if (!q?.tmdbId) throw new Error("flixer: needs a TMDB id");
  const t0 = now();
  const api = flixerApi(domain);
  const origin = `https://${domain}`;
  const path = flixerPath(q);
  const time = JSON.parse(await http(`${api}/api/time?t=${now()}`, { "User-Agent": FLIXER_UA, Origin: origin, Referer: origin + "/" }));
  const offset = Number(time?.timestamp) * 1000 - now();
  const headers = async (extra) => {
    const ts = Math.floor((now() + (Number.isFinite(offset) ? offset : 0)) / 1000);
    const n = nonce();
    return {
      Accept: "text/plain",
      "User-Agent": FLIXER_UA,
      Origin: origin,
      Referer: origin + "/",
      "x-fingerprint-lite": FINGERPRINT_LITE,
      "X-Api-Key": wasm.key,
      "X-Request-Timestamp": String(ts),
      "X-Request-Nonce": n,
      "X-Request-Signature": await flixerSignature(wasm.key, ts, n, path),
      "X-Client-Fingerprint": "sbios1",
      ...extra,
    };
  };
  const list = JSON.parse(await wasm.decrypt(await http(api + path, await headers({ bW90aGFmYWth: "1" })), wasm.key));
  let servers = Array.isArray(list?.sources) ? list.sources.map((s) => s?.server).filter(Boolean) : Object.keys(list?.servers || {});
  servers = [...FLIXER_ORDER.filter((s) => servers.includes(s)), ...servers.filter((s) => !FLIXER_ORDER.includes(s))];
  if (!servers.length) throw new Error("flixer: no servers for this title");
  const one = async (server) => {
    const body = await http(api + path, await headers({ "X-Only-Sources": "1", "X-Server": server }));
    const url = flixerUrl(JSON.parse(await wasm.decrypt(body, wasm.key)), server);
    if (!/^https:\/\//.test(url)) throw new Error(`flixer ${server}: no source`);
    return { ok: true, source: url, server, domain, ms: now() - t0 };
  };
  // All servers at once; the first in the site's order wins if it answers
  // within preferWaitMs of the first answer, else the first that answered.
  const tries = servers.map((s) => one(s));
  const first = await Promise.any(tries).catch(() => {
    throw new Error("flixer: no server had this title");
  });
  const settled = await Promise.race([
    Promise.allSettled(tries),
    new Promise((r) => setTimeout(() => r(null), preferWaitMs)),
  ]);
  if (!settled) return first;
  const ok = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  return ok.sort((a, b) => servers.indexOf(a.server) - servers.indexOf(b.server))[0] || first;
}

/** Try each domain in turn (the last that worked first). */
export async function resolveFlixer(http, loadWasm, q, { domains = FLIXER_DOMAINS, ...opts } = {}) {
  let lastErr = null;
  for (const d of domains) {
    try {
      const wasm = await loadWasm(d);
      return await resolveFlixerOn(http, wasm, d, q, opts);
    } catch (e) {
      lastErr = e;
      if (/no server had this title|no servers for this title/.test(String(e?.message))) throw e;
    }
  }
  throw lastErr || new Error("flixer: unreachable");
}
