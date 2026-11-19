// Dev-only: iOS downloader JS side (quality tiers, size math, records,
// queue/pause calls to the native bridge). Not bundled.
import assert from "node:assert/strict";
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.window = globalThis;
window.addEventListener = () => {};
globalThis.document = { addEventListener: () => {}, visibilityState: "visible" };
globalThis.location = { pathname: "/index.html" };

// Fake native DownloadManager: a queue where one job runs at a time.
const jobs = [];
const sent = [];
window.webkit = {
  messageHandlers: {
    sbDiag: { postMessage: async () => true },
    sbDownload: {
      postMessage: async (m) => {
        sent.push(m);
        const job = jobs.find((j) => j.id === m.id);
        switch (m.op) {
          case "start":
            jobs.push({ id: m.id, name: m.name, status: jobs.some((j) => j.status === "downloading") ? "queued" : "downloading", meta: m.meta, bytesDownloaded: 0, totalBytes: m.estBytes, subtitles: m.subtitles });
            return { ok: true, id: m.id };
          case "pause": if (["queued", "downloading"].includes(job?.status)) job.status = "paused"; return true;
          case "resume": if (["paused", "error"].includes(job?.status)) job.status = "queued"; return true;
          case "remove": jobs.splice(jobs.indexOf(job), 1); return true;
          case "list": return jobs.map((j) => ({ ...j }));
          case "play": return job?.status === "completed";
          case "measure": return m.items.map((it) => (it.url === "u/broken" ? { bytes: 0, method: "unknown" } : { bytes: it.url.length * GB, durationSec: 3600, method: it.kind === "mp4" ? "exact" : "sampled" }));
          default: throw new Error("unknown op " + m.op);
        }
      },
    },
  },
};

const d = await import("../src/platform/ios/downloads.js");
const m = await import("../src/utils/downloadMath.js");
const api = d.iosDownloadApi;
let pass = 0;
const t = async (n, f) => { await f(); pass++; console.log("ok -", n); };
const GB = 1024 ** 3;

await t("labels read like '1080p · ~2.1 GB' (estimate) or '1080p · 2.1 GB' (exact)", () => {
  assert.equal(m.qualityLabel("1080p", 2.1 * GB), "1080p · ~2.1 GB");
  assert.equal(m.qualityLabel("720p", 850 * 1024 ** 2, true), "720p · 850 MB");
  assert.equal(m.qualityLabel("4K", 0), "4K");
});

await t("tiers: highest one reached, width counts, nothing below 480p", () => {
  const tier = (width, height) => d.tierOf({ width, height })?.[1] ?? null;
  assert.equal(tier(3840, 2160), "4K");
  assert.equal(tier(2560, 1440), "1440p");
  assert.equal(tier(1920, 1080), "1080p");
  assert.equal(tier(1920, 800), "1080p"); // scope film
  assert.equal(tier(1920, 1072), "1080p"); // odd encode
  assert.equal(tier(1280, 720), "720p");
  assert.equal(tier(854, 480), "480p");
  assert.equal(tier(640, 360), null);
  assert.equal(tier(0, 0), null);
});

await t("options: only tiers the stream has, best bitrate per tier, best first, sized later", () => {
  const probe = {
    kind: "hls",
    variants: [
      { url: "u/480", width: 854, height: 480, bandwidth: 1_000_000 },
      { url: "u/1080lo", width: 1920, height: 1080, bandwidth: 4_000_000 },
      { url: "u/1080hi", width: 1920, height: 1080, bandwidth: 6_000_000, audio: "a/en" },
      { url: "u/360", width: 640, height: 360, bandwidth: 600_000 },
    ],
  };
  const opts = m.qualityOptions(probe);
  assert.deepEqual(opts.map((o) => o.url), ["u/1080hi", "u/480"]);
  assert.ok(opts.every((o) => o.sizing && o.estBytes === 0));
  assert.equal(opts[0].audio, "a/en");
  assert.equal(opts[1].audio, null);
});

await t("options: fallbacks for no resolutions, media playlist, and MP4", () => {
  const noRes = m.qualityOptions({ kind: "hls", variants: [{ url: "a", bandwidth: 1 }, { url: "b", bandwidth: 9_000_000 }] });
  assert.deepEqual(noRes.map((o) => [o.name, o.url]), [["Best available", "b"]]);
  assert.equal(m.qualityOptions({ kind: "hls" })[0].name, "Best available");
  assert.equal(m.qualityOptions({ kind: "mp4" })[0].name, "Original");
  // A media playlist / MP4 is measured at the stream URL itself.
  const items = m.measureItems({ kind: "mp4", streamUrl: "s.mp4" }, m.qualityOptions({ kind: "mp4" }));
  assert.deepEqual(items, [{ url: "s.mp4", audio: null, bandwidth: 0, kind: "mp4" }]);
});

