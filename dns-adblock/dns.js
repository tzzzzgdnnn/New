// Minimal DNS wire-format helpers for the Super Player DoH ad-block worker.
// Only what the worker needs: read the first question, build a "blocked"
// answer (0.0.0.0 / ::) and match names against the blocklist.

export const TYPE_A = 1;
export const TYPE_AAAA = 28;
export const CLASS_IN = 1;
export const BLOCK_TTL = 300;

/**
 * Read the first question of a DNS message.
 * @param {Uint8Array} msg raw DNS message
 * @returns {{id: number, flags: number, name: string, type: number, qclass: number, questionEnd: number} | null}
 *   null when the message is too short or the question can't be read
 */
export function parseQuery(msg) {
  if (!(msg instanceof Uint8Array) || msg.length < 12) return null;
  const qdcount = (msg[4] << 8) | msg[5];
  if (qdcount < 1) return null;
  let off = 12;
  const labels = [];
  for (;;) {
    if (off >= msg.length) return null;
    const len = msg[off];
    if (len === 0) {
      off += 1;
      break;
    }
    // Compression pointers and extended labels never appear in a client's
    // first question; refuse them rather than follow them.
    if (len & 0xc0) return null;
    if (off + 1 + len > msg.length) return null;
    let label = "";
    for (let i = off + 1; i < off + 1 + len; i++) label += String.fromCharCode(msg[i]);
    labels.push(label.toLowerCase());
    off += 1 + len;
    if (off > 12 + 255) return null;
  }
  if (off + 4 > msg.length) return null;
  return {
    id: (msg[0] << 8) | msg[1],
    flags: (msg[2] << 8) | msg[3],
    name: labels.join("."),
    type: (msg[off] << 8) | msg[off + 1],
    qclass: (msg[off + 2] << 8) | msg[off + 3],
    questionEnd: off + 4,
  };
}

/**
 * Normalize blocklist lines: trims, lowercases, drops comments, blanks and a
 * trailing dot.
 * @param {string} text one host per line
 * @returns {string[]}
 */
export function parseBlocklist(text) {
  const out = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim().toLowerCase().replace(/\.$/, "");
    if (line) out.add(line);
  }
  return [...out];
}

/**
 * True when the name or any parent domain is on the blocklist.
 * @param {string} name e.g. "a.b.example.com"
 * @param {Set<string>} set blocked hosts
 */
export function isBlocked(name, set) {
  let n = String(name).toLowerCase().replace(/\.$/, "");
  while (n) {
    if (set.has(n)) return true;
    const dot = n.indexOf(".");
    if (dot < 0) return false;
    n = n.slice(dot + 1);
  }
  return false;
}

/**
 * Answer for a blocked name: NOERROR, the question echoed, and for A/AAAA one
 * answer of 0.0.0.0 / :: (TTL 300). Other types get NOERROR with no answer.
 * @param {Uint8Array} msg the query
 * @param {ReturnType<typeof parseQuery>} q its parsed question
 * @returns {Uint8Array}
 */
export function buildBlockedResponse(msg, q) {
  const question = msg.subarray(12, q.questionEnd);
  const rdlen = q.qclass === CLASS_IN && q.type === TYPE_A ? 4 : q.qclass === CLASS_IN && q.type === TYPE_AAAA ? 16 : 0;
  const answerLen = rdlen ? 2 + 2 + 2 + 4 + 2 + rdlen : 0;
  const out = new Uint8Array(12 + question.length + answerLen);
  const opcode = (q.flags >> 11) & 0x0f;
  const rd = (q.flags >> 8) & 0x01;
  out[0] = q.id >> 8;
  out[1] = q.id & 0xff;
  out[2] = 0x80 | (opcode << 3) | rd; // QR=1, opcode echoed, AA=0, TC=0, RD echoed
  out[3] = 0x80; // RA=1, Z=0, RCODE=0 (NOERROR)
  out[5] = 1; // QDCOUNT
  out[7] = rdlen ? 1 : 0; // ANCOUNT
  // NSCOUNT, ARCOUNT stay 0
  out.set(question, 12);
  if (rdlen) {
    let o = 12 + question.length;
    out[o++] = 0xc0; // name: pointer to the question name at offset 12
    out[o++] = 0x0c;
    out[o++] = q.type >> 8;
    out[o++] = q.type & 0xff;
    out[o++] = 0;
    out[o++] = CLASS_IN;
    out[o++] = (BLOCK_TTL >>> 24) & 0xff;
    out[o++] = (BLOCK_TTL >>> 16) & 0xff;
    out[o++] = (BLOCK_TTL >>> 8) & 0xff;
    out[o++] = BLOCK_TTL & 0xff;
    out[o++] = 0;
    out[o++] = rdlen;
    // rdata stays all zeros: 0.0.0.0 or ::
  }
  return out;
}

/** base64url (no padding) → bytes, or null when invalid. */
export function base64UrlToBytes(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) return null;
  const b64 = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
