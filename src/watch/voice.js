// Watch Together voice chat (wired into the party UI: mic toggle, speaking dots, ducking).
// Full mesh of audio-only WebRTC peer connections (max 8 per device in a
// 9-seat party), signalled over the room connection ("rtc" relay + "voice"
// mic/speaking flags, see roomCore.js). Opus mono at ~24 kbps keeps a 9-way
// mesh at ~200 kbps up per device.
//
// Every device in a party runs a mesh from the moment it joins, listen-only
// until its own mic is turned on, so anyone talking is heard by everyone
// (not only by people who also turned their mic on). A pair connects as soon
// as either of the two has a mic on (members[].mic in the room state); the
// lower client id makes the offer, so each pair has exactly one connection
// and no offer glare. The audio transceiver is created send+receive up
// front and the mic is attached later with replaceTrack, so turning the mic
// on never needs a renegotiation.
//
// NAT: ICE servers come from the room server's POST /turn (Cloudflare TURN
// when its TURN_KEY_ID / TURN_KEY_API_TOKEN secrets are set). Without it the
// public STUN servers plus PeerJS's public TURN relay are used, so phones on
// mobile data (symmetric NAT) still connect.
export const VOICE_ENABLED = true;
export const SPEAKING_LEVEL = 0.04; // RMS above this = talking
export const SPEAKING_HOLD_MS = 600;

export const ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
  // PeerJS's public relay (the same one PeerJS uses by default; best effort).
  { urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"], username: "peerjs", credential: "peerjsp" },
];
export const OPUS_MAX_BITRATE = 24_000;
export const DUCK_VOLUME = 0.35; // movie volume while someone talks
export const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false };

export class VoiceMesh {
  constructor({
    client,
    iceServers = ICE_SERVERS,
    getUserMedia = (c) => navigator.mediaDevices.getUserMedia(c),
    RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
    MediaStreamImpl = globalThis.MediaStream,
    doc = globalThis.document,
    onSpeaking,
    onDuck,
    onRemoteAudio,
  }) {
    Object.assign(this, { client, iceServers, getUserMedia, RTCPeerConnectionImpl, MediaStreamImpl, doc, onSpeaking, onDuck, onRemoteAudio });
    this.peers = new Map(); // id -> { pc, audio, queue: RTCIceCandidateInit[] }
    this.track = null; // this device's mic, once turned on
    this.muted = true;
    this.speaking = new Set();
    this.blocked = new Set(); // remote <audio> the browser would not autoplay yet
    this.stopped = false;
  }

  get micOn() {
    return !!this.track && !this.muted;
  }

  /** ICE servers to use from now on (the room server's TURN credentials). */
  setIceServers(list) {
    if (Array.isArray(list) && list.length) this.iceServers = list;
  }

  /** Called with every room state: open / close connections to match the party. */
  sync(state = this.client.state) {
    if (this.stopped || !state) return;
    this.lastState = state;
    const me = this.client.clientId;
    // The room lost this device's mic flag (it reconnected): say it again.
    const self = (state.members || []).find((m) => m.id === me);
    const now = Date.now();
    if (self?.connected && !!self.mic !== this.micOn && now - (this.announcedAt || 0) > 1000) {
      this.announcedAt = now;
      this.client.sendMsg({ type: "voice", mic: this.micOn, speaking: false });
    }
    const here = new Set();
    for (const m of state.members || []) {
      if (m.id === me || !m.connected) continue;
      here.add(m.id);
      if (!this.peers.has(m.id) && (this.micOn || m.mic) && me < m.id) this.offer(m.id).catch((e) => console.warn("[voice] offer failed", e));
    }
    for (const id of [...this.peers.keys()]) if (!here.has(id)) this.drop(id);
  }

  /** This device's room connection came back: every voice link starts over. */
  reconnected() {
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.announcedAt = 0;
  }

