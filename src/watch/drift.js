// Drift correction. `drift` = actual item time - where the room says it
// should be (seconds; + means ahead). The whole player rate is nudged, so the
// video and audio tracks (one item clock) move together and lip-sync on each
// phone is untouched; the native players keep pitch with a pitch-preserving
// time-stretch, so a few percent is inaudible. Beyond HARD_SEEK the gap is
// closed with an exact seek scheduled to land on the room's timeline.
export const DEADBAND = 0.03; // within 30 ms: leave it at 1x
export const SETTLE = 0.012; // once nudging, keep going until within 12 ms
export const HARD_SEEK = 0.3; // over 300 ms: seek
export const MAX_NUDGE = 0.05; // rate stays within 0.95x..1.05x
export const CORRECT_SECONDS = 2; // close a gap over about 2 s

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * One correction decision. `nudging` says a nudge is already running
 * (hysteresis, so the rate doesn't flap at the deadband edge).
 * Returns { action: "none" | "rate" | "seek", rate }.
 */
export function decideCorrection(drift, { baseRate = 1, nudging = false } = {}) {
  if (!Number.isFinite(drift)) return { action: "none", rate: baseRate };
  const a = Math.abs(drift);
  if (a >= HARD_SEEK) return { action: "seek", rate: baseRate };
  if (a <= (nudging ? SETTLE : DEADBAND)) return { action: "none", rate: baseRate };
  const nudge = clamp(drift / CORRECT_SECONDS, -MAX_NUDGE, MAX_NUDGE);
  return { action: "rate", rate: +(baseRate * (1 - nudge)).toFixed(4) };
}
