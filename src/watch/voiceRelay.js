// Voice that always gets through: when a WebRTC voice link to someone can't
// connect (no TURN, carrier-grade NAT on cellular, a firewall that blocks
// UDP), this device's voice goes over the party's own connection instead:
// the room server's WebSocket (Cloudflare Durable Object), or in a
// peer-to-peer party the host's data channel, which is already up or the
// party itself wouldn't be. The room fans the frames out ("vaud" messages,
// roomCore.js); each receiver plays only the senders it has no working
// WebRTC link to, so nobody is heard twice.
//
// Codec: Opus (WebCodecs AudioEncoder, 24 kbps mono, 40 ms frames) where the
// browser has it, otherwise 16 kHz 8-bit mu-law (128 kbps, every browser).
// Playback: a 120 ms jitter buffer on a Web Audio clock.

export const RELAY_AFTER_MS = 5000; // a voice link not connected after this long: relay
export const FRAME_MS = 40;
export const RELAY_RATE = 16000;
export const OPUS_RELAY_BITRATE = 24_000;
export const JITTER_S = 0.12;

// ── mu-law (G.711) ──────────────────────────────────────────────────────────
export function muEncode(f32) {
  const out = new Uint8Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    let s = Math.max(-1, Math.min(1, f32[i])) * 32767;
    const sign = s < 0 ? 0x80 : 0;
    if (sign) s = -s;
    s = Math.min(32635, s + 132);
    let exp = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
    const man = (s >> (exp + 3)) & 0x0f;
    out[i] = ~(sign | (exp << 4) | man) & 0xff;
  }
  return out;
}

export function muDecode(u8) {
  const out = new Float32Array(u8.length);
  for (let i = 0; i < u8.length; i++) {
    const u = ~u8[i] & 0xff;
    const sign = u & 0x80;
    const exp = (u >> 4) & 0x07;
    const man = u & 0x0f;
    let s = ((man << 3) + 132) << exp;
    s -= 132;
    out[i] = (sign ? -s : s) / 32768;
  }
  return out;
}

export const b64 = (u8) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Linear resample (speech band; good enough after the mic's own filtering). */
export function resample(f32, from, to) {
  if (from === to) return f32;
  const n = Math.max(1, Math.round((f32.length * to) / from));
  const out = new Float32Array(n);
  const k = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * k;
    const j = Math.floor(x);
    const a = f32[j] ?? 0;
    const b = f32[j + 1] ?? a;
    out[i] = a + (b - a) * (x - j);
  }
  return out;
}

const hasOpus = () => typeof globalThis.AudioEncoder === "function" && typeof globalThis.AudioDecoder === "function" && typeof globalThis.AudioData === "function";

export class VoiceRelay {
  constructor({ send, getCtx, onLevel } = {}) {
    Object.assign(this, { send, getCtx, onLevel });
    this.sending = false;
    this.seq = 0;
    this.players = new Map(); // sender id -> { next, decoder }
    this.codec = null;
    this.stats = { sent: 0, received: 0, played: 0 };
  }

