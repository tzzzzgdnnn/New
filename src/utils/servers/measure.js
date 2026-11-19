// Measured server ranking for the player's "Auto" choice: every candidate
// is sampled in parallel (latency = time to first byte, throughput = bytes
// received per second while downloading a sample), servers that failed or had
// no stream are skipped, and the rest are ordered by bandwidth first with
// latency as the tiebreaker. Results are cached briefly per network.
// Pure logic (no DOM), so Node tests drive it with fake samplers and clocks.
import { settleEach } from "./concurrent.js";
import { parseServerKey } from "./catalog.js";

/** Latency at which a server's throughput counts half. */
export const LATENCY_REF_MS = 400;
/** Throughputs within this ratio count as equal; latency then decides. */
export const BANDWIDTH_TIE = 0.1;
export const MEASURE_TTL_MS = 5 * 60_000;
export const MEASURE_BUDGET_MS = 1800;

const providerOf = (c) => parseServerKey(c.id).sourceId;

/**
 * Score of one sample, higher is better: throughput (bytes/s) penalized by
 * latency. Null when the sample has no throughput (latency-only).
 */
export function scoreSample(s) {
  if (!s?.ok || !(s.bps > 0)) return null;
  return s.bps / (1 + Math.max(0, s.latencyMs || 0) / LATENCY_REF_MS);
}

/**
 * Compare two working samples: bandwidth first (a clear difference wins),
 * then latency; servers with no throughput reading come after measured ones,
 * ordered by latency.
 */
export function compareSamples(a, b) {
  const sa = scoreSample(a);
  const sb = scoreSample(b);
  if (sa != null && sb != null) {
    const hi = Math.max(sa, sb);
    if (Math.abs(sa - sb) / hi > BANDWIDTH_TIE) return sb - sa;
    return (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
  }
  if (sa != null) return -1;
  if (sb != null) return 1;
  return (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
}

/**
 * Candidates in measured order: working servers best first, then servers not
 * measured yet (in their given order). Servers whose sample failed are
 * skipped, unless nothing else is left (then the list is returned as given,
 * so playback still has something to try). `pinned` (a server picked by
 * hand) always leads.
 * @param {Array<{id:string}>} candidates
 * @param {(provider: string) => object|undefined} sampleOf
 */
export function rankMeasured(candidates, sampleOf, { pinned = null } = {}) {
  const rows = candidates.map((c, i) => ({ c, i, s: sampleOf(providerOf(c)) }));
  const ok = rows.filter((r) => r.s?.ok).sort((a, b) => compareSamples(a.s, b.s) || a.i - b.i);
  const unknown = rows.filter((r) => !r.s);
  let out = [...ok, ...unknown].map((r) => r.c);
  if (!out.length) out = candidates.slice();
  if (pinned) {
    const p = candidates.find((c) => c.id === pinned);
    if (p) out = [p, ...out.filter((c) => c !== p)];
  }
  return out;
}

/**
 * Cache of samples per network: `{ [network]: { [provider]: sample } }` in
 * `store` (`{ get(), set(obj) }`). A sample is
 * `{ ok, bps|null, latencyMs|null, ts, from: "probe"|"play" }`; entries older
 * than `ttlMs` are ignored. A new latency-only sample keeps the throughput
 * measured shortly before (e.g. from real playback).
 */
export function createMeasureCache(store, { ttlMs = MEASURE_TTL_MS, now = Date.now, network = () => "net" } = {}) {
  const read = () => {
    try {
      return store.get() || {};
    } catch {
      return {};
    }
  };
  const fresh = (s) => s && now() - s.ts < ttlMs;
  return {
    get(provider) {
      const s = read()[network()]?.[provider];
      return fresh(s) ? s : undefined;
    },
    all() {
      const out = {};
      for (const [k, s] of Object.entries(read()[network()] || {})) if (fresh(s)) out[k] = s;
      return out;
    },
    record(provider, sample) {
      const all = read();
      const net = network();
      const mine = { ...(all[net] || {}) };
      for (const [k, s] of Object.entries(mine)) if (!fresh(s)) delete mine[k];
      const prev = fresh(mine[provider]) ? mine[provider] : null;
      const bps = sample.ok ? (sample.bps > 0 ? sample.bps : prev?.ok ? prev.bps ?? null : null) : null;
      mine[provider] = {
        ok: !!sample.ok,
        bps,
        latencyMs: sample.latencyMs ?? (sample.ok ? prev?.latencyMs ?? null : null),
        ts: now(),
        from: sample.from || "probe",
      };
      // Only the current network is kept: another network's numbers say
      // nothing about this one.
      store.set({ [net]: mine });
      return mine[provider];
    },
    clear() {
      store.set({});
    },
  };
}

/**
 * Sample every provider in `candidates` that has no fresh sample, all at
 * once, each within `budgetMs`. Each result is recorded the moment it lands
 * (so a Play pressed mid-way already sees the servers measured so far) and
 * reported to `onResult(provider, sample)`. Resolves once every sample
 * settled or ran out of time.
 * @param {(candidate, signal) => Promise<{bps?: number, latencyMs?: number}>} sample
 *   rejects (or times out) when the server failed or has no stream
 */
export async function measureCandidates(candidates, { sample, cache, budgetMs = MEASURE_BUDGET_MS, signal, onResult, force = false } = {}) {
  const seen = new Set();
  const todo = candidates.filter((c) => {
    const p = providerOf(c);
    if (seen.has(p) || (!force && cache.get(p))) return false;
    seen.add(p);
    return true;
  });
  if (!todo.length) return cache.all();
  await settleEach(todo, (c, s) => sample(c, s), {
    timeoutMs: budgetMs,
    signal,
    onSettled: (r) => {
      // A run cancelled from outside (a newer title) records nothing.
      if (!r.ok && signal?.aborted) return;
      const p = providerOf(r.item);
      const saved = cache.record(
        p,
        r.ok ? { ok: true, bps: r.value?.bps ?? null, latencyMs: r.value?.latencyMs ?? r.ms } : { ok: false },
      );
      onResult?.(p, saved);
    },
  });
  return cache.all();
}

const MB = 1024 * 1024;

/** "12.4 MB/s · 80 ms", "640 KB/s · 120 ms", "80 ms", "No stream", or null. */
export function formatSample(s) {
  if (!s) return null;
  if (!s.ok) return "No stream";
  const parts = [];
  if (s.bps > 0) {
    parts.push(s.bps >= MB ? `${(s.bps / MB).toFixed(1)} MB/s` : `${Math.max(1, Math.round(s.bps / 1024))} KB/s`);
  }
  if (s.latencyMs != null) parts.push(`${Math.round(s.latencyMs)} ms`);
  return parts.join(" · ") || null;
}
