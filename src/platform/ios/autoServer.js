// Auto server pick for the native player: whether the viewer leaves the
// server to the app (Auto) or picked one by hand, and the per-provider
// speed stats the ranking reads.
import { storage, STORAGE_KEYS } from "../../utils/storage";
import { createServerStats, providerOf } from "../../utils/servers/ranking";

const AUTO_KEY = STORAGE_KEYS.SERVER_AUTO_PICK;
const STATS_KEY = "sb_serverStats";

/** True unless the viewer picked a server by hand since choosing Auto. */
export const isAutoPick = () => storage.get(AUTO_KEY) !== false;
export const setAutoPick = (on) => storage.set(AUTO_KEY, !!on);

/** The server sheet's "Auto" choice: the app picks the server. */
export const AUTO_SERVER = "auto";

/**
 * The active profile's server choice: AUTO_SERVER (the default, also when no
 * server was ever picked) or the id of the server picked by hand.
 */
export function getServerChoice() {
  if (isAutoPick()) return AUTO_SERVER;
  if (storage.get(PIN_KEY) === ANIPM_CHOICE) return ANIPM_CHOICE;
  return storage.get(STORAGE_KEYS.PLAYER_SOURCE) || AUTO_SERVER;
}

/** ani.pm picked by hand (it is not a page source, so it has its own key). */
export const ANIPM_CHOICE = "anipm";
const PIN_KEY = "serverPin";
export const isAnipmPinned = () => !isAutoPick() && storage.get(PIN_KEY) === ANIPM_CHOICE;

/**
 * Save the active profile's server choice. Auto hands the order to the
 * ranking (last server that played the title, then the fastest working one;
 * the native player falls back down the list when one fails). A server id
 * pins that server first. Returns the saved choice.
 */
export function setServerChoice(choice) {
  if (!choice || choice === AUTO_SERVER) {
    setAutoPick(true);
    storage.set(PIN_KEY, null);
    return AUTO_SERVER;
  }
  setAutoPick(false);
  if (choice === ANIPM_CHOICE) {
    // The page keeps its own source (used when ani.pm has no stream).
    storage.set(PIN_KEY, ANIPM_CHOICE);
    return choice;
  }
  storage.set(PIN_KEY, null);
  storage.set(STORAGE_KEYS.PLAYER_SOURCE, choice);
  return choice;
}

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
