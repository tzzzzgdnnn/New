// Movy (movy.sx) stream API, ported from its web player so the app gets the
// stream itself instead of loading the site. api.wecollege.net has one
// "/<provider>/sources" route per upstream (miami, berlin, ...). Answers are
// encrypted with a per-title seed from "/seed?mediaId=<tmdbId>": a base64url
// payload XOR a keystream from (seed, mediaId), starting with "mvm1".
// Pure logic, no DOM; the caller passes a GET (native HTTP on iOS).

export const MOVY_API = "https://api.wecollege.net";
export const MOVY_ORIGIN = "https://www.movy.sx";
export const MOVY_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
export const MOVY_HEADERS = {
  Accept: "application/json, text/plain, */*",
  Origin: MOVY_ORIGIN,
  Referer: MOVY_ORIGIN + "/",
  "User-Agent": MOVY_UA,
};
// The upstreams Movy's web player knows, for movies and series.
export const MOVY_PROVIDERS = [
  "miami", "atlanta", "austin", "berlin", "boise", "cancun", "chicago", "dallas", "delhi",
  "munich", "nashville", "oakland", "paris", "phoenix", "portland", "reno", "seattle", "vegas",
];

// ── Cipher: same logic as Movy's player (its minified helpers kept) ─────────
/* eslint-disable */
let d=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174],i=[109,118,109,49],r=e=>(e*(e+1)&1)==0;function o(e){return e>>>=0,e^=e>>>16,e=Math.imul(e,0x85ebca6b)>>>0,e^=e>>>13,e=Math.imul(e,0xc2b2ae35)>>>0,(e^=e>>>16)>>>0}function u(e,a){return(e>>>=0,0==(a&=31))?e>>>0:(e<<a|e>>>32-a)>>>0}
/** Keystream bytes for (seed, mediaId), `t` bytes long. */
const keystream = function(e,a,t){let s=function(e,a){let t;if(((t=e.length)*(t+1)&1)==1)return{S:function(e){let a=Array(256);for(let e=0;e<256;e++)a[e]=e;let t=0;for(let s=0;s<256;s++){t=t+a[s]+e.charCodeAt(s%e.length)&255;let n=a[s];a[s]=a[t],a[t]=n}return a}(e),acc:function(e){let a=0x67452301;for(let t=0;t<e.length;t++)a=u((a^Math.imul(e.charCodeAt(t),d[15&t]))>>>0,5);return o(a)}(e)};let s=Array(61),n=o(function(e){let a=0x811c9dc5;for(let t=0;t<e.length;t++)a=Math.imul(a^e.charCodeAt(t),0x1000193)>>>0;return o(a)}(e)^o(a>>>0^0x9e3779b9))>>>0;for(let e=0;e<8;e++)if(r(e)){let a=n%61;n=u(n+0x9e3779b9>>>0,7+(7&e)),s[a]=(n^o(n))>>>0,n=o(n+a>>>0)}else s[e]=d[15&e];return{S:s,acc:o(0xa5a5a5a5^n)>>>0}}(e,a),n=new Uint8Array(t),l=0;for(let e=0;e<t;){let a=function(e,a){var t,s;let n=e.S,l=e.acc,d=l%61,i=0-Number(d in n),r=n[d]>>>0,c=Math.imul(0x9e3779b9,a+1)>>>0,b=(((t=l)^(s=(r^c)>>>0))>>>0|(t&s&i)>>>0)>>>0;return l=o((b=(u(b+l>>>0,31&d)^u(l,31&Math.imul(d,7)))>>>0)+0x9e3779b9>>>0),n[d]=l>>>0,e.acc=l,l>>>0}(s,l++);n[e++]=255&a,e<t&&(n[e++]=a>>>8&255),e<t&&(n[e++]=a>>>16&255),e<t&&(n[e++]=a>>>24&255)}return n};
/* eslint-enable */
const HEADER = [109, 118, 109, 49]; // "mvm1"

