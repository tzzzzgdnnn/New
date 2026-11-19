// iOS side of the downloader API (window.electron.*Download*): the native
// DownloadManager (Downloads.swift) does the fetching; this maps its jobs onto
// the records the Downloads page and App.jsx already use, and turns a stream's
// variants into the quality choices the picker shows.
import { movyCandidates } from "./movy";
import { downloadCandidates, downloadContext, currentAudioMode } from "./webview";
import { recordLookup } from "./autoServer";
import { getResumeSeconds, progressKeyFor } from "./resume";
import { diag } from "../../utils/diag";
import {
  applyMeasurements,
  dedupeSubtitleTracks,
  downloadKey,
  downloadMeta,
  episodeDownloadName,
  measureItems,
  qualityOptions,
  sameQuality,
  streamHeight,
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
    fallbackPlans.delete(e?.id);
    return null;
  }
  if (e.status === "error") restartElsewhere(e.id);
  else if (e.status === "completed") fallbackPlans.delete(e.id);
  return rememberRecord(toRecord(e));
}

const idOf = (path) => (String(path || "").startsWith(DL_SCHEME) ? String(path).slice(DL_SCHEME.length) : null);

/**
 * Find a stream for a movie/episode on the best server and list its download
 * choices: { ok, streamUrl, headers, subtitles, options, ctx, tried } or
 * { ok: false, error }. Servers are ranked by speed and picture quality; the
 * native lookup tries them in that order and the first playable stream wins.
 * `ctx` and `tried` let a failed download restart on the next server.
 * The options' sizes are filled in by measureOptions().
 */
export async function probeDownload({ season = null, episode = null, ctx = null, exclude = [] } = {}) {
  const override =
    season != null && episode != null ? { season, episode, tmdbSeason: season, tmdbEpisode: episode } : {};
  const context = ctx || downloadContext(override);
  const [ranked, movy] = await Promise.all([
    downloadCandidates(context, { exclude }),
    context?.isAnime ? [] : movyCandidates(context).catch(() => []),
  ]);
  // Movy's direct stream first (no page to sniff), unless it already failed.
  const candidates = [...movy.filter((c) => !exclude.includes(c.id)), ...ranked];
  if (!candidates.length) return { ok: false, error: "No server returned a downloadable stream" };
  const at = Date.now();
  const res = await call("probe", { candidates });
  recordLookup(res, candidates, Date.now() - at, streamHeight(res));
  if (!res?.ok) {
    diag("download", "probe failed:", res?.error || "unknown");
    return res || { ok: false, error: "Download lookup failed" };
  }
  return {
    ...res,
    subtitles: dedupeSubtitleTracks(res.subtitles || []),
    options: qualityOptions(res),
    ctx: context,
    tried: [...exclude, res.server].filter(Boolean),
  };
}

// The next server's stream for a download, at the same quality and with the
// same subtitle languages when it has them; null when no server is left.
async function nextServer({ probe, option, subtitles = [] }) {
  if (!probe.ctx) return null;
  const next = await probeDownload({ ctx: probe.ctx, exclude: probe.tried });
  if (!next.ok) return null;
  const langs = new Set(subtitles.map((t) => t.lang));
  return {
    probe: next,
    option: sameQuality(next.options, option),
    subtitles: next.subtitles.filter((t) => langs.has(t.lang)),
  };
}

// Jobs that can move to another server if they fail: id -> their start args.
const fallbackPlans = new Map();

// A download failed: start it again on the next server, then drop the failed
// job. With no server left the failed job stays, so the viewer sees why.
async function restartElsewhere(id) {
  const args = fallbackPlans.get(id);
  if (!args) return;
  fallbackPlans.delete(id);
  const next = await nextServer(args);
  if (!next) return;
  diag("download", `${id} failed on ${args.probe.server}; retrying on ${next.probe.server}`);
  const res = await iosDownloadApi.runDownload({ ...args, ...next });
  if (res.ok) await iosDownloadApi.deleteDownload({ id }).catch(() => {});
}

