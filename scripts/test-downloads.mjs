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
            jobs.push({ id: m.id, name: m.name, status: jobs.some((j) => j.status === "downloading") ? "queued" : "downloading", meta: m.meta, bytes: 0, totalBytes: m.estBytes });
            return { ok: true, id: m.id };
          case "pause": if (["queued", "downloading"].includes(job?.status)) job.status = "paused"; return true;
          case "resume": if (["paused", "error"].includes(job?.status)) job.status = "queued"; return true;
          case "remove": jobs.splice(jobs.indexOf(job), 1); return true;
          case "list": return jobs.map((j) => ({ ...j }));
          case "play": return job?.status === "completed";
          default: throw new Error("unknown op " + m.op);
        }
      },
    },
  },
};

const d = await import("../src/platform/ios/downloads.js");
const api = d.iosDownloadApi;
let pass = 0;
const t = async (n, f) => { await f(); pass++; console.log("ok -", n); };
const GB = 1024 ** 3;

await t("size estimate is bandwidth × duration / 8", () => {
  assert.equal(d.estimateBytes(5_000_000, 7200), 4_500_000_000);
  assert.equal(d.estimateBytes(5_000_000, 0), 0);
  assert.equal(d.estimateBytes(0, 7200), 0);
});

await t("labels read like '1080p · ~2.1 GB'", () => {
  assert.equal(d.qualityLabel("1080p", 2.1 * GB), "1080p · ~2.1 GB");
  assert.equal(d.qualityLabel("720p", 850 * 1024 ** 2), "720p · ~850 MB");
  assert.equal(d.qualityLabel("4K", 0), "4K");
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

await t("options: only tiers the stream has, best bitrate per tier, best first", () => {
  const probe = {
    kind: "hls",
    variants: [
      { url: "u/480", width: 854, height: 480, bandwidth: 1_000_000 },
      { url: "u/1080lo", width: 1920, height: 1080, bandwidth: 4_000_000 },
      { url: "u/1080hi", width: 1920, height: 1080, bandwidth: 6_000_000, audio: "a/en" },
      { url: "u/360", width: 640, height: 360, bandwidth: 600_000 },
    ],
  };
  const opts = d.qualityOptions(probe, 3600);
  assert.deepEqual(opts.map((o) => o.url), ["u/1080hi", "u/480"]);
  assert.equal(opts[0].estBytes, 2_700_000_000);
  assert.equal(opts[0].label, "1080p · ~2.5 GB");
  assert.equal(opts[0].audio, "a/en");
  assert.equal(opts[1].audio, null);
});

await t("options: fallbacks for no resolutions, media playlist, and MP4", () => {
  const noRes = d.qualityOptions({ kind: "hls", variants: [{ url: "a", bandwidth: 1 }, { url: "b", bandwidth: 9_000_000 }] }, 0);
  assert.deepEqual(noRes, [{ label: "Best available", url: "b", audio: null, estBytes: 0 }]);
  assert.deepEqual(d.qualityOptions({ kind: "hls" }, 3600), [{ label: "Best available", estBytes: 0 }]);
  assert.deepEqual(d.qualityOptions({ kind: "mp4" }, 3600), [{ label: "Original", estBytes: 0 }]);
});

await t("records: status text, sizes, and a playable path only when completed", () => {
  const meta = JSON.stringify({ tmdbId: 7, mediaType: "movie" });
  const q = d.toRecord({ id: "a", name: "A", status: "queued", meta, bytes: 0, totalBytes: 2 * GB });
  assert.equal(q.lastMessage, "Waiting in queue…");
  assert.equal(q.size, "0 B of ~2.0 GB");
  assert.equal(q.filePath, null);
  assert.equal(q.tmdbId, 7);
  const p = d.toRecord({ id: "a", status: "paused", speedBps: 5e6, bytes: GB, totalBytes: 2 * GB });
  assert.equal(p.lastMessage, "Paused");
  assert.equal(p.speed, "");
  const e = d.toRecord({ id: "a", status: "error", error: "Server error (HTTP 404)" });
  assert.equal(e.lastMessage, "Server error (HTTP 404)");
  const c = d.toRecord({ id: "a", status: "completed", finalBytes: 3 * GB, progress: 100 });
  assert.equal(c.filePath, d.DL_SCHEME + "a");
  assert.equal(c.size, "3.0 GB");
  assert.equal(d.toRecord({ id: "a", status: "downloading", meta: "{bad" }).id, "a");
});

await t("queue: second download waits; pause and resume go to the native job", async () => {
  const probe = { streamUrl: "https://x/master.m3u8", headers: { Referer: "r" }, subtitles: [] };
  const option = { label: "1080p · ~2.5 GB", url: "u/1080", estBytes: 2_700_000_000 };
  const first = await api.runDownload({ name: "One", mediaId: 1, mediaType: "movie", probe, option });
  const second = await api.runDownload({ name: "Two", mediaId: 2, mediaType: "movie", probe, option });
  assert.ok(first.ok && second.ok);
  const start = sent.find((m) => m.op === "start");
  assert.equal(start.variantUrl, "u/1080");
  assert.equal(start.estBytes, 2_700_000_000);
  assert.equal(JSON.parse(start.meta).quality, "1080p · ~2.5 GB");

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
  assert.equal(rec.status, "completed");
  assert.equal(await api.fileExists(rec.filePath), true);
  await api.openPathAtTime(rec.filePath, 42);
  const play = sent.findLast((m) => m.op === "play");
  assert.equal(play.ctx.startAt, 42);
  assert.equal(play.ctx.progressKey, "movie_1");
  assert.equal(d.recordFromEvent({ id, removed: true }), null);
  assert.equal(await api.fileExists(rec.filePath), false);
});

console.log(`\n${pass} download checks passed`);
