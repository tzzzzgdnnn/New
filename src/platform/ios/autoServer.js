// Auto server pick for the native player: whether the viewer leaves the
// server to the app (Auto) or picked one by hand, and the per-provider
// speed stats the ranking reads.
import { storage } from "../../utils/storage";
import { createServerStats, providerOf } from "../../utils/servers/ranking";

const AUTO_KEY = "serverAutoPick";
const STATS_KEY = "sb_serverStats";

/** True unless the viewer picked a server by hand since choosing Auto. */
export const isAutoPick = () => storage.get(AUTO_KEY) !== false;
export const setAutoPick = (on) => storage.set(AUTO_KEY, !!on);

export const serverStats = createServerStats({
  get: () => {
    try {
      return JSON.parse(localStorage.getItem(STATS_KEY) || "null");
    } catch {
      return null;
    }
  },
  set: (map) => {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(map));
    } catch {}
  },
});

/**
 * Feed the ranking with a real stream lookup (native player or download
 * probe): the server that yielded a stream gets its time and best picture
 * height; when none did, every server tried gets a miss.
 */
export function recordLookup(result, candidates, ms, height = 0) {
  if (result?.ok) {
    if (result.server) serverStats.record(providerOf({ id: result.server }), { ok: true, ms, height });
    return;
  }
  for (const p of new Set(candidates.map(providerOf))) serverStats.record(p, { ok: false });
}
