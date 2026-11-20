// Watch Together voice chat (SCAFFOLD, not yet wired into any UI).
// Full mesh of audio-only WebRTC peer connections (max 8 per device in a
// 9-seat party), signalled over the room WebSocket ("rtc" relay + "voice"
// state messages, see roomCore.js). Opus mono at ~24 kbps keeps a 9-way mesh
// at ~200 kbps up per device. Future upgrade: an SFU (one uplink per device).
// NAT: public STUN only. Users behind symmetric / strict NATs need a TURN
// server (none configured; nothing was signed up for).
// Feature guard: voice stays off until the UI + iOS audio session work lands.
export const VOICE_ENABLED = false;

export const ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
export const OPUS_MAX_BITRATE = 24_000;
export const DUCK_VOLUME = 0.35; // movie volume while someone talks

export class VoiceMesh {
  constructor({ client, getUserMedia = (c) => navigator.mediaDevices.getUserMedia(c), RTCPeerConnectionImpl = globalThis.RTCPeerConnection, onSpeaking, onDuck }) {
    Object.assign(this, { client, getUserMedia, RTCPeerConnectionImpl, onSpeaking, onDuck });
    this.peers = new Map();
    this.muted = true;
    this.speaking = new Set();
  }
  async start() {
    if (!VOICE_ENABLED) throw new Error("Watch Together voice is not enabled yet");
    this.stream = await this.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    this.setMuted(false);
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
    const pc = new this.RTCPeerConnectionImpl({ iceServers: ICE_SERVERS });
    this.stream?.getTracks().forEach((t) => pc.addTrack(t, this.stream));
    pc.onicecandidate = (e) => e.candidate && this.client.sendMsg({ type: "rtc", to: id, data: { ice: e.candidate } });
    pc.ontrack = (e) => {
      const a = new Audio();
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
  stop() {
    this.peers.forEach((pc) => pc.close());
    this.peers.clear();
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
