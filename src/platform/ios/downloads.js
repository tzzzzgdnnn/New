// iOS side of the downloader API (window.electron.*Download*): the native
// DownloadManager (Downloads.swift) does the fetching; this maps its jobs onto
// the records the Downloads page and App.jsx already use, and turns a stream's
// variants into the quality choices the picker shows.
import { downloadCandidates } from "./webview";
import { getResumeSeconds, progressKeyFor } from "./resume";
import { diag } from "../../utils/diag";

const native = () => window.webkit?.messageHandlers?.sbDownload || null;
const call = async (op, args = {}) => {
  const h = native();
  if (!h) throw new Error("Downloads need the iOS app");
  return h.postMessage({ op, ...args });
};

/** Prefix of filePath values that point at a native download. */
export const DL_SCHEME = "sbdl://";

/** 1536 -> "2 KB", 2.25e9 -> "2.1 GB" (binary units, one decimal from GB). */
export function formatBytes(n) {
  if (!(n > 0)) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}

function formatEta(sec) {
  if (!(sec > 0)) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}h ${m}m left` : m ? `${m}m ${s}s left` : `${s}s left`;
}

// ── Quality choices ───────────────────────────────────────────────────────

/** Tiers offered, best first: [height, label]. */
export const QUALITY_TIERS = [
  [2160, "4K"],
  [1440, "1440p"],
  [1080, "1080p"],
  [720, "720p"],
  [480, "480p"],
];

/**
 * Tier of a variant: the highest one its picture reaches (5% slack for odd
 * encodes). Width counts too, so a 1920×800 scope film is 1080p. Below 480p
 * there is no tier.
 */
export function tierOf({ width = 0, height = 0 }) {
  const lines = Math.max(height, Math.round((width * 9) / 16));
  return QUALITY_TIERS.find(([h]) => lines * 1.05 >= h) || null;
}

/** Size estimate: bits per second × seconds / 8. */
export const estimateBytes = (bandwidth, durationSec) =>
  bandwidth > 0 && durationSec > 0 ? Math.round((bandwidth * durationSec) / 8) : 0;

/** "1080p · ~2.1 GB", or just "1080p" without an estimate. */
export const qualityLabel = (name, bytes) => (bytes > 0 ? `${name} · ~${formatBytes(bytes)}` : name);

/**
 * Download choices for a probe result: one per tier the stream really has
 * (its highest-bitrate variant), best first. A stream with no usable
 * resolutions gets a single "Best available" choice; an MP4 one "Original".
 * Each: { label, url?, audio?, estBytes }.
 */
export function qualityOptions(probe, durationSec) {
  if (probe.kind === "mp4") return [{ label: "Original", estBytes: 0 }];
  const variants = probe.variants || [];
  if (!variants.length) return [{ label: "Best available", estBytes: 0 }];
  const option = (name, v) => {
    const estBytes = estimateBytes(v.bandwidth, durationSec);
    return { label: qualityLabel(name, estBytes), url: v.url, audio: v.audio || null, estBytes };
  };
  const best = new Map(); // tier height -> variant
  for (const v of variants) {
    const tier = tierOf(v);
    if (tier && !(best.get(tier[0])?.bandwidth >= v.bandwidth)) best.set(tier[0], v);
  }
  if (!best.size) {
    const top = variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
    return [option("Best available", top)];
  }
  return QUALITY_TIERS.filter(([h]) => best.has(h)).map(([h, name]) => option(name, best.get(h)));
}

// ── Records ───────────────────────────────────────────────────────────────

const STATUS_TEXT = { queued: "Waiting in queue…", paused: "Paused" };

/** Native job -> download record used across the app. */
export function toRecord(e) {
  let meta = {};
  try {
    meta = JSON.parse(e.meta || "{}") || {};
  } catch {}
  const done = e.status === "completed";
  const size = done
    ? formatBytes(e.finalBytes)
    : e.totalBytes > 0
      ? `${formatBytes(e.bytes) || "0 B"} of ~${formatBytes(e.totalBytes)}`
      : formatBytes(e.bytes);
  return {
    ...meta,
    id: e.id,
    name: e.name,
    status: e.status,
    progress: Number(e.progress) || 0,
    speed: e.status === "downloading" && e.speedBps > 0 ? `${formatBytes(e.speedBps)}/s` : "",
    size,
    completedFragments: e.completedFragments,
    totalFragments: e.totalFragments,
    lastMessage: e.error || STATUS_TEXT[e.status] || (e.status === "downloading" ? formatEta(e.etaSec) : ""),
    filePath: done ? DL_SCHEME + e.id : null,
    subtitles: (e.subtitles || []).map((s) => ({ lang: s.lang })),
    subtitlePaths: [],
    startedAt: e.createdAt,
    completedAt: e.completedAt || null,
  };
}

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
 */
export async function probeDownload({ season = null, episode = null, runtimeMin = 0 } = {}) {
  const override =
    season != null && episode != null ? { season, episode, tmdbSeason: season, tmdbEpisode: episode } : {};
  const res = await call("probe", { candidates: downloadCandidates(override) });
  if (!res?.ok) {
    diag("download", "probe failed:", res?.error || "unknown");
    return res || { ok: false, error: "Download lookup failed" };
  }
  return { ...res, options: qualityOptions(res, (runtimeMin || 0) * 60) };
}

/** window.electron download API, iOS edition. */
export const iosDownloadApi = {
  checkDownloader: async () => ({ ok: !!native(), token: "ios" }),
  // args: the desktop runDownload args plus { probe, option } from the iOS picker.
  runDownload: async (args) => {
    const { probe, option } = args;
    if (!probe?.streamUrl) return { ok: false, error: "No stream found" };
    const id = `dl${Date.now().toString(36)}`;
    const meta = {
      mediaId: args.mediaId,
      mediaType: args.mediaType,
      season: args.season ?? null,
      episode: args.episode ?? null,
      posterPath: args.posterPath || null,
      tmdbId: args.tmdbId || args.mediaId || null,
      quality: option?.label || null,
    };
    const res = await call("start", {
      id,
      name: args.name,
      streamUrl: probe.streamUrl,
      variantUrl: option?.url || null,
      audioUrl: option?.audio || null,
      headers: probe.headers || {},
      estBytes: option?.estBytes || 0,
      subtitles: probe.subtitles || [],
      meta: JSON.stringify(meta),
    });
    diag("download", `start ${id} "${args.name}" ${option?.label || ""}: ${res?.ok ? "ok" : res?.error}`);
    return res?.ok ? { ok: true, id } : { ok: false, error: res?.error || "Could not start" };
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
      return (await call("list")).reduce((n, e) => n + (e.finalBytes || e.bytes || 0), 0);
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
