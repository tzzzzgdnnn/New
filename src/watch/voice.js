// Watch Together voice chat (wired into the party UI: mic toggle, speaking dots, ducking).
// Full mesh of audio-only WebRTC peer connections (max 8 per device in a
// 9-seat party), signalled over the room WebSocket ("rtc" relay + "voice"
// state messages, see roomCore.js). Opus mono at ~24 kbps keeps a 9-way mesh
// at ~200 kbps up per device. Future upgrade: an SFU (one uplink per device).
// NAT: ICE servers come from the room server's POST /turn (Cloudflare TURN
// credentials when its TURN_KEY_ID / TURN_KEY_API_TOKEN secrets are set,
// public STUN otherwise), so strict / symmetric NATs still connect.
export const VOICE_ENABLED = true;
export const SPEAKING_LEVEL = 0.04; // RMS above this = talking
export const SPEAKING_HOLD_MS = 600;

export const ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
export const OPUS_MAX_BITRATE = 24_000;
export const DUCK_VOLUME = 0.35; // movie volume while someone talks

export class VoiceMesh {
  constructor({ client, iceServers = ICE_SERVERS, getUserMedia = (c) => navigator.mediaDevices.getUserMedia(c), RTCPeerConnectionImpl = globalThis.RTCPeerConnection, onSpeaking, onDuck }) {
    Object.assign(this, { client, iceServers, getUserMedia, RTCPeerConnectionImpl, onSpeaking, onDuck });
    this.peers = new Map();
    this.muted = true;
    this.speaking = new Set();
  }
  async start() {
    if (!VOICE_ENABLED) throw new Error("Watch Together voice is not enabled yet");
    this.stream = await this.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    this.setMuted(false);
    this.watchLevel();
    for (const m of this.client.state?.members || []) if (m.id !== this.client.clientId && m.connected) this.call(m.id);
  }
  setMuted(muted) {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.client.sendMsg({ type: "voice", mic: !muted, speaking: false });
  }
  /** Lower clientId offers, so each pair makes exactly one connection. */
  peer(id) {
    if (this.peers.has(id)) return this.peers.get(id);
    const pc = new this.RTCPeerConnectionImpl({ iceServers: this.iceServers });
    this.stream?.getTracks().forEach((t) => pc.addTrack(t, this.stream));
    pc.onicecandidate = (e) => e.candidate && this.client.sendMsg({ type: "rtc", to: id, data: { ice: e.candidate } });
    pc.ontrack = (e) => {
      const a = new Audio();
      a.autoplay = true;
      a.setAttribute("playsinline", "");
      (this.audios ||= new Map()).set(id, a);
      a.srcObject = e.streams[0];
      a.play().catch(() => {});
    };
    this.peers.set(id, pc);
    return pc;
  }
  async call(id) {
    if (this.client.clientId > id) return;
    const pc = this.peer(id);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.client.sendMsg({ type: "rtc", to: id, data: { sdp: pc.localDescription } });
  }
  async onSignal({ from, data }) {
    const pc = this.peer(from);
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === "offer") {
        await pc.setLocalDescription(await pc.createAnswer());
        this.client.sendMsg({ type: "rtc", to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.ice) await pc.addIceCandidate(data.ice).catch(() => {});
  }
  onVoice({ id, speaking }) {
    speaking ? this.speaking.add(id) : this.speaking.delete(id);
    this.onSpeaking?.(new Set(this.speaking));
    this.onDuck?.(this.speaking.size ? DUCK_VOLUME : 1);
  }
  /** Local speaking indicator from an AnalyserNode on the mic (sent as "voice" to the room). */
  watchLevel() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC || !this.stream) return;
    this.ctx = new AC();
    const an = this.ctx.createAnalyser();
    an.fftSize = 512;
    this.ctx.createMediaStreamSource(this.stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let talking = false;
    let lastLoud = 0;
    this.levelTimer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const now = Date.now();
      if (!this.muted && Math.sqrt(sum / buf.length) > SPEAKING_LEVEL) lastLoud = now;
      const t = now - lastLoud < SPEAKING_HOLD_MS;
      if (t !== talking) {
        talking = t;
        this.client.sendMsg({ type: "voice", mic: !this.muted, speaking: t });
      }
    }, 100);
  }
  stop() {
    clearInterval(this.levelTimer);
    this.ctx?.close?.().catch?.(() => {});
    this.client.sendMsg({ type: "voice", mic: false, speaking: false });
    this.peers.forEach((pc) => pc.close());
    this.audios?.forEach((a) => (a.srcObject = null));
    this.peers.clear();
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
