// iOS side of the downloader API (window.electron.*Download*): the native
// DownloadManager (Downloads.swift) does the fetching; this maps its jobs onto
// the records the Downloads page and App.jsx already use, and turns a stream's
// variants into the quality choices the picker shows.
import { downloadCandidates, currentAudioMode } from "./webview";
import { getResumeSeconds, progressKeyFor } from "./resume";
import { diag } from "../../utils/diag";
import {
  applyMeasurements,
  dedupeSubtitleTracks,
  measureItems,
  qualityOptions,
  toDownloadRecord,
} from "../../utils/downloadMath";

const native = () => window.webkit?.messageHandlers?.sbDownload || null;
const call = async (op, args = {}) => {
  const h = native();
  if (!h) throw new Error("Downloads need the iOS app");
  return h.postMessage({ op, ...args });
};

/** Prefix of filePath values that point at a native download. */
export const DL_SCHEME = "sbdl://";

export { formatBytes, qualityLabel, qualityOptions, tierOf, QUALITY_TIERS, STATUS_LABEL } from "../../utils/downloadMath";

/** Asks the native downloader for every option's size; never throws. */
export async function measureOptions(probe, options) {
  try {
    const res = await call("measure", { items: measureItems(probe, options), headers: probe.headers || {} });
    return applyMeasurements(options, Array.isArray(res) ? res : []);
  } catch (e) {
    diag("download", "measure failed:", e?.message || e);
    return applyMeasurements(options, []);
  }
}

/** Native job -> download record used across the app (formatting only). */
export const toRecord = (e) => toDownloadRecord(e, e.status === "completed" ? DL_SCHEME + e.id : null);

// Last known record per id (list + live events), for offline playback context.
const records = new Map();
export const rememberRecord = (r) => (records.set(r.id, r), r);

/** Native "download changed" event -> a record for the download-progress listeners. */
export function recordFromEvent(e) {
  if (!e || e.removed) {
    if (e?.id) records.delete(e.id);
    return null;
  }
  return rememberRecord(toRecord(e));
}

const idOf = (path) => (String(path || "").startsWith(DL_SCHEME) ? String(path).slice(DL_SCHEME.length) : null);

/**
 * Find a stream for a movie/episode and list its download choices:
 * { ok, streamUrl, headers, subtitles, options } or { ok: false, error }.
 * The options' sizes are filled in by measureOptions().
 */
export async function probeDownload({ season = null, episode = null } = {}) {
  const override =
    season != null && episode != null ? { season, episode, tmdbSeason: season, tmdbEpisode: episode } : {};
  const res = await call("probe", { candidates: downloadCandidates(override) });
  if (!res?.ok) {
    diag("download", "probe failed:", res?.error || "unknown");
    return res || { ok: false, error: "Download lookup failed" };
  }
  return { ...res, subtitles: dedupeSubtitleTracks(res.subtitles || []), options: qualityOptions(res) };
}

/** window.electron download API, iOS edition. */
export const iosDownloadApi = {
  checkDownloader: async () => ({ ok: !!native(), token: "ios" }),
  // args: the desktop runDownload args plus { probe, option } from the iOS picker.
  runDownload: async (args) => {
    const { probe, option } = args;
    if (!probe?.streamUrl) return { ok: false, error: "No stream found" };
    const id = `dl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; // unique even for two starts in one ms
    const meta = {
      mediaId: args.mediaId,
      mediaType: args.mediaType,
      season: args.season ?? null,
      episode: args.episode ?? null,
      posterPath: args.posterPath || null,
      tmdbId: args.tmdbId || args.mediaId || null,
      quality: option?.name || option?.label || null,
    };
    const res = await call("start", {
      id,
      name: args.name,
      streamUrl: probe.streamUrl,
      variantUrl: option?.url || null,
      audioUrl: option?.audio || null,
      headers: probe.headers || {},
      estBytes: option?.estBytes || 0,
      // Only the tracks the viewer chose in the picker, each once.
      subtitles: args.subtitles || [],
      meta: JSON.stringify(meta),
    });
    diag("download", `start ${id} "${args.name}" ${option?.label || ""}: ${res?.ok ? "ok" : res?.error}`);
    if (!res?.ok) return { ok: false, error: res?.error || "Could not start" };
    // The page shows the native job itself, never a record made up here.
    let record = null;
    try {
      const job = (await call("list")).find((e) => e.id === id);
      if (job) record = rememberRecord(toRecord(job));
    } catch {}
    return { ok: true, id, record };
  },
  getDownloads: async () => {
    try {
      return (await call("list")).map((e) => rememberRecord(toRecord(e)));
    } catch {
      return [];
    }
  },
  deleteDownload: async ({ id }) => {
    await call("remove", { id });
    records.delete(id);
    return { ok: true };
  },
  pauseDownload: (id) => call("pause", { id }),
  resumeDownload: (id) => call("resume", { id }),
  // The native side drops finished downloads whose folder is gone, so a
  // known completed record means the files are there.
  fileExists: async (path) => records.get(idOf(path))?.status === "completed",
  openPath: (path) => iosDownloadApi.openPathAtTime(path),
  // Offline playback in the native player; progress is saved per profile
  // through the usual progress key.
  openPathAtTime: async (path, seconds = 0) => {
    const id = idOf(path);
    const r = id && records.get(id);
    if (!r) return undefined;
    const type = r.mediaType === "tv" ? "tv" : "movie";
    const progressKey = r.tmdbId
      ? progressKeyFor({ type, id: r.tmdbId, season: r.season, episode: r.episode })
      : null;
    const ctx = {
      title: r.name || "",
      type,
      season: r.season ?? null,
      episode: r.episode ?? null,
      progressKey,
      startAt: seconds > 0 ? seconds : progressKey ? getResumeSeconds(progressKey) : 0,
    };
    if (!(await call("play", { id, ctx }))) diag("download", `offline play ${id} failed`);
    return undefined;
  },
  pruneSubtitlePaths: async () => ({ ok: true, subtitlePaths: [] }),
  getDownloadsSize: async () => {
    try {
      return (await call("list")).reduce((n, e) => n + (Number(e.finalBytes) || Number(e.bytesDownloaded) || 0), 0);
    } catch {
      return -1;
    }
  },
  deleteAllDownloads: async () => {
    for (const e of await call("list")) await call("remove", { id: e.id });
    records.clear();
    return { ok: true };
  },
};

export { currentAudioMode };