// Hand one download to the native downloader. A job found through
// probeDownload remembers how to move to another server if it fails.
async function startJob(args) {
  const { probe, option } = args;
  const id = `dl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; // unique even for two starts in one ms
  // Episodes carry show id/name and numeric season/episode for grouping.
  const meta = downloadMeta(args, probe.ctx || {});
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
  if (probe.ctx) fallbackPlans.set(id, args);
  // The page shows the native job itself, never a record made up here.
  let record = null;
  try {
    const job = (await call("list")).find((e) => e.id === id);
    if (job) record = rememberRecord(toRecord(job));
  } catch {}
  return { ok: true, id, record };
}

// A job that cannot start moves on to the next server.
async function startWithFallback(args) {
  const res = await startJob(args);
  if (res.ok) return res;
  const next = await nextServer(args);
  return next ? startWithFallback({ ...args, ...next }) : res;
}

// Starts in flight, by title/episode key, so a double tap starts one job.
const starting = new Map();

// The job already downloading (or downloaded) for this title/episode, if any.
// A failed job does not count: starting again is how it gets retried.
async function existingJob(key) {
  try {
    for (const e of await call("list")) {
      const r = toRecord(e);
      if (r.status !== "error" && downloadKey(r) === key) return rememberRecord(r);
    }
  } catch {}
  return null;
}

/** window.electron download API, iOS edition. */
export const iosDownloadApi = {
  checkDownloader: async () => ({ ok: !!native(), token: "ios" }),
  // args: the desktop runDownload args plus { probe, option } from the iOS
  // picker. Starting a title/episode that already has a job returns that
  // job ({ duplicate: true }) instead of queueing it twice.
  runDownload: async (args) => {
    if (!args.probe?.streamUrl) return { ok: false, error: "No stream found" };
    const key = downloadKey({ ...downloadMeta(args, args.probe.ctx || {}), name: args.name });
    if (!key) return startWithFallback(args);
    if (starting.has(key)) return starting.get(key);
    const run = (async () => {
      const existing = await existingJob(key);
      if (existing) {
        diag("download", `"${args.name}" is already a download (${existing.id}); not starting it twice`);
        return { ok: true, id: existing.id, record: existing, duplicate: true };
      }
      return startWithFallback(args);
    })().finally(() => starting.delete(key));
    starting.set(key, run);
    return run;
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

/**
 * Queue several episodes of one show at one quality (the episode picker's
 * batch). Each episode gets its own stream (same servers as Play) at the
 * same tier when it has it, and the subtitle languages chosen once. An
 * episode that already has a job is skipped, never queued twice. All of them
 * carry the show's id and name, so they land in one show group.
 * `first` reuses the probe the picker already made for that episode.
 * Returns { ok, started: [id], records, skipped: [ep], failed: [{ ...ep, error }] }.
 */
export async function downloadEpisodes({
  show, // { tmdbId, name, posterPath, anilistId }
  episodes = [], // [{ season, episode, tmdbSeason?, tmdbEpisode?, ctx? }]
  option,
  subtitleLangs = [],
  first = null, // { season, episode, probe }
  ctx = downloadContext(),
  probe = probeDownload,
  onProgress,
}) {
  const started = [];
  const records = [];
  const skipped = [];
  const failed = [];
  const langs = new Set(subtitleLangs);
  for (const [i, ep] of episodes.entries()) {
    onProgress?.({ done: i, total: episodes.length, episode: ep });
    const season = Number(ep.season);
    const episode = Number(ep.episode);
    const args = {
      name: episodeDownloadName(show.name, season, episode),
      showName: show.name,
      mediaId: show.tmdbId,
      tmdbId: show.tmdbId,
      anilistId: show.anilistId ?? null,
      mediaType: "tv",
      season,
      episode,
      posterPath: show.posterPath || null,
    };
    const key = downloadKey({ ...downloadMeta(args), name: args.name });
    if (key && (await existingJob(key))) {
      skipped.push(ep);
      continue;
    }
    const reuse = first && Number(first.season) === season && Number(first.episode) === episode;
    let found = reuse ? first.probe : null;
    if (!found) {
      try {
        found = await probe({
          ctx: {
            ...ctx,
            ...(ep.ctx || {}),
            season,
            episode,
            tmdbSeason: ep.tmdbSeason ?? season,
            tmdbEpisode: ep.tmdbEpisode ?? episode,
          },
        });
      } catch (e) {
        found = { ok: false, error: e?.message || "Download lookup failed" };
      }
    }
    if (!found?.ok) {
      failed.push({ ...ep, error: found?.error || "No downloadable stream found" });
      continue;
    }
    let pick = sameQuality(found.options || [], option);
    if (pick && !reuse) pick = (await measureOptions(found, [pick]))[0] || pick;
    const subtitles = (found.subtitles || [])
      .filter((t) => langs.has(t.code || t.lang))
      .map((t) => ({ url: t.url, lang: t.code || t.lang }));
    const res = await iosDownloadApi.runDownload({ ...args, probe: found, option: pick, subtitles });
    if (res.ok && res.duplicate) skipped.push(ep);
    else if (res.ok) {
      started.push(res.id);
      if (res.record) records.push(res.record);
    }
    else failed.push({ ...ep, error: res.error || "Could not start" });
  }
  onProgress?.({ done: episodes.length, total: episodes.length, episode: null });
  return { ok: failed.length === 0, started, records, skipped, failed };
}

export { currentAudioMode };
