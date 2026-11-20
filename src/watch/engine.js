// Client-side sync engine: turns the room's authoritative playback state
// into commands for this device's player (through a thin adapter), and the
// player's state into status reports for the room. Pure logic, no I/O:
// the room client calls step() on a timer and on every room update.
//
// Adapter contract (positions are seconds of item time, times are local ms):
//   read() -> { key, ready, seeking, status: "playing"|"waiting"|"paused",
//               pos, sampledAt, rate }
//     key       mediaKey of what is loaded (null while nothing is)
//     ready     the item can play from `pos` without stalling (buffered)
//   pause(pos)              stop, then land exactly on `pos`
//   playAt(pos, atLocal, r) start item time `pos` at local instant `atLocal`
//   setRate(r)              whole-player rate (video + audio together)
import { expectedPosition } from "./protocol.js";
import { decideCorrection } from "./drift.js";

export const STALL_CONFIRM_MS = 150; // a "waiting" this long is a real stall
export const REARM_LEAD_MS = 600; // a hard seek while playing lands this far ahead
export const SETTLE_MS = 900; // no drift decisions right after a (re)start
export const PAUSE_POS_TOLERANCE = 0.04; // paused this close to the hold = on the frame
export const STATUS_EVERY_MS = 1000;

export class SyncEngine {
  constructor({ adapter, clock, now = () => Date.now(), send }) {
    this.adapter = adapter;
    this.clock = clock;
    this.now = now;
    this.send = send;
    this.room = null;
    this.armed = null; // "epoch:at" of the start already handed to the player
    this.heldEpoch = null; // epoch whose pause was already applied
    this.pauseIssuedAt = 0;
    this.nudging = false;
    this.rate = 1;
    this.settleUntil = 0;
    this.waitingSince = null;
    this.lastStatus = null;
    this.lastStatusAt = 0;
    this.lastDrift = null;
  }

  setRoom(state) {
    this.room = state;
    this.step();
  }

  /** Room position right now (seconds), per the shared clock. */
  target(localNow = this.now()) {
    const pb = this.room?.playback;
    return pb ? expectedPosition(pb, this.clock.serverNow(localNow)) : 0;
  }

  step() {
    const st = this.room;
    if (!st || !st.media) return;
    const pb = st.playback;
    const now = this.now();
    const sNow = this.clock.serverNow(now);
    const s = this.adapter.read() || {};
    const loaded = !!s.key && s.key === st.media.key;
    const posNow = s.status === "playing" ? s.pos + ((now - (s.sampledAt ?? now)) / 1000) * (s.rate || 1) : s.pos;

    // ── Stall detection (only while the room is really playing) ──
    const running = !pb.paused && sNow >= pb.at;
    if (loaded && running && s.status === "waiting" && now >= this.settleUntil) this.waitingSince ??= now;
    else this.waitingSince = null;
    const buffering = this.waitingSince != null && now - this.waitingSince >= STALL_CONFIRM_MS;
    const onHold =
      pb.paused && s.status === "paused" && Number.isFinite(s.pos) && Math.abs(s.pos - pb.pos) <= PAUSE_POS_TOLERANCE;
    const ready = loaded && !!s.ready && !s.seeking && (pb.paused ? onHold : !buffering);
    this.report({ rev: st.media.rev, epoch: st.epoch, ready, buffering, pos: Number.isFinite(posNow) ? posNow : null }, now);

    if (!loaded) return;

    // ── Held (paused, waiting on a stalled phone, or on someone loading) ──
    if (pb.paused) {
      this.armed = null;
      this.nudging = false;
      const drifted = !onHold && !s.seeking && now - this.pauseIssuedAt > 1500;
      if (this.heldEpoch !== st.epoch || drifted) {
        this.adapter.pause(pb.pos);
        this.heldEpoch = st.epoch;
        this.pauseIssuedAt = now;
      }
      return;
    }
    this.heldEpoch = null;

    // ── Scheduled start: every phone starts the same item time on the same instant ──
    const startKey = `${st.epoch}:${pb.at}`;
    if (this.armed !== startKey) {
      this.armed = startKey;
      this.nudging = false;
      this.rate = pb.rate || 1;
      if (sNow < pb.at) {
        const atLocal = this.clock.toLocal(pb.at);
        this.adapter.playAt(pb.pos, atLocal, this.rate);
        this.settleUntil = atLocal + SETTLE_MS;
      } else {
        this.rearm(now);
      }
      return;
    }
    if (sNow < pb.at || s.status !== "playing" || now < this.settleUntil) return;

    // ── Drift correction ──
    const drift = posNow - expectedPosition(pb, sNow);
    this.lastDrift = drift;
    const d = decideCorrection(drift, { baseRate: pb.rate || 1, nudging: this.nudging });
    if (d.action === "seek") {
      this.rearm(now);
    } else if (d.action === "rate") {
      this.nudging = true;
      if (Math.abs(d.rate - this.rate) > 0.0005) {
        this.rate = d.rate;
        this.adapter.setRate(d.rate);
      }
    } else if (this.nudging || this.rate !== (pb.rate || 1)) {
      this.nudging = false;
      this.rate = pb.rate || 1;
      this.adapter.setRate(this.rate);
    }
  }

  /** Late join or a big gap: land on the room's timeline a moment from now. */
  rearm(now) {
    const atLocal = now + REARM_LEAD_MS;
    this.nudging = false;
    this.rate = this.room.playback.rate || 1;
    this.adapter.playAt(this.target(atLocal), atLocal, this.rate);
    this.settleUntil = atLocal + SETTLE_MS;
  }

  report(status, now) {
    const sig = `${status.rev}:${status.epoch}:${status.ready}:${status.buffering}`;
    if (sig === this.lastStatus && now - this.lastStatusAt < STATUS_EVERY_MS) return;
    this.lastStatus = sig;
    this.lastStatusAt = now;
    this.send({ type: "status", ...status });
  }
}
