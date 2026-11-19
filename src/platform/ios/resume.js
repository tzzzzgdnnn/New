// Resume points for the native player: where a title/episode was left, what
// the page's play button should say, and saving the native player's reports.
// Progress lives in the same keys the desktop app uses (progress map,
// "dlTime_<key>" seconds), so Continue Watching and episode bars stay in sync.
import { storage } from "../../utils/storage";

/** Saved spots shorter than this are treated as "not started". */
export const MIN_RESUME_SECONDS = 10;
/** A saved spot inside the last 3% of the runtime starts over instead. */
export const RESUME_END_FRACTION = 0.97;
/** 95% watched (or inside the outro) counts as finished. */
export const FINISHED_FRACTION = 0.95;

const TIME_PREFIX = "dlTime_";
const DURATION_PREFIX = "sbDur_";
const LAST_EPISODE_PREFIX = "sbLastEp_";

/**
 * Progress key shared with the desktop code.
 * @param {{type: "movie"|"tv", id: number|string, season?: number, episode?: number}} t
 * @returns {string}
 */
export function progressKeyFor({ type, id, season, episode }) {
  return type === "movie" ? `movie_${id}` : `tv_${id}_s${season}e${episode}`;
}

/**
 * Seconds to resume from, or 0 when the title should start from the top.
 * @param {string} key progress key
 * @returns {number}
 */
export function getResumeSeconds(key) {
  if (!key) return 0;
  const seconds = Number(storage.get(TIME_PREFIX + key)) || 0;
  const duration = Number(storage.get(DURATION_PREFIX + key)) || 0;
  if (seconds < MIN_RESUME_SECONDS) return 0;
  if (duration > 0 && seconds / duration >= RESUME_END_FRACTION) return 0;
  return seconds;
}

/** Forget the saved spot (used by "Restart"). */
export function clearResume(key) {
  if (key) storage.set(TIME_PREFIX + key, 0);
}

/**
 * Last episode played for a series, or null.
 * @returns {{season: number, episode: number, at: number} | null}
 */
export function getLastEpisode(tvId) {
  const v = storage.get(LAST_EPISODE_PREFIX + tvId);
  return v && Number.isFinite(v.season) && Number.isFinite(v.episode) ? v : null;
}

/** "12:34" or "1:02:03". */
export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * Save one progress report from the native player.
 * @param {{key: string, time: number, duration: number, inOutro?: boolean}} report
 * @param {{saveProgress: (key: string, pct: number) => void, markWatched: (key: string) => void}} sinks
 * @returns {boolean} true when the report was saved
 */
export function saveNativeProgress(report, { saveProgress, markWatched }) {
  const { key, time, duration, inOutro } = report || {};
  if (typeof key !== "string" || !key || !(time >= 0) || !(duration > 0)) return false;
  const fraction = Math.min(time / duration, 1);
  const finished = fraction >= FINISHED_FRACTION || !!inOutro;
  saveProgress(key, finished ? 100 : Math.floor(fraction * 100));
  storage.set(TIME_PREFIX + key, Math.floor(time));
  storage.set(DURATION_PREFIX + key, Math.floor(duration));
  const m = key.match(/^tv_(\d+)_s(\d+)e(\d+)$/);
  if (m) {
    storage.set(LAST_EPISODE_PREFIX + m[1], {
      season: Number(m[2]),
      episode: Number(m[3]),
      at: Date.now(),
    });
  }
  if (finished) markWatched(key);
  return true;
}

/** Whether a progress key counts as finished (watched mark or ≥95%). */
export function isFinished(key, progress, watched) {
  return !!watched?.[key] || (progress?.[key] || 0) >= FINISHED_FRACTION * 100;
}
