// Plays a ranked list one server at a time: the next one takes over when the
// current one fails or stalls (no progress within `stallMs`).

/**
 * @param {T[]} list ranked, best first
 * @param {{ play: (item: T, index: number) => void,
 *           onExhausted?: () => void, stallMs?: number }} opts
 * @returns {{ start(): void, progress(): void, fail(): void, stop(): void,
 *             readonly current: T | undefined }}
 * Call `progress()` whenever the current server shows life (loaded, a
 * segment arrived); it re-arms the stall timer. Once every server failed,
 * `onExhausted` runs once.
 */
export function createFallback(list, { play, onExhausted, stallMs = 8000 }) {
  let index = -1;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(next, stallMs);
  };
  function next() {
    clearTimeout(timer);
    if (index >= list.length) return;
    index += 1;
    if (index >= list.length) {
      onExhausted?.();
      return;
    }
    arm();
    play(list[index], index);
  }
  return {
    start: () => index < 0 && next(),
    progress: () => index >= 0 && index < list.length && arm(),
    fail: () => index >= 0 && next(),
    stop: () => {
      clearTimeout(timer);
      index = list.length;
    },
    get current() {
      return list[index];
    },
  };
}
