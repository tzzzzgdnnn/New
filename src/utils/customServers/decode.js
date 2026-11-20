// Site adder: find the video a player page hides. Pure logic (no DOM, no
// network), so Node tests run it (scripts/test-custom-servers.mjs).
//
// Players hide their stream link in many ways. decodeLayers() peels them
// layer by layer (up to MAX_DEPTH): Dean Edwards' packer
// (`eval(function(p,a,c,k,e,d)…)`, nested), atob/base64, rot13, hex / \u /
// char-code strings, reversed strings, JSON.parse('…') and %-encoding.
// findMediaUrls() then reads stream links out of every layer: plain URLs,
// player setups (JWPlayer, Video.js, Plyr, Clappr, DPlayer, Artplayer,
// Playerjs, hls.js) and JSON-in-script source lists.
//
// DRM: isProtectedManifest() spots FairPlay / Widevine / PlayReady streams so
// the adder refuses them. Standard HLS AES-128 is not DRM: its key is a plain
// URL the player fetches with the page's headers (aesKeyUris()).

/** Layers deep the decoder goes (a packer inside base64 inside a packer…). */
export const MAX_DEPTH = 5;
/** Texts bigger than this are cut before decoding (pages can be huge). */
const MAX_TEXT = 3_000_000;
/** At most this many decoded layers are kept (stops runaway inputs). */
const MAX_LAYERS = 400;

const MEDIA_EXT = "m3u8|mp4|mpd|webm|m4v";
const MEDIA_RE = new RegExp(`\\.(?:${MEDIA_EXT})(?:[?#]|$)`, "i");

// ── Packer ───────────────────────────────────────────────────────────────

/** Read a JS string literal body (between its quotes) as its value. */
export function unescapeJs(s) {
  return String(s).replace(/\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|[0-7]{1,3}|.)/gs, (all, e) => {
    if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === "u") return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ""), 16));
    if (/^[0-7]+$/.test(e)) return e === "0" ? "\0" : String.fromCharCode(parseInt(e, 8));
    return { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" }[e] ?? e;
  });
}

const STR = (q) => `${q}((?:\\\\.|(?!${q})[^\\\\])*)${q}`;
const PACKED_RE = new RegExp(
  "eval\\s*\\(\\s*function\\s*\\(\\s*p\\s*,\\s*a\\s*,\\s*c\\s*,\\s*k\\s*,\\s*e\\s*,\\s*[dr]\\s*\\)[\\s\\S]*?\\}\\s*\\(\\s*" +
    `(?:${STR("'")}|${STR('"')})` +
    "\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*" +
    `(?:${STR("'")}|${STR('"')})` +
    "\\s*\\.split\\(\\s*['\"]\\|['\"]\\s*\\)",
  "g",
);

/** Packer word -> index ("a" -> 10, "Z" -> 61, "1a" -> radix * 1 + 10). */
function unbase(word, radix) {
  let n = 0;
  for (const ch of word) {
    const c = ch.charCodeAt(0);
    const d = c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 122 ? c - 87 : c >= 65 && c <= 90 ? c - 29 : -1;
    if (d < 0 || d >= Math.max(radix, 1)) return -1;
    n = n * radix + d;
  }
  return n;
}

/** Undo one `eval(function(p,a,c,k,e,d){…}(…))` packer call. */
export function unpackOne(payload, radix, count, keywords) {
  const words = keywords.split("|");
  return payload.replace(/\b\w+\b/g, (w) => {
    const i = unbase(w, radix);
    return i >= 0 && i < count && words[i] ? words[i] : w;
  });
}

/** Every packer call in `text`, unpacked. */
export function unpackAll(text) {
  const out = [];
  for (const m of String(text).matchAll(PACKED_RE)) {
    const payload = unescapeJs(m[1] ?? m[2] ?? "");
    const words = unescapeJs(m[5] ?? m[6] ?? "");
    out.push(unpackOne(payload, Number(m[3]), Number(m[4]), words));
  }
  return out;
}