const fromB64url = (s) => {
  const b = String(s).trim().replace(/^"|"$/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const p = b.padEnd(4 * Math.ceil(b.length / 4), "=");
  if (typeof atob === "function") {
    const bin = atob(p);
    const out = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
    return out;
  }
  return new Uint8Array(globalThis.Buffer.from(p, "base64"));
};
const utf8 = (bytes) =>
  typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8").decode(bytes) : globalThis.Buffer.from(bytes).toString("utf8");

/** Decrypt one answer. Throws on a wrong seed or a tampered payload. */
export function decodeMovy(payload, seed, mediaId) {
  const bytes = fromB64url(payload);
  const ks = keystream(String(seed), String(mediaId), bytes.length);
  for (let k = 0; k < bytes.length; k++) bytes[k] ^= ks[k];
  for (let k = 0; k < HEADER.length; k++) if (bytes[k] !== HEADER[k]) throw new Error("movy: decrypt failed");
  return utf8(bytes.subarray(HEADER.length));
}

/** Encrypt (tests only): the inverse of decodeMovy. */
export function encodeMovy(text, seed, mediaId) {
  const body = new TextEncoder().encode(text);
  const bytes = new Uint8Array(HEADER.length + body.length);
  bytes.set(HEADER);
  bytes.set(body, HEADER.length);
  const ks = keystream(String(seed), String(mediaId), bytes.length);
  for (let k = 0; k < bytes.length; k++) bytes[k] ^= ks[k];
  return globalThis.Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const qualityRank = (q) => {
  const s = String(q ?? "").toLowerCase();
  if (s === "auto" || s === "adaptive") return 10_000;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : s.includes("4k") ? 2160 : 0;
};

/** Best playable source from a decoded answer: an HLS master first, else the highest quality. */
export function pickMovySource(sources) {
  const list = (Array.isArray(sources) ? sources : [])
    .map((x) => (typeof x === "string" ? { url: x } : x))
    .map((x) => ({ ...x, url: x?.url || x?.file || x?.src || null }))
    .filter((x) => typeof x.url === "string" && /^https:\/\//.test(x.url));
  if (!list.length) return null;
  return list.sort((a, b) => {
    const ah = /\.m3u8(\?|$)/i.test(a.url) ? 1 : 0;
    const bh = /\.m3u8(\?|$)/i.test(b.url) ? 1 : 0;
    return bh - ah || qualityRank(b.quality) - qualityRank(a.quality);
  })[0];
}

/** Query string the web player sends (title is URI-encoded twice, as it does). */
export function movyParams(q) {
  const p = {
    title: encodeURIComponent(q.title || ""),
    mediaType: q.type === "tv" ? "tv" : "movie",
    year: q.year ?? "",
    tmdbId: q.tmdbId,
    imdbId: q.imdbId ?? "",
  };
  if (q.type === "tv") {
    p.seasonId = q.season ?? 1;
    p.episodeId = q.episode ?? 1;
    if (q.totalSeasons) p.totalSeasons = q.totalSeasons;
  }
  return p;
}

const qs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

/**
 * Resolve one title/episode. All providers are asked at once and the first
 * that answers with a stream wins (the rest are ignored), so the slowest
 * upstream never delays Play.
 * @param {(url: string, headers: object) => Promise<string>} http GET -> body text (throws on HTTP errors)
 * @param {{ type: "movie"|"tv", tmdbId: number, title?: string, year?: number|string,
 *           imdbId?: string, season?: number, episode?: number }} q
 * @returns {Promise<{ ok: true, source: string, provider: string, quality: string|null,
 *           subtitles: Array, ms: number }>}
 */
export async function resolveMovy(http, q, { providers = MOVY_PROVIDERS, now = Date.now } = {}) {
  if (!q?.tmdbId) throw new Error("movy: needs a TMDB id");
  const t0 = now();
  const seedRes = JSON.parse(await http(`${MOVY_API}/seed?mediaId=${encodeURIComponent(q.tmdbId)}`, MOVY_HEADERS));
  const seed = seedRes?.seed;
  if (!seed) throw new Error("movy: no seed");
  const params = qs({ ...movyParams(q), enc: "2", seed });
  const one = async (p) => {
    const body = await http(`${MOVY_API}/${p}/sources?${params}`, MOVY_HEADERS);
    const data = JSON.parse(decodeMovy(body, seed, q.tmdbId));
    const best = pickMovySource(data?.sources);
    if (!best) throw new Error(`movy ${p}: no source`);
    return {
      ok: true,
      source: best.url,
      provider: p,
      quality: best.quality ?? null,
      subtitles: Array.isArray(data.subtitles) ? data.subtitles : [],
      ms: now() - t0,
    };
  };
  return Promise.any(providers.map(one)).catch(() => {
    throw new Error("movy: no provider had this title");
  });
}