  /** Starts capturing `stream` (the mic). Frames go out only while `sending` is on. */
  async attach(stream) {
    const ctx = this.getCtx();
    if (!ctx || !stream || this.node) return;
    this.codec = "mulaw";
    if (hasOpus()) {
      try {
        const cfg = { codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: OPUS_RELAY_BITRATE };
        const ok = await AudioEncoder.isConfigSupported(cfg).then((r) => r.supported, () => false);
        if (ok) {
          this.encoder = new AudioEncoder({
            output: (chunk) => {
              const u8 = new Uint8Array(chunk.byteLength);
              chunk.copyTo(u8);
              this.emit("opus", u8);
            },
            error: () => {
              this.encoder = null;
              this.codec = "mulaw";
            },
          });
          this.encoder.configure({ ...cfg, opus: { frameDuration: FRAME_MS * 1000, complexity: 5, useinbandfec: true } });
          this.codec = "opus";
        }
      } catch {
        this.encoder = null;
        this.codec = "mulaw";
      }
    }
    const src = ctx.createMediaStreamSource(stream);
    const frame = Math.round((ctx.sampleRate * FRAME_MS) / 1000);
    // ScriptProcessor: every browser (iPhone Safari included), no worklet file.
    const node = ctx.createScriptProcessor(2048, 1, 1);
    let pending = new Float32Array(0);
    let ts = 0;
    node.onaudioprocess = (e) => {
      if (!this.sending) return;
      const inp = e.inputBuffer.getChannelData(0);
      const merged = new Float32Array(pending.length + inp.length);
      merged.set(pending);
      merged.set(inp, pending.length);
      let off = 0;
      for (; off + frame <= merged.length; off += frame) {
        const f = merged.subarray(off, off + frame);
        if (this.codec === "opus" && this.encoder) {
          const pcm48 = resample(f, ctx.sampleRate, 48000);
          const data = new AudioData({ format: "f32", sampleRate: 48000, numberOfFrames: pcm48.length, numberOfChannels: 1, timestamp: ts, data: pcm48 });
          ts += FRAME_MS * 1000;
          try {
            this.encoder.encode(data);
          } catch {}
          data.close();
        } else {
          this.emit("mulaw", muEncode(resample(f, ctx.sampleRate, RELAY_RATE)));
        }
      }
      pending = merged.slice(off);
    };
    // A ScriptProcessor only runs while connected to the output; it writes silence.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    this.node = node;
    this.src = src;
  }

  emit(codec, u8) {
    this.stats.sent++;
    this.send({ type: "vaud", c: codec === "opus" ? "o" : "m", s: this.seq++, d: b64(u8) });
  }

  /** A relayed frame from `from`. */
  receive(from, msg) {
    const ctx = this.getCtx();
    if (!ctx || typeof msg?.d !== "string") return;
    this.stats.received++;
    let p = this.players.get(from);
    if (!p) {
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      p = { next: 0, gain, decoder: null };
      this.players.set(from, p);
    }
    let bytes;
    try {
      bytes = unb64(msg.d);
    } catch {
      return;
    }
    if (msg.c === "o") {
      if (!hasOpus()) return;
      if (!p.decoder) {
        p.decoder = new AudioDecoder({
          output: (ad) => {
            const f = new Float32Array(ad.numberOfFrames);
            ad.copyTo(f, { planeIndex: 0, format: "f32-planar" });
            const rate = ad.sampleRate;
            ad.close();
            this.play(p, f, rate);
          },
          error: () => (p.decoder = null),
        });
        p.decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
      }
      try {
        p.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: (msg.s || 0) * FRAME_MS * 1000, data: bytes }));
      } catch {}
    } else {
      this.play(p, muDecode(bytes), RELAY_RATE);
    }
  }

  play(p, f32, rate) {
    const ctx = this.getCtx();
    if (!ctx || !f32.length) return;
    if (ctx.state === "suspended") ctx.resume?.().catch?.(() => {});
    const buf = ctx.createBuffer(1, f32.length, rate);
    buf.getChannelData(0).set(f32);
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(p.gain);
    const now = ctx.currentTime;
    // Fell behind (a gap or the first frame): restart the jitter buffer.
    if (p.next < now + 0.02 || p.next > now + JITTER_S * 4) p.next = now + JITTER_S;
    s.start(p.next);
    p.next += buf.duration;
    this.stats.played++;
  }

  drop(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    try {
      p.decoder?.close();
    } catch {}
    try {
      p.gain.disconnect();
    } catch {}
  }

  stop() {
    this.sending = false;
    try {
      this.node?.disconnect();
      this.src?.disconnect();
    } catch {}
    this.node = null;
    try {
      this.encoder?.close();
    } catch {}
    for (const id of [...this.players.keys()]) this.drop(id);
  }
}
