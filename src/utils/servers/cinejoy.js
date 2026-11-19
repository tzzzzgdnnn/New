// Cinejoy's stream API (api2.wing.st), the one cinejoy.pk's own player uses.
// Each request is sealed by the site's WASM module (crush.wasm: an ephemeral
// key exchange with the server's key) and POSTed to /g; the answer is
// AES-GCM encrypted with the per-request key the module hands back.
// Platform-neutral: the caller passes fetch. The API sends
// Access-Control-Allow-Origin: *, so plain fetch works in the app's web view.

export const CINEJOY_API = "https://api2.wing.st";
// English-audio upstreams, fastest first. (Warsaw/Munich/Paris are dubbed.)
export const CINEJOY_SERVERS = ["Light", "Nebula", "Sirius", "Rigel", "Polaris"];
const LABEL = "lumen-gate-v2";
const KEY = 32, KID = 1, PUB = 65, HEAD = KEY + KID + PUB, IV = 12, TAG = 16, NONCE = 44;

const enc = new TextEncoder();
const dec = new TextDecoder();
const buf = (u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);

let wasmPromise = null;
/** Load (once) and check the sealing module. `fresh` refetches it (key rotated). */
export function loadCinejoyWasm(fetchFn, fresh = false) {
  if (wasmPromise && !fresh) return wasmPromise;
  wasmPromise = (async () => {
    const r = await fetchFn(`${CINEJOY_API}/crush.wasm`, { cache: fresh ? "reload" : "no-cache" });
    if (!r.ok) throw new Error(`crush.wasm HTTP ${r.status}`);
    const { instance } = await WebAssembly.instantiate(await r.arrayBuffer(), {});
    const x = instance.exports;
    if (!(x.memory instanceof WebAssembly.Memory) || typeof x.alloc !== "function" || typeof x.seal_request !== "function") {
      throw new Error("crush.wasm: unexpected ABI");
    }
    return x;
  })();
  wasmPromise.catch(() => (wasmPromise = null));
  return wasmPromise;
}

/** Seal `{path, payload}`; returns the body to send and the key to open the answer. */
export function sealCinejoy(x, path, payload, random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const req = enc.encode(JSON.stringify({ path, payload: payload ?? null }));
  const nonce = random(NONCE);
  const cap = req.length + 512;
  const a = x.alloc(req.length), f = x.alloc(nonce.length), b = x.alloc(cap);
  try {
    if (!a || !f || !b) throw new Error("crush.wasm alloc failed");
    let mem = new Uint8Array(x.memory.buffer);
    mem.set(req, a);
    mem.set(nonce, f);
    const n = x.seal_request(a, req.length, f, nonce.length, b, cap);
    if (n <= HEAD || n > cap) throw new Error(`crush.wasm seal failed (${n})`);
    mem = new Uint8Array(x.memory.buffer);
    const out = mem.slice(b, b + n);
    return { responseKey: out.slice(0, KEY), keyId: out[KEY], pub: out.slice(KEY + KID, HEAD), body: out.slice(HEAD) };
  } finally {
    if (a) x.dealloc(a, req.length);
    if (f) x.dealloc(f, nonce.length);
    if (b) x.dealloc(b, cap);
  }
}

/** Open an encrypted answer: `{ status, data }`. */
export async function openCinejoy(bytes, sealed, subtle = crypto.subtle) {
  if (bytes.length < IV + TAG) throw new Error("cinejoy: malformed answer");
  const label = enc.encode(LABEL);
  const aad = new Uint8Array(label.length + 3 + sealed.pub.length);
  aad.set(label);
  aad.set([0, 2, sealed.keyId], label.length);
  aad.set(sealed.pub, label.length + 3);
  const key = await subtle.importKey("raw", buf(sealed.responseKey), "AES-GCM", false, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: buf(bytes.subarray(0, IV)), additionalData: buf(aad), tagLength: TAG * 8 }, key, buf(bytes.subarray(IV)));
  const env = JSON.parse(dec.decode(pt));
  if (!env || typeof env.status !== "number" || !("data" in env)) throw new Error("cinejoy: bad envelope");
  return env;
}

async function call(fetchFn, path, payload, retried = false) {
  const x = await loadCinejoyWasm(fetchFn, retried);
  const sealed = sealCinejoy(x, path, payload);
  const r = await fetchFn(`${CINEJOY_API}/g`, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: buf(sealed.body) });
  // 404 on /g = the server rotated its key: reload the module once, like the site.
  if (r.status === 404 && !retried) return call(fetchFn, path, payload, true);
  if (!r.ok) throw new Error(`cinejoy HTTP ${r.status}`);
  return openCinejoy(new Uint8Array(await r.arrayBuffer()), sealed);
}

/** The request one upstream gets for a movie or an episode. */
export function cinejoyRequest(server, q) {
  const p = { tmdb: String(q.tmdbId) };
  if (q.type === "tv") Object.assign(p, { season: String(q.season ?? 1), episode: String(q.episode ?? 1) });
  if (q.imdbId) p.imdb = q.imdbId;
  if (q.year) p.year = String(q.year);
  if (q.title) p.title = q.title;
  return { path: `/${server}/${q.type === "tv" ? "series" : "movie"}`, payload: p };
}

/** The HLS stream in an answer, or null. */
export function pickCinejoyStream(data) {
  const s = (data?.stream || []).find((x) => x && /^https:\/\//.test(x.playlist || ""));
  if (!s) return null;
  return {
    source: s.playlist,
    subtitles: (s.captions || []).filter((c) => c?.url).map((c) => ({ url: c.url, lang: c.language || c.id || "" })),
  };
}

/**
 * Ask every upstream at once; the first with a stream wins.
 * q: { type: "movie"|"tv", tmdbId, season?, episode?, imdbId?, year?, title? }
 */
export function resolveCinejoy(fetchFn, q, servers = CINEJOY_SERVERS, verify = null) {
  return new Promise((resolve, reject) => {
    let left = servers.length;
    const miss = () => --left === 0 && reject(new Error("cinejoy: no server has this title"));
    for (const server of servers) {
      const { path, payload } = cinejoyRequest(server, q);
      call(fetchFn, path, payload)
        .then((env) => {
          const hit = env.status >= 200 && env.status < 300 && pickCinejoyStream(env.data);
          if (!hit) return miss();
          if (!verify) return resolve({ ok: true, server, ...hit });
          // Only a playlist this browser can actually read counts.
          return Promise.resolve(verify(hit.source)).then(
            (good) => (good ? resolve({ ok: true, server, ...hit }) : miss()),
            miss,
          );
        })
        .catch(miss);
    }
  });
}