/** Whether `text` holds a packer call. */
export const isPacked = (text) => new RegExp(PACKED_RE.source).test(String(text));

// ── Other encodings ─────────────────────────────────────────────────────

const atobSafe = (s) => {
  try {
    const clean = String(s).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = clean + "===".slice((clean.length + 3) % 4);
    const bin = typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("binary");
    // UTF-8 when it is valid UTF-8, else the raw bytes.
    try {
      return decodeURIComponent(escape(bin));
    } catch {
      return bin;
    }
  } catch {
    return null;
  }
};

/** Mostly printable text (decoded base64 that is not just bytes). */
const printable = (s) => !!s && s.length >= 4 && (s.match(/[\x20-\x7e\n\r\t]/g) || []).length / s.length > 0.95;

/** Whether a decoded string is worth keeping as a new layer. */
const useful = (s) => printable(s) && /https?:|\/\/|\.m3u8|\.mp4|\.mpd|\.webm|sources?|file|eval\(|atob|[{[]/i.test(s);

export const rot13 = (s) =>
  String(s).replace(/[a-z]/gi, (c) => {
    const b = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
  });

const reverse = (s) => [...String(s)].reverse().join("");

/** One pass of every decoder over `text`: the new texts it reveals. */
export function decodeOnce(text) {
  const t = String(text).slice(0, MAX_TEXT);
  const out = [];
  const add = (s) => {
    if (s && s !== t && s.length > 3) out.push(s);
  };
  // Packer.
  for (const u of unpackAll(t)) add(u);
  // atob("…") / Base64.decode("…") / base64_decode and bare base64 strings
  // that decode to something link-like.
  for (const m of t.matchAll(/(?:atob|base64_?decode|Base64\.decode|decodeBase64|b64d(?:ecode)?)\s*\(\s*(["'`])([A-Za-z0-9+/=_\-\s]{8,})\1\s*\)/gi)) {
    add(atobSafe(m[2]));
  }
  for (const m of t.matchAll(/(["'`])([A-Za-z0-9+/_-]{16,}={0,2})\1/g)) {
    const d = atobSafe(m[2]);
    if (useful(d)) add(d);
  }
  // data-* attributes and hash fragments holding base64 links.
  for (const m of t.matchAll(/=\s*["']?([A-Za-z0-9+/]{20,}={0,2})["'\s>&]/g)) {
    const d = atobSafe(m[1]);
    if (useful(d) && /https?:|\/\//.test(d)) add(d);
  }
  // \x68\x74 / \u0068 escapes inside strings.
  if (/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/i.test(t)) {
    for (const m of t.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})(?:\\.|(?!\1)[^\\])*)\1/g)) add(unescapeJs(m[2]));
  }
  // String.fromCharCode(104, 116, …) (decimal or hex numbers).
  for (const m of t.matchAll(/String\.fromCharCode\s*\(\s*((?:0x[0-9a-f]+|\d+)(?:\s*,\s*(?:0x[0-9a-f]+|\d+))*)\s*\)/gi)) {
    add(String.fromCharCode(...m[1].split(",").map((n) => Number(n.trim()))));
  }
  // [104,116,116,112,…] arrays mapped through fromCharCode.
  for (const m of t.matchAll(/\[\s*((?:\d{2,3}\s*,\s*){8,}\d{2,3})\s*\]\s*\.map\([^)]*fromCharCode/gi)) {
    add(String.fromCharCode(...m[1].split(",").map(Number)));
  }
  // "…".split("").reverse().join("") and reversed links ("8u3m.…//:sptth").
  for (const m of t.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*\.split\(\s*(["'])\3\s*\)\s*\.reverse\(\)\s*\.join\(\s*(["'])\4\s*\)/g)) add(reverse(unescapeJs(m[2])));
  for (const m of t.matchAll(/(["'`])([^"'`\s]*\/\/:s?ptth[^"'`\s]*)\1/g)) add(reverse(m[2]));
  // rot13 strings that turn into links ("uggcf://").
  for (const m of t.matchAll(/(["'`])([^"'`\s]*uggcf?:\/\/[^"'`\s]*)\1/g)) add(rot13(m[2]));
  for (const m of t.matchAll(/(?:rot13|str_rot13)\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g)) add(rot13(unescapeJs(m[2])));
  // JSON.parse('…') and decodeURIComponent('%68…') / unescape('%68…').
  for (const m of t.matchAll(/JSON\.parse\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g)) add(unescapeJs(m[2]));
  for (const m of t.matchAll(/(?:decodeURIComponent|unescape|decodeURI)\s*\(\s*(["'`])((?:%[0-9a-f]{2}|[^"'`%]){6,})\1\s*\)/gi)) {
    try {
      add(decodeURIComponent(m[2]));
    } catch {
      // Not valid %-encoding: leave it.
    }
  }
  return out;
}

/**
 * Peel every layer of encoding off `text`: the text itself first, then each
 * decoded layer, up to `depth` levels (nested packers, base64 in a packer…).
 */
export function decodeLayers(text, depth = MAX_DEPTH) {
  const seen = new Set();
  const layers = [];
  let frontier = [String(text || "")];
  for (let d = 0; d <= depth && frontier.length && layers.length < MAX_LAYERS; d++) {
    const next = [];
    for (const t of frontier) {
      if (seen.has(t)) continue;
      seen.add(t);
      layers.push(t);
      if (d < depth) next.push(...decodeOnce(t));
    }
    frontier = next;
  }
  return layers;
}

// ── Player setups ───────────────────────────────────────────────────────

/** The balanced `(…)`, `{…}` or `[…]` starting at `i` (strings skipped), or null. */
export function balanced(text, i) {
  const open = text[i];
  const close = { "(": ")", "{": "}", "[": "]" }[open];
  if (!close) return null;
  const stack = [];
  for (let j = i; j < text.length && j - i < 400_000; j++) {
    const c = text[j];
    if (c === '"' || c === "'" || c === "`") {
      for (j++; j < text.length && text[j] !== c; j++) if (text[j] === "\\") j++;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") stack.push(c);
    else if (c === ")" || c === "}" || c === "]") {
      stack.pop();
      if (!stack.length) return text.slice(i, j + 1);
    }
  }
  return null;
}

const PLAYER_CALLS = [
  ["jwplayer", /jwplayer\s*\([^)]*\)\s*\.setup\s*\(/g],
  ["videojs", /videojs\s*\([^)]*?(?=[,)])/g],
  ["videojs", /\.src\s*\(\s*(?=[{[])/g],
  ["plyr", /new\s+Plyr\s*\(/g],
  ["plyr", /\.source\s*=\s*(?=\{)/g],
  ["clappr", /new\s+Clappr\.Player\s*\(/g],
  ["dplayer", /new\s+DPlayer\s*\(/g],
  ["artplayer", /new\s+Artplayer\s*\(/g],
  ["playerjs", /new\s+Playerjs\s*\(/g],
  ["hlsjs", /\.loadSource\s*\(/g],
  ["sources", /\b(?:sources|playlist|video_sources|videoSources|streams)\s*[:=]\s*(?=\[)/g],
];

/**
 * Player setup calls in a script: [{ player, config }]. `config` is the
 * argument text (an object / array literal or a string).
 */
export function extractPlayerConfigs(text) {
  const t = String(text || "");
  const out = [];
  for (const [player, re] of PLAYER_CALLS) {
    for (const m of t.matchAll(re)) {
      let at = m.index + m[0].length;
      while (/\s/.test(t[at] || "")) at++;
      if (t[at - 1] === "(" && /[{["'`]/.test(t[at] || "") === false && t[at] !== "(") {
        // videojs('id', {…}): skip to the options object.
        const brace = t.indexOf("{", at);
        if (brace < 0 || brace - at > 200) continue;
        at = brace;
      }
      if (t[at - 1] === "(" && t[at] !== "{" && t[at] !== "[") {
        const q = t[at];
        if (q === '"' || q === "'" || q === "`") {
          const end = t.indexOf(q, at + 1);
          if (end > at) out.push({ player, config: t.slice(at, end + 1) });
        }
        continue;
      }
      const cfg = balanced(t, at);
      if (cfg) out.push({ player, config: cfg });
    }
  }
  return out;
}

// ── Stream links ────────────────────────────────────────────────────────

/** "hls" | "mp4" | "dash" | "webm" | null for a link. */
export function mediaKind(url) {
  const l = String(url || "").toLowerCase();
  if (/\.m3u8(?:[?#]|$)|mpegurl|\/m3u8\b/.test(l)) return "hls";
  if (/\.mpd(?:[?#]|$)/.test(l)) return "dash";
  if (/\.(?:mp4|m4v)(?:[?#]|$)/.test(l)) return "mp4";
  if (/\.webm(?:[?#]|$)/.test(l)) return "webm";
  return null;
}

const abs = (u, base) => {
  try {
    return new URL(u, base || undefined).href;
  } catch {
    return null;
  }
};

const LABEL_RE = /["']?(?:label|quality|res|name|title)["']?\s*:\s*["']?([^"',}]{1,24})/i;
const VALUE_KEYS = "file|src|source|url|hls\\d*|dash|mp4|stream|streamUrl|stream_url|video|videoUrl|video_url|playlist|contentUrl|embedUrl|link|m3u8";

/**
 * Stream links in a page or script, decoded through every layer.
 * @returns {{ url: string, kind: string, label: string|null, player: string|null }[]}
 *   best first: HLS masters, other HLS, MP4, WebM, then DASH (not playable on iPhone).
 */
export function findMediaUrls(text, base) {
  const found = new Map();
  const add = (raw, label = null, player = null) => {
    const clean = String(raw).trim().replace(/\\\//g, "/").replace(/&amp;/g, "&");
    if (/^(?:blob|data|javascript):/i.test(clean)) return;
    const u = abs(clean, base);
    if (!u || !/^https?:/i.test(u)) return;
    const kind = mediaKind(u);
    if (!kind) return;
    if (/\.(?:ts|m4s|jpg|png|vtt|srt)(?:[?#]|$)/i.test(u)) return;
    const prev = found.get(u);
    if (!prev) found.set(u, { url: u, kind, label: label?.trim() || null, player });
    else {
      prev.label ??= label?.trim() || null;
      prev.player ??= player;
    }
  };
  for (const layer of decodeLayers(text)) {
    const s = layer.replace(/\\\//g, "/").replace(/\\u002[fF]/g, "/");
    // Player setups first, so their links carry the player and label.
    for (const { player, config } of extractPlayerConfigs(s)) {
      const c = config.replace(/\\\//g, "/");
      for (const m of c.matchAll(/\{[^{}]*\}/g)) {
        const v = new RegExp(`["']?(?:${VALUE_KEYS})["']?\\s*:\\s*["'\`]([^"'\`]+)["'\`]`, "i").exec(m[0]);
        if (v) add(v[1], LABEL_RE.exec(m[0])?.[1], player);
      }
      for (const m of c.matchAll(/["'`]((?:https?:)?\/\/[^"'`\s]+|\/[^"'`\s]+)["'`]/g)) if (MEDIA_RE.test(m[1])) add(m[1], null, player);
    }
    // key: "link" pairs anywhere (JSON-in-script, config objects).
    for (const m of s.matchAll(new RegExp(`["']?(?:${VALUE_KEYS})["']?\\s*[:=]\\s*["'\`]([^"'\`\\s]+)["'\`]`, "gi"))) {
      if (MEDIA_RE.test(m[1]) || /mpegurl/i.test(m[1])) add(m[1]);
    }
    // <source src=…> / <video src=…>.
    for (const m of s.matchAll(/<(?:source|video)\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
      add(m[1], /\b(?:label|size|res|title)\s*=\s*["']([^"']+)/i.exec(m[0])?.[1]);
    }
    // Plain links.
    for (const m of s.matchAll(new RegExp(`(?:https?:)?\\/\\/[^\\s"'<>\`\\\\()]+?\\.(?:${MEDIA_EXT})(?:\\?[^\\s"'<>\`\\\\()]*)?(?=[\\s"'<>\`\\\\(),;]|$)`, "gi"))) add(m[0]);
  }
  const rank = (x) => {
    const l = x.url.toLowerCase();
    const k = { hls: 0, mp4: 2, webm: 3, dash: 4 }[x.kind] ?? 5;
    return k * 10 + (x.kind === "hls" && /master|playlist|index/.test(l) ? 0 : 1) + (/\b(?:ad|ads|preroll|vast|trailer)\b/.test(l) ? 50 : 0);
  };
  return [...found.values()].sort((a, b) => rank(a) - rank(b));
}

/** Links AVPlayer can play (no DASH). */
export const playableUrls = (list) => list.filter((x) => x.kind === "hls" || x.kind === "mp4" || x.kind === "webm");

// ── Manifests ───────────────────────────────────────────────────────────

/** Whether a manifest (HLS or DASH) is DRM-protected (FairPlay / Widevine / PlayReady). */
export function isProtectedManifest(text) {
  const t = String(text || "");
  if (/#EXT-X-(?:SESSION-)?KEY:[^\n]*METHOD=SAMPLE-AES/i.test(t)) return true;
  if (/#EXT-X-(?:SESSION-)?KEY:[^\n]*(?:KEYFORMAT="com\.apple\.streamingkeydelivery"|URI="skd:)/i.test(t)) return true;
  if (/#EXT-X-(?:SESSION-)?KEY:[^\n]*KEYFORMAT="urn:uuid:(?:edef8ba9|9a04f079)/i.test(t)) return true;
  if (/<ContentProtection\b[^>]*(?:edef8ba9|9a04f079|94ce86fb|widevine|playready|clearkey|mp4protection)/i.test(t)) return true;
  return false;
}

/** AES-128 key links of an HLS media playlist (plain HTTPS keys, not DRM). */
export function aesKeyUris(text, base) {
  const out = [];
  for (const m of String(text || "").matchAll(/#EXT-X-KEY:([^\n]*)/g)) {
    if (!/METHOD=AES-128/i.test(m[1])) continue;
    const uri = /URI="([^"]+)"/.exec(m[1])?.[1];
    const u = uri && abs(uri, base);
    if (u) out.push(u);
  }
  return [...new Set(out)];
}

/** Variants of an HLS master: [{ url, bandwidth, height }], best first. */
export function masterVariants(text, base) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXT-X-STREAM-INF:(.*)$/.exec(lines[i].trim());
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith("#"))) j++;
    const url = lines[j] && abs(lines[j].trim(), base);
    if (!url) continue;
    const bw = Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(m[1])?.[1]) || 0;
    const h = Number(/RESOLUTION=\d+x(\d+)/.exec(m[1])?.[1]) || null;
    out.push({ url, bandwidth: bw, height: h });
  }
  return out.sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);
}

/** First media segment (or init map) of an HLS media playlist, or null. */
export function firstSegment(text, base) {
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const map = /^#EXT-X-MAP:.*URI="([^"]+)"/.exec(line);
    if (map) return abs(map[1], base);
    if (line && !line.startsWith("#")) return abs(line, base);
  }
  return null;
}
