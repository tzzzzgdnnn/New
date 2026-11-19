// Platform-neutral download logic: quality tiers and their sizes, the record
// the Downloads tab renders, and subtitle opt-in. No DOM, no native bridge,
// so the iOS build (src/platform/ios/downloads.js) and a web build share it.
//
// One source of truth: every live number on a record (bytes, total,
// fragments, percent, speed, state) is the downloader's own. Nothing here
// estimates or remembers progress; it only formats what it is given.

/** 1536 -> "2 KB", 2.25e9 -> "2.1 GB" (binary units, one decimal from GB). */
export function formatBytes(n) {
  if (!(n > 0)) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}

export function formatEta(sec) {
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

/** "1080p · ~2.1 GB" (estimate) / "1080p · 2.1 GB" (exact), or just "1080p". */
export const qualityLabel = (name, bytes, exact = false) =>
  bytes > 0 ? `${name} · ${exact ? "" : "~"}${formatBytes(bytes)}` : name;

/**
 * Download choices for a probe result: one per tier the stream really has
 * (its highest-bitrate variant), best first. A stream with no usable
 * resolutions gets a single "Best available" choice; an MP4 one "Original".
 * Sizes are not known yet (sizing: true); they come from the stream itself
 * (applyMeasurements).
 * Each: { name, label, url, audio, bandwidth, estBytes, exact, sizing }.
 */
export function qualityOptions(probe) {
  const base = { estBytes: 0, exact: false, sizing: true, audio: null, bandwidth: 0 };
  if (probe.kind === "mp4") return [{ ...base, name: "Original", label: "Original", url: null }];
  const variants = probe.variants || [];
  if (!variants.length) return [{ ...base, name: "Best available", label: "Best available", url: null }];
  const option = (name, v) => ({
    ...base,
    name,
    label: name,
    url: v.url,
    audio: v.audio || null,
    bandwidth: v.bandwidth || 0,
  });
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

/** What the downloader's "measure" step is asked for each option. */
export const measureItems = (probe, options) =>
  options.map((o) => ({
    url: o.url || probe.streamUrl,
    audio: o.audio || null,
    bandwidth: o.bandwidth || 0,
    kind: probe.kind === "mp4" ? "mp4" : "hls",
  }));

/** BANDWIDTH (bits/s) × seconds / 8. */
export const bandwidthBytes = (bandwidth, durationSec) =>
  bandwidth > 0 && durationSec > 0 ? Math.round((bandwidth * durationSec) / 8) : 0;

/**
 * Sizes measured from the stream (exact byte ranges / Content-Length, or
 * sampled segment sizes × segment count, or BANDWIDTH × the playlist's own
 * duration) put onto the options. A tier whose playlist could not be read
 * still gets BANDWIDTH × the duration another tier's playlist gave (every
 * tier is the same video), so every tier shows MB/GB when anything is known.
 */
export function applyMeasurements(options, results = []) {
  const duration = Math.max(0, ...results.map((r) => Number(r?.durationSec) || 0));
  return options.map((o, i) => {
    const r = results[i] || {};
    let bytes = Number(r.bytes) || 0;
    let exact = r.method === "exact" && bytes > 0;
    if (!(bytes > 0)) {
      bytes = bandwidthBytes(o.bandwidth, duration);
      exact = false;
    }
    return { ...o, estBytes: bytes, exact, sizing: false, label: qualityLabel(o.name, bytes, exact) };
  });
}

/** Right-hand text of a quality button. */
export const optionSizeText = (o) =>
  o.sizing ? "Measuring…" : o.estBytes > 0 ? `${o.exact ? "" : "~"}${formatBytes(o.estBytes)}` : "Size unknown";

// ── Subtitles (opt-in) ────────────────────────────────────────────────────

const LANG_NAMES = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese",
  ja: "Japanese", ko: "Korean", zh: "Chinese", ar: "Arabic", ru: "Russian", tr: "Turkish",
  nl: "Dutch", pl: "Polish", sv: "Swedish", hi: "Hindi", id: "Indonesian", vi: "Vietnamese",
  th: "Thai", el: "Greek", he: "Hebrew", ro: "Romanian", hu: "Hungarian", cs: "Czech",
  da: "Danish", fi: "Finnish", no: "Norwegian", uk: "Ukrainian", ms: "Malay", fa: "Persian",
};
const NAME_TO_CODE = {
  ...Object.fromEntries(Object.entries(LANG_NAMES).map(([c, n]) => [n.toLowerCase(), c])),
  // Names streams often use in the language itself.
  español: "es", castellano: "es", français: "fr", deutsch: "de", italiano: "it", português: "pt",
  nederlands: "nl", polski: "pl", русский: "ru", türkçe: "tr", 日本語: "ja", 한국어: "ko", 中文: "zh", العربية: "ar",
};

/**
 * Language code of a subtitle label: "en", "English", "eng", "English [CC]",
 * "pt-BR" -> "en"/"en"/"en"/"en"/"pt". "" when the label names no language
 * (e.g. the generic "sub").
 */
export function subtitleLangCode(label) {
  const s = String(label || "").trim().toLowerCase();
  if (!s || s === "sub" || s === "subs" || s === "subtitles") return "";
  const head = s.split(/[\s\-_[(,]/)[0];
  if (LANG_NAMES[head]) return head;
  if (NAME_TO_CODE[head]) return NAME_TO_CODE[head];
  const three = { eng: "en", spa: "es", fre: "fr", fra: "fr", ger: "de", deu: "de", ita: "it", por: "pt", jpn: "ja", kor: "ko", chi: "zh", zho: "zh", ara: "ar", rus: "ru" };
  if (three[head]) return three[head];
  const named = Object.keys(NAME_TO_CODE).find((n) => s.includes(n));
  return named ? NAME_TO_CODE[named] : "";
}

/**
 * Subtitle tracks a stream offers, each once: the same URL twice, or the same
 * language twice, keeps only the first. Unlabeled tracks are numbered so the
 * viewer can tell them apart. Each: { url, lang (as given), code, label }.
 */
export function dedupeSubtitleTracks(tracks = []) {
  const urls = new Set();
  const codes = new Set();
  const out = [];
  let unnamed = 0;
  for (const t of tracks) {
    const url = t?.url;
    if (!url || urls.has(url)) continue;
    urls.add(url);
    const code = subtitleLangCode(t.lang || t.label);
    if (code && codes.has(code)) continue;
    if (code) codes.add(code);
    const label = code ? LANG_NAMES[code] : `Subtitle ${++unnamed}`;
    out.push({ url, lang: code || t.lang || "sub", code, label });
  }
  return out;
}

/**
 * The subtitle choice the picker opens with. Subtitles are never forced:
 * Dub defaults to none; Sub (Japanese audio, subtitles needed) defaults to
 * the preferred language only, if the stream has it. Returns
 * { include, urls } with the chosen tracks' URLs.
 */
export function defaultSubtitleChoice({ tracks = [], dub = false, preferredLang = "en" } = {}) {
  const pref = subtitleLangCode(preferredLang) || String(preferredLang || "").toLowerCase();
  const match = tracks.find((t) => t.code && t.code === pref);
  if (dub || !match) return { include: false, urls: [] };
  return { include: true, urls: [match.url] };
}

/** Tracks to send to the downloader for a choice: only the chosen ones, once each. */
export const chosenSubtitles = (tracks, choice) =>
  choice?.include ? tracks.filter((t) => choice.urls.includes(t.url)).map((t) => ({ url: t.url, lang: t.code || t.lang })) : [];

/** Compact chip text: "EN, ES +3"; "" when no subtitles were chosen. */
export function subtitleChip(subs = [], shown = 2) {
  const names = [];
  for (const s of subs) {
    const n = (subtitleLangCode(s?.lang) || s?.lang || "sub").toUpperCase();
    if (!names.includes(n)) names.push(n);
  }
  if (!names.length) return "";
  const head = names.slice(0, shown).join(", ");
  return names.length > shown ? `${head} +${names.length - shown}` : head;
}

// ── Records ───────────────────────────────────────────────────────────────

/** Status shown on a download, as the downloader reports it. */
export const STATUS_LABEL = {
  queued: "Waiting",
  downloading: "Downloading",
  paused: "Paused",
  error: "Failed",
  completed: "Finished",
};

const STATUS_TEXT = { queued: "Waiting in queue…", paused: "Paused" };
const count = (n) => (Number(n) || 0).toLocaleString("en-US");

/** Downloads that belong in the Active list (anything not finished). */
export const isActiveDownload = (r) => r?.status !== "completed";

/**
 * Downloader job -> the record the Downloads tab renders. `job` carries
 * { id, name, status, progress, bytesDownloaded, totalBytes, totalIsExact, finalBytes,
 *   fragmentsDone, fragmentsTotal, speedBps, etaSec, error, meta (JSON),
 *   subtitles, createdAt, completedAt }; `filePath` is where a finished one plays from.
 * Downloaded bytes are never shown above the total.
 */
export function toDownloadRecord(e, filePath = null) {
  let meta = {};
  try {
    meta = JSON.parse(e.meta || "{}") || {};
  } catch {}
  const done = e.status === "completed";
  const finalBytes = Number(e.finalBytes) || 0;
  const bytes = done ? finalBytes || Number(e.bytesDownloaded) || 0 : Number(e.bytesDownloaded) || 0;
  const total = done ? bytes : Math.max(Number(e.totalBytes) || 0, bytes);
  // "≈" marks a total still estimated from the fragments written so far.
  const approx = !done && !e.totalIsExact ? "≈" : "";
  const size = done
    ? formatBytes(bytes)
    : total > 0
      ? `${formatBytes(bytes) || "0 B"} of ${approx}${formatBytes(total)}`
      : formatBytes(bytes);
  const fragmentsDone = Number(e.fragmentsDone) || 0;
  const fragmentsTotal = Number(e.fragmentsTotal) || 0;
  const downloading = e.status === "downloading";
  const subtitles = (e.subtitles || []).map((s) => ({ lang: s.lang }));
  return {
    ...meta,
    id: e.id,
    name: e.name,
    status: e.status,
    statusLabel: STATUS_LABEL[e.status] || e.status,
    progress: done ? 100 : Math.min(99.9, Math.max(0, Number(e.progress) || 0)),
    bytesDownloaded: bytes,
    totalBytes: total,
    speedBps: downloading ? Number(e.speedBps) || 0 : 0,
    speed: downloading && e.speedBps > 0 ? `${formatBytes(e.speedBps)}/s` : "",
    activeConnections: downloading ? Number(e.activeConnections) || 0 : 0,
    size,
    completedFragments: fragmentsDone,
    totalFragments: fragmentsTotal,
    fragments: fragmentsTotal > 0 && !done ? `${count(fragmentsDone)}/${count(fragmentsTotal)} fragments` : "",
    lastMessage: e.error || STATUS_TEXT[e.status] || (downloading ? formatEta(e.etaSec) : ""),
    filePath: done ? filePath : null,
    subtitles,
    subtitleChip: subtitleChip(subtitles),
    subtitlePaths: [],
    startedAt: e.createdAt,
    completedAt: e.completedAt || null,
  };
}

/** "8 connections · 4.2 MB/s" while fetching, else "". */
export function transferLine(r) {
  if (r?.status !== "downloading") return "";
  const n = r.activeConnections || 0;
  const parts = [];
  if (n > 0) parts.push(`${n} connection${n === 1 ? "" : "s"}`);
  if (r.speed) parts.push(r.speed);
  return parts.join(" · ");
}

/** "1 active · 2 finished" for the Downloads header. */
export function downloadsSummary(records = []) {
  const active = records.filter(isActiveDownload).length;
  const finished = records.length - active;
  return `${active ? `${active} active` : "No active downloads"} · ${finished} finished`;
}