await t("size estimate: from the stream; every tier gets MB/GB (anime with no TMDB runtime too)", async () => {
  const probe = { kind: "hls", streamUrl: "m", headers: {}, variants: [
    { url: "u/1080", width: 1920, height: 1080, bandwidth: 8_000_000 },
    { url: "u/broken", width: 1280, height: 720, bandwidth: 4_000_000 },
  ] };
  const sized = await d.measureOptions(probe, m.qualityOptions(probe));
  assert.equal(sized[0].estBytes, 6 * GB); // what the stream measured, not a TMDB guess
  assert.equal(sized[0].label, "1080p · ~6.0 GB");
  // Unreadable tier: BANDWIDTH × the duration the other tier's playlist gave.
  assert.equal(sized[1].estBytes, 1_800_000_000);
  assert.ok(sized.every((o) => !o.sizing && /[MG]B$/.test(o.label)));
  assert.equal(m.applyMeasurements([{ name: "Original", bandwidth: 0 }], [{ bytes: 5, method: "exact" }])[0].label, "Original · 5 B");
  assert.equal(m.optionSizeText({ sizing: false, estBytes: 0 }), "Size unknown");
});

await t("progress math: the downloader's numbers, never downloaded > total", () => {
  // The reported case: 638 MB in 303 of 1586 fragments; native refined the total.
  const total = Math.round((638 * 1024 ** 2 / 303) * 1586);
  const r = d.toRecord({ id: "a", status: "downloading", bytesDownloaded: 638 * 1024 ** 2, totalBytes: total, progress: 19.1, fragmentsDone: 303, fragmentsTotal: 1586, speedBps: 5e6, etaSec: 90 });
  assert.equal(r.size, "638 MB of ≈3.3 GB"); // estimate marked as one
  // % , MB and fragments agree: 303/1586 = 19.1% = 638 MB of 3.3 GB.
  assert.ok(Math.abs(r.bytesDownloaded / r.totalBytes - 303 / 1586) < 1e-6);
  const exact = d.toRecord({ id: "a", status: "downloading", bytesDownloaded: GB, totalBytes: 2 * GB, totalIsExact: true, progress: 50 });
  assert.equal(exact.size, "1.0 GB of 2.0 GB");
  assert.equal(r.fragments, "303/1,586 fragments");
  assert.equal(r.progress, 19.1);
  assert.equal(r.speed, "5 MB/s");
  assert.equal(m.transferLine({ ...r, activeConnections: 8 }), "8 connections · 5 MB/s");
  assert.equal(r.lastMessage, "1m 30s left");
  const over = d.toRecord({ id: "a", status: "downloading", bytesDownloaded: 700, totalBytes: 600, progress: 120 });
  assert.equal(over.totalBytes, 700);
  assert.ok(over.progress < 100);
});

await t("finished state: 100%, real size, playable, listed as finished", () => {
  const c = d.toRecord({ id: "a", status: "completed", finalBytes: 3 * GB, bytesDownloaded: 3 * GB, totalBytes: 2 * GB, progress: 99 });
  assert.equal(c.progress, 100);
  assert.equal(c.size, "3.0 GB");
  assert.equal(c.statusLabel, "Finished");
  assert.equal(c.filePath, d.DL_SCHEME + "a");
  assert.equal(c.fragments, "");
  assert.equal(m.isActiveDownload(c), false);
  const p = d.toRecord({ id: "b", status: "paused", bytesDownloaded: 1, totalBytes: 2, speedBps: 9e9 });
  assert.equal(m.isActiveDownload(p), true);
  assert.equal(p.speed, "");
  assert.equal(p.filePath, null);
  assert.equal(m.downloadsSummary([c, p]), "1 active · 1 finished");
  assert.equal(m.downloadsSummary([c]), "No active downloads · 1 finished");
});

await t("records: status text, meta, bad meta tolerated", () => {
  const meta = JSON.stringify({ tmdbId: 7, mediaType: "movie" });
  const q = d.toRecord({ id: "a", name: "A", status: "queued", meta, bytesDownloaded: 0, totalBytes: 2 * GB });
  assert.equal(q.lastMessage, "Waiting in queue…");
  assert.equal(q.size, "0 B of ≈2.0 GB");
  assert.equal(q.tmdbId, 7);
  assert.equal(d.toRecord({ id: "a", status: "error", error: "Server error (HTTP 404)" }).lastMessage, "Server error (HTTP 404)");
  assert.equal(d.toRecord({ id: "a", status: "downloading", meta: "{bad" }).id, "a");
});

await t("subtitles: deduped tracks with real language labels; compact chip", () => {
  const raw = [
    { url: "s1", lang: "sub" }, { url: "s1", lang: "sub" }, { url: "s2", lang: "English" },
    { url: "s3", lang: "en" }, { url: "s4", lang: "Español" }, { url: "s5", lang: "spa" }, { url: "s6", lang: "fr" },
  ];
  const tracks = m.dedupeSubtitleTracks(raw);
  assert.deepEqual(tracks.map((t) => t.label), ["Subtitle 1", "English", "Spanish", "French"]);
  assert.equal(m.subtitleChip([{ lang: "en" }, { lang: "es" }, { lang: "fr" }, { lang: "de" }, { lang: "en" }]), "EN, ES +2");
  assert.equal(m.subtitleChip([]), "");
  assert.equal(d.toRecord({ id: "x", status: "queued" }).subtitleChip, "");
});

