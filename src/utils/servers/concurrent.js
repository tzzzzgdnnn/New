// Run one async job per item, all at once, each with its own timeout.
// Results are reported the moment each job settles, so a caller can show the
// fast ones while slow ones are still running; nothing waits on the slowest.

/**
 * @param {T[]} items
 * @param {(item: T, signal: AbortSignal) => Promise<V>} run
 * @param {{ timeoutMs?: number, signal?: AbortSignal,
 *           onSettled?: (r: Settled<T, V>) => void,
 *           now?: () => number }} [opts]
 * @returns {Promise<Settled<T, V>[]>} results in the order they settled
 *
 * Settled = { item, ok: true, value, ms } | { item, ok: false, error, ms }
 * A job past its timeout, or every job once `signal` aborts, is aborted and
 * settles as failed. A job's own signal aborts once it settles, so whatever
 * it started (a fetch) is cancelled as soon as its result is no longer needed.
 */
export function settleEach(items, run, { timeoutMs = 3000, signal, onSettled, now = Date.now } = {}) {
  const results = [];
  const jobs = items.map((item) => {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    const start = now();
    const aborted = new Promise((_, reject) =>
      ctrl.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
    );
    if (signal?.aborted) abort();
    return Promise.race([Promise.resolve().then(() => run(item, ctrl.signal)), aborted])
      .then(
        (value) => ({ item, ok: true, value, ms: now() - start }),
        (error) => ({ item, ok: false, error, ms: now() - start }),
      )
      .then((r) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        abort();
        results.push(r);
        onSettled?.(r);
      });
  });
  return Promise.all(jobs).then(() => results);
}
