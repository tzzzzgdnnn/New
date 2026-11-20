// NTP-style clock offset over the room socket. Each ping records the local
// send time t0, the server's time ts and the local receive time t1:
//   offset = ts - (t0 + t1) / 2      rtt = t1 - t0
// The samples with the shortest round trips are the most accurate (their
// one-way delays are the most symmetric), so the offset is the median of the
// best few. serverNow = localNow + offset.
export class ClockSync {
  constructor({ keep = 16, best = 3 } = {}) {
    this.keep = keep;
    this.best = best;
    this.samples = [];
    this.offset = 0;
    this.rtt = Infinity;
  }

  add(t0, ts, t1) {
    if (![t0, ts, t1].every(Number.isFinite) || t1 < t0) return this.offset;
    this.samples.push({ rtt: t1 - t0, offset: ts - (t0 + t1) / 2 });
    if (this.samples.length > this.keep) this.samples.shift();
    const top = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, this.best);
    const offs = top.map((s) => s.offset).sort((a, b) => a - b);
    this.offset = offs[Math.floor(offs.length / 2)];
    this.rtt = top[0].rtt;
    return this.offset;
  }

  get synced() {
    return this.samples.length >= 3;
  }

  /** Error bound of the offset (ms): half the best round trip. */
  get uncertainty() {
    return Number.isFinite(this.rtt) ? this.rtt / 2 : Infinity;
  }

  serverNow(localNow) {
    return localNow + this.offset;
  }

  toLocal(serverTime) {
    return serverTime - this.offset;
  }
}
