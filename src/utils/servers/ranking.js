// Server ranking: per-provider speed and reliability, remembered across
// launches, and an ordering of play candidates fastest-first.
import { settleEach } from "./concurrent.js";
import { parseServerKey } from "./catalog.js";

const UNKNOWN_MS = 4000; // untested providers rank after known-fast ones
const FAIL_PENALTY_MS = 8000; // per recent failure
const SMOOTHING = 0.5; // weight of the newest sample
const FULL_HD = 1080;
const MS_PER_MISSING_LINE = 4; // 720p costs ~1.4 s against 1080p, 480p ~2.4 s

export const providerOf = (candidate) => parseServerKey(candidate.id).sourceId;

/**
 * Per-provider stats kept in `store` (`{ get(): object|null, set(obj) }`):
 * `{ [provider]: { ms, height, fails, ts } }` where ms is a smoothed time to
 * a response (probe) or to a playable stream (play, download lookup), height
 * the best picture the provider last streamed (0 = unknown), and fails counts
 * recent failures (reset by a success). Entries older than `ttlMs` drop.
 */
export function createServerStats(store, { ttlMs = 30 * 60_000, now = Date.now } = {}) {
  let map = null;
  const load = () => {
    if (map) return map;
    map = {};
    const saved = store.get() || {};
    const t = now();
    for (const [k, v] of Object.entries(saved)) if (v && t - v.ts < ttlMs) map[k] = v;
    return map;
  };
  return {
    /** Fresh entry for a provider, or undefined. */
    get: (provider) => load()[provider],
    /** Record one outcome: `{ ok, ms, height? }`. */
    record(provider, { ok, ms, height }) {
      const m = load();
      const prev = m[provider];
      const best = height || prev?.height || 0;
      m[provider] = ok
        ? { ms: prev?.ms == null ? ms : prev.ms + SMOOTHING * (ms - prev.ms), height: best, fails: 0, ts: now() }
        : { ms: prev?.ms ?? null, height: best, fails: (prev?.fails || 0) + 1, ts: now() };
      store.set(m);
    },
    /** Lower is better: speed, then picture quality, then reliability. */
    score(provider) {
      const s = load()[provider];
      if (!s) return UNKNOWN_MS;
      const quality = s.height ? Math.max(0, FULL_HD - s.height) * MS_PER_MISSING_LINE : 0;
      return (s.ms ?? UNKNOWN_MS) + quality + s.fails * FAIL_PENALTY_MS;
    },
  };
}

/**
 * Candidates ordered by provider score (stable for ties); a `pinned` id
 * (a server the viewer picked, or the last one that played this title)
 * goes first.
 */
export function rankCandidates(candidates, stats, { pinned = null } = {}) {
  const scored = candidates.map((c, i) => ({ c, i, s: c.id === pinned ? -Infinity : stats.score(providerOf(c)) }));
  scored.sort((a, b) => a.s - b.s || a.i - b.i);
  return scored.map((x) => x.c);
}

/**
 * Probe the providers with no fresh stats, all at once, then rank.
 * Waits at most `budgetMs`; once one probe answers, the rest get `graceMs`
 * more and are then cancelled. Only real failures (errors, own timeout) are
 * recorded; a probe cut off because a faster one already won is not.
 */
export async function probeAndRank(candidates, { stats, probe, pinned, budgetMs = 1200, graceMs = 200, signal } = {}) {
  const seen = new Set();
  const toProbe = candidates.filter((c) => {
    const p = providerOf(c);
    if (stats.get(p) || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  if (toProbe.length) {
    const cutoff = new AbortController();
    const cancel = () => cutoff.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    let graceTimer = null;
    await settleEach(toProbe, (c, s) => probe(c.url, s), {
      timeoutMs: budgetMs,
      signal: cutoff.signal,
      onSettled: (r) => {
        if (r.ok && !graceTimer) graceTimer = setTimeout(cancel, graceMs);
        if (r.ok || !cutoff.signal.aborted) stats.record(providerOf(r.item), { ok: r.ok, ms: r.ms });
      },
    });
    clearTimeout(graceTimer);
    signal?.removeEventListener("abort", cancel);
  }
  return rankCandidates(candidates, stats, { pinned });
}