await t("subtitles: opt-in; off for dub, preferred language only for sub", () => {
  const tracks = m.dedupeSubtitleTracks([{ url: "e", lang: "English" }, { url: "s", lang: "es" }]);
  assert.deepEqual(m.defaultSubtitleChoice({ tracks, dub: true, preferredLang: "en" }), { include: false, urls: [] });
  assert.deepEqual(m.defaultSubtitleChoice({ tracks, dub: false, preferredLang: "en" }), { include: true, urls: ["e"] });
  assert.deepEqual(m.defaultSubtitleChoice({ tracks, dub: false, preferredLang: "de" }), { include: false, urls: [] });
  assert.deepEqual(m.chosenSubtitles(tracks, { include: true, urls: ["s"] }), [{ url: "s", lang: "es" }]);
  assert.deepEqual(m.chosenSubtitles(tracks, { include: false, urls: ["s"] }), []);
});

await t("queue: second download waits; pause and resume go to the native job", async () => {
  const probe = { streamUrl: "https://x/master.m3u8", headers: { Referer: "r" }, subtitles: [] };
  const option = { name: "1080p", label: "1080p · ~2.5 GB", url: "u/1080", estBytes: 2_700_000_000 };
  const first = await api.runDownload({ name: "One", mediaId: 1, mediaType: "movie", probe, option, subtitles: [{ url: "s", lang: "en" }] });
  const second = await api.runDownload({ name: "Two", mediaId: 2, mediaType: "movie", probe, option });
  assert.ok(first.ok && second.ok);
  const start = sent.find((m) => m.op === "start");
  assert.equal(start.variantUrl, "u/1080");
  assert.equal(start.estBytes, 2_700_000_000);
  assert.equal(JSON.parse(start.meta).quality, "1080p");
  assert.deepEqual(start.subtitles, [{ url: "s", lang: "en" }]); // only what was chosen
  assert.equal(sent.filter((x) => x.op === "start")[1].subtitles.length, 0); // none chosen, none sent
  assert.equal(first.record.status, "downloading"); // the native job, not a made-up record

  let list = await api.getDownloads();
  assert.deepEqual(list.map((r) => r.status), ["downloading", "queued"]);
  await api.pauseDownload(second.id);
  await api.pauseDownload(first.id);
  list = await api.getDownloads();
  assert.deepEqual(list.map((r) => r.status), ["paused", "paused"]);
  await api.resumeDownload(first.id);
  list = await api.getDownloads();
  assert.equal(list[0].status, "queued");
  assert.equal(await api.fileExists(d.DL_SCHEME + first.id), false);
});

await t("missing stream or failed start is reported, not thrown", async () => {
  assert.deepEqual(await api.runDownload({ probe: {} }), { ok: false, error: "No stream found" });
});

await t("events: removal forgets the record; finished downloads exist and play", async () => {
  const id = jobs[0].id;
  jobs[0].status = "completed";
  const rec = d.recordFromEvent({ ...jobs[0], finalBytes: GB });
  assert.equal(rec.size, "1.0 GB");
  assert.equal(rec.status, "completed");
  assert.equal(await api.fileExists(rec.filePath), true);
  await api.openPathAtTime(rec.filePath, 42);
  const play = sent.findLast((m) => m.op === "play");
  assert.equal(play.ctx.startAt, 42);
  assert.equal(play.ctx.progressKey, "movie_1");
  assert.equal(d.recordFromEvent({ id, removed: true }), null);
  assert.equal(await api.fileExists(rec.filePath), false);
});

await t("Downloads tab (phone): live native numbers, Finished in Local Files, no desktop controls", async () => {
  const React = await import("react");
  const { renderToString } = await import("react-dom/server.browser");
  const { default: PhoneDownloads } = await import("../src/components/downloads/PhoneDownloads.jsx");
  const live = d.toRecord({ id: "a", name: "Batman: Knightfall Part 1", status: "downloading", bytesDownloaded: 638 * 1024 ** 2,
    totalBytes: Math.round((638 * 1024 ** 2 / 303) * 1586), progress: 19.1, fragmentsDone: 303, fragmentsTotal: 1586,
    speedBps: 4.2 * 1024 ** 2, activeConnections: 8, subtitles: [] });
  const done = d.toRecord({ id: "b", name: "Done", status: "completed", finalBytes: GB, subtitles: [{ lang: "en" }] });
  const html = renderToString(React.createElement(PhoneDownloads, { downloads: [live, done], actions: {} }));
  for (const text of ["Downloading", "638 MB of ≈3.3 GB", "303/1,586 fragments", "8 connections · 4 MB/s", "19.1%", "1 active · 1 finished", "Finished", "CC EN"])
    assert.ok(html.includes(text), text);
  assert.ok(html.indexOf("Local Files") < html.indexOf("Done"));
  for (const text of ["Ctrl", "Untracked", "Sort by", "Folder", "SUB · SUB"]) assert.ok(!html.includes(text), text);
  assert.ok(!html.includes("CC</span>")); // no chip when no subtitles were chosen
});

console.log(`\n${pass} download checks passed`);