  /** Turns the mic on (asks for permission the first time). */
  async start() {
    if (!VOICE_ENABLED) throw new Error("Watch Together voice is not enabled yet");
    if (!this.track) {
      const stream = await this.getUserMedia(MIC_CONSTRAINTS);
      this.stream = stream;
      this.track = stream.getAudioTracks()[0] || null;
      if (!this.track) throw new Error("No microphone");
      for (const p of this.peers.values()) this.attachMic(p.pc);
      this.watchLevel();
    }
    this.unlockAudio();
    this.setMuted(false);
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.track) this.track.enabled = !muted;
    this.client.sendMsg({ type: "voice", mic: !muted && !!this.track, speaking: false });
    this.sync();
  }

  attachMic(pc) {
    for (const t of pc.getTransceivers?.() || []) {
      if ((t.receiver?.track?.kind || "audio") !== "audio") continue;
      try {
        t.direction = "sendrecv";
      } catch {}
      t.sender?.replaceTrack?.(this.track)?.catch?.(() => {});
    }
  }

  makePeer(id) {
    const pc = new this.RTCPeerConnectionImpl({ iceServers: this.iceServers });
    const peer = { pc, audio: null, queue: [] };
    pc.onicecandidate = (e) => e.candidate && this.client.sendMsg({ type: "rtc", to: id, data: { ice: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate } });
    pc.ontrack = (e) => {
      const stream = e.streams?.[0] || (this.MediaStreamImpl ? new this.MediaStreamImpl([e.track]) : null);
      this.playRemote(id, peer, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" && this.peers.get(id)?.pc === pc) {
        // Lost (network change, NAT timeout): start over; the lower id re-offers.
        this.drop(id);
        this.sync();
      }
    };
    this.peers.set(id, peer);
    return peer;
  }

  playRemote(id, peer, stream) {
    if (!stream) return;
    let a = peer.audio;
    if (!a) {
      a = this.doc?.createElement ? this.doc.createElement("audio") : new Audio();
      a.autoplay = true;
      a.setAttribute?.("playsinline", "");
      a.dataset && (a.dataset.voicePeer = id);
      if (a.style) a.style.display = "none";
      this.doc?.body?.appendChild?.(a);
      peer.audio = a;
    }
    a.muted = false;
    a.srcObject = stream;
    const p = a.play?.();
    p?.catch?.(() => {
      // Autoplay refused (no tap yet on this page): play on the next tap.
      this.blocked.add(a);
      this.armUnlock();
    });
    this.onRemoteAudio?.(id, stream);
  }

  armUnlock() {
    if (this.unlockArmed || !this.doc?.addEventListener) return;
    this.unlockArmed = true;
    const go = () => {
      this.unlockArmed = false;
      this.doc.removeEventListener("pointerdown", go, true);
      this.doc.removeEventListener("keydown", go, true);
      this.unlockAudio();
    };
    this.doc.addEventListener("pointerdown", go, true);
    this.doc.addEventListener("keydown", go, true);
  }

  unlockAudio() {
    for (const a of [...this.blocked]) {
      this.blocked.delete(a);
      a.play?.()?.catch?.(() => {
        this.blocked.add(a);
        this.armUnlock();
      });
    }
  }

  async offer(id) {
    const peer = this.makePeer(id);
    const pc = peer.pc;
    pc.addTransceiver("audio", { direction: "sendrecv" });
    if (this.track) this.attachMic(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.client.sendMsg({ type: "rtc", to: id, data: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } });
  }

  async onSignal({ from, data }) {
    if (this.stopped || !from || !data) return;
    if (data.sdp?.type === "offer") {
      // A new offer from that member (first one, or they restarted): fresh connection.
      if (this.peers.has(from)) this.drop(from);
      const peer = this.makePeer(from);
      const pc = peer.pc;
      await pc.setRemoteDescription(data.sdp);
      this.attachMic(pc);
      await pc.setLocalDescription(await pc.createAnswer());
      this.client.sendMsg({ type: "rtc", to: from, data: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } });
      await this.flush(peer);
      return;
    }
    const peer = this.peers.get(from);
    if (!peer) return;
    if (data.sdp?.type === "answer") {
      if (peer.pc.signalingState !== "have-local-offer") return;
      await peer.pc.setRemoteDescription(data.sdp);
      await this.flush(peer);
    } else if (data.ice) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.ice).catch(() => {});
      else peer.queue.push(data.ice);
    }
  }

  async flush(peer) {
    const q = peer.queue.splice(0);
    for (const c of q) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  drop(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try {
      p.pc.close();
    } catch {}
    if (p.audio) {
      this.blocked.delete(p.audio);
      p.audio.srcObject = null;
      p.audio.remove?.();
    }
    if (this.speaking.delete(id)) this.emitSpeaking();
  }

  onVoice({ id, speaking }) {
    speaking ? this.speaking.add(id) : this.speaking.delete(id);
    this.emitSpeaking();
  }

  emitSpeaking() {
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
      if (this.ctx.state === "suspended") this.ctx.resume?.().catch?.(() => {});
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
    this.stopped = true;
    clearInterval(this.levelTimer);
    this.ctx?.close?.()?.catch?.(() => {});
    if (this.track) this.client.sendMsg({ type: "voice", mic: false, speaking: false });
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.track = null;
  }
}
