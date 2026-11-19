// Dev-only: Downloads tab grouping (episodes of one show share one card,
// movies stay single), the episode meta a start records, and duplicate starts.
// Runs in a simulated DOM (happy-dom, installed by scripts/run-ios-tests.sh).
// Not bundled.
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Node", "Event", "MouseEvent", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]) {
  try { globalThis[k] = win[k]; } catch { Object.defineProperty(globalThis, k, { value: win[k], configurable: true }); }
}
globalThis.window = win;
win.HTMLElement.prototype.scrollIntoView = () => {};

// Fake native DownloadManager (one job runs at a time; list is slow so two
// taps can overlap).
const jobs = [];
const sent = [];
const tick = () => new Promise((r) => setTimeout(r, 5));
win.webkit = {
  messageHandlers: {
    sbDiag: { postMessage: async () => true },
    sbDownload: {
      postMessage: async (m) => {
        sent.push(m);
        const job = jobs.find((j) => j.id === m.id);
        switch (m.op) {
          case "start":
            jobs.push({ id: m.id, name: m.name, status: jobs.some((j) => j.status === "downloading") ? "queued" : "downloading", meta: m.meta, bytesDownloaded: 0, totalBytes: m.estBytes, subtitles: m.subtitles, createdAt: Date.now() });
            return { ok: true, id: m.id };
          case "remove": jobs.splice(jobs.indexOf(job), 1); return true;
          case "list": await tick(); return jobs.map((j) => ({ ...j }));
          default: return true;
        }
      },
    },
  },
};

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const m = await import("../src/utils/downloadMath.js");
const d = await import("../src/platform/ios/downloads.js");
const { default: PhoneDownloads } = await import("../src/components/downloads/PhoneDownloads.jsx");
const { default: EpisodeSheet } = await import("../src/components/downloads/EpisodeSheet.jsx");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const api = d.iosDownloadApi;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

let pass = 0;
const t = async (n, f) => { await f(); pass++; console.log("ok -", n); };

// A record as the native downloader would report it.
const rec = (id, status, meta, extra = {}) =>
  d.toRecord({ id, name: extra.name || "x", status, meta: JSON.stringify(meta), subtitles: [], createdAt: extra.createdAt || 0, ...extra });
const ep = (id, show, season, episode, status, extra = {}) =>
  rec(id, status, { mediaType: "tv", tmdbId: show.id, mediaId: show.id, showName: show.name, season, episode, posterPath: show.poster },
    { name: `${show.name} S${String(season).padStart(2, "0")} E${String(episode).padStart(2, "0")}`, ...extra });
const BB = { id: 1396, name: "Breaking Bad", poster: "/bb.jpg" };
const DARK = { id: 70523, name: "Dark", poster: "/dark.jpg" };
const movie = (id, status, extra = {}) => rec(id, status, { mediaType: "movie", tmdbId: 27205, posterPath: "/inc.jpg" }, { name: "Inception (2010)", ...extra });

await t("grouping: episodes of one show share one entry; movies stay single", () => {
  const list = [
    ep("a", BB, 1, 2, "completed", { finalBytes: GB }),
    movie("m", "completed", { finalBytes: 2 * GB }),
    ep("b", DARK, 1, 1, "completed", { finalBytes: GB }),
    ep("c", BB, 1, 1, "completed", { finalBytes: GB }),
  ];
  const groups = m.groupDownloads(list);
  assert.deepEqual(groups.map((g) => g.kind), ["show", "item", "show"]);
  assert.equal(groups[0].name, "Breaking Bad");
  assert.equal(groups[0].key, "tv:1396");
  assert.equal(groups[0].posterPath, "/bb.jpg");
  assert.equal(groups[0].episodes.length, 2);
  assert.equal(groups[1].record.id, "m");
  // No TMDB id: the AniList id, else the normalized show title, keeps them together.
  const anime = m.groupDownloads([
    rec("x1", "completed", { mediaType: "tv", anilistId: 21, season: 1, episode: 2 }, { name: "One Piece S01 E02" }),
    rec("x2", "completed", { mediaType: "tv", anilistId: 21, season: 1, episode: 1 }, { name: "One Piece S01 E01" }),
    rec("y1", "completed", { mediaType: "tv", season: 1, episode: 1 }, { name: "Frieren (2023) S01 E01" }),
    rec("y2", "completed", { mediaType: "tv", season: 1, episode: 3 }, { name: "frieren  S1E3" }),
  ]);
  assert.deepEqual(anime.map((g) => [g.key, g.episodes.length]), [["anime:21", 2], ["title:frieren", 2]]);
});

await t("sort: episodes by season then episode, unnumbered last", () => {
  const g = m.groupDownloads([
    ep("s2e1", BB, 2, 1, "completed"),
    ep("s1e10", BB, 1, 10, "completed"),
    ep("s1e2", BB, 1, 2, "completed"),
    ep("s1e1", BB, 1, 1, "queued"),
  ])[0];
  assert.deepEqual(g.episodes.map((e) => e.id), ["s1e1", "s1e2", "s1e10", "s2e1"]);
  assert.deepEqual(g.episodes.map(m.episodeLabel), ["S1 E1", "S1 E2", "S1 E10", "S2 E1"]);
  // Old records with no numbers in meta still sort, from their names.
  const old = m.groupDownloads([
    rec("o2", "completed", { mediaType: "tv", tmdbId: 5 }, { name: "Show (2019) S01 E03" }),
    rec("o1", "completed", { mediaType: "tv", tmdbId: 5 }, { name: "Show (2019) S01 E01" }),
  ])[0];
  assert.deepEqual(old.episodes.map((e) => e.id), ["o1", "o2"]);
  assert.equal(old.name, "Show");
});

await t("totals: episode count, size, combined progress and speed, state counts", () => {
  const g = m.groupDownloads([
    ep("a", BB, 1, 1, "completed", { finalBytes: GB }),
    ep("b", BB, 1, 2, "downloading", { bytesDownloaded: 300 * MB, totalBytes: 600 * MB, totalIsExact: true, progress: 50, speedBps: 2 * MB }),
    ep("c", BB, 1, 3, "queued", { bytesDownloaded: 0, totalBytes: 400 * MB }),
  ])[0];
  const t = g.totals;
  assert.equal(t.count, 3);
  assert.equal(t.bytes, GB + 600 * MB + 400 * MB);
  assert.equal(m.showSummary(t), "3 episodes · 2.0 GB");
  assert.equal(t.activeCount, 2);
  assert.equal(t.progress, 30); // 300 MB of the 1000 MB still to fetch
  assert.equal(t.speed, "2 MB/s");
  assert.equal(m.showStateLine(t), "1 downloading · 1 waiting · 1 finished");
  assert.equal(m.showSummary(m.showTotals([ep("z", BB, 1, 1, "completed", { finalBytes: GB })])), "1 episode · 1.0 GB");
});

await t("start: an episode's job records show id, show name and numeric season/episode", async () => {
  const probe = { streamUrl: "https://x/master.m3u8", headers: {}, ctx: { title: "Breaking Bad", tmdbId: 1396, anilistId: null } };
  const option = { name: "1080p", url: "u/1080", estBytes: GB };
  // Season/episode given as strings by the page: stored as numbers.
  const res = await api.runDownload({ name: "Breaking Bad (2008) S01 E04", mediaId: 1396, mediaType: "tv", season: "1", episode: "4", tmdbId: 1396, probe, option });
  assert.ok(res.ok && !res.duplicate);
  const meta = JSON.parse(sent.findLast((x) => x.op === "start").meta);
  assert.deepEqual([meta.tmdbId, meta.showName, meta.season, meta.episode], [1396, "Breaking Bad", 1, 4]);
  // Caller left the numbers out: taken from the episode name.
  const res2 = await api.runDownload({ name: "Dark (2017) S02 E03", mediaId: 70523, mediaType: "tv", tmdbId: 70523, probe: { ...probe, ctx: {} }, option });
  const meta2 = JSON.parse(sent.findLast((x) => x.op === "start").meta);
  assert.deepEqual([meta2.showName, meta2.season, meta2.episode], ["Dark", 2, 3]);
  assert.equal(res2.record.season, 2);
  assert.equal(m.showKeyOf(res2.record), "tv:70523");
  // Movies get no show fields.
  assert.equal(m.downloadMeta({ mediaType: "movie", tmdbId: 9, name: "M" }).showName, undefined);
});

await t("duplicate: starting the same episode again (or twice at once) makes no second job", async () => {
  const probe = { streamUrl: "https://x/master.m3u8", headers: {}, ctx: { title: "Breaking Bad" } };
  const option = { name: "720p", url: "u/720", estBytes: GB };
  const args = { name: "Breaking Bad (2008) S01 E04", mediaId: 1396, mediaType: "tv", season: 1, episode: 4, tmdbId: 1396, probe, option };
  const before = jobs.length;
  const again = await api.runDownload(args);
  assert.ok(again.ok && again.duplicate);
  assert.equal(again.id, jobs.find((j) => JSON.parse(j.meta).episode === 4).id);
  assert.equal(jobs.length, before);
  // Two taps at once on a new episode: one job.
  const [x, y] = await Promise.all([api.runDownload({ ...args, episode: 5 }), api.runDownload({ ...args, episode: 5 })]);
  assert.ok(x.ok && y.ok);
  assert.equal(x.id, y.id);
  assert.equal(jobs.length, before + 1);
  assert.equal(sent.filter((s) => s.op === "start" && JSON.parse(s.meta).episode === 5).length, 1);
  // A different episode of the same show still starts.
  const other = await api.runDownload({ ...args, episode: 6 });
  assert.ok(other.ok && !other.duplicate);
  // A failed job does not block starting the episode again.
  jobs.find((j) => j.id === other.id).status = "error";
  const retry = await api.runDownload({ ...args, episode: 6 });
  assert.ok(retry.ok && !retry.duplicate && retry.id !== other.id);
  // Same movie twice: one job.
  const mv = { name: "Inception (2010)", mediaId: 27205, mediaType: "movie", tmdbId: 27205, probe, option };
  const m1 = await api.runDownload(mv);
  const m2 = await api.runDownload(mv);
  assert.equal(m1.id, m2.id);
  assert.ok(m2.duplicate);
});

// ── The tab itself ────────────────────────────────────────────────────────

async function mount(initial) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const calls = [];
  let downloads = initial;
  const actions = {
    pause: (id) => calls.push(["pause", id]),
    resume: (id) => calls.push(["resume", id]),
    play: (r) => calls.push(["play", r.id]),
    remove: (r) => {
      calls.push(["remove", r.id]);
      downloads = downloads.filter((x) => x.id !== r.id);
      render();
    },
  };
  const render = () => root.render(React.createElement(PhoneDownloads, { downloads, actions }));
  await act(async () => render());
  const click = async (el) => act(async () => { el.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
  const update = async (next) => { downloads = next; await act(async () => render()); };
  return { host, calls, click, update };
}

await t("tab: one card per show with poster, name, count, size and live progress; movies single", async () => {
  const list = [
    ep("a", BB, 1, 1, "completed", { finalBytes: GB, completedAt: 3 }),
    ep("b", BB, 1, 2, "completed", { finalBytes: GB, completedAt: 2 }),
    ep("c", BB, 1, 3, "downloading", { bytesDownloaded: 100 * MB, totalBytes: 400 * MB, totalIsExact: true, progress: 25, speedBps: 3 * MB }),
    ep("d", BB, 1, 4, "queued", { bytesDownloaded: 0, totalBytes: 400 * MB }),
    movie("m", "completed", { finalBytes: 2 * GB, completedAt: 1 }),
  ];
  const { host } = await mount(list);
  const shows = host.querySelectorAll(".pd-card--show");
  assert.equal(shows.length, 2); // Active and Local Files each have the show once
  const [activeCard, finishedCard] = shows;
  assert.ok(activeCard.textContent.includes("Breaking Bad"));
  assert.ok(activeCard.textContent.includes("2 episodes · 800 MB"));
  assert.ok(activeCard.textContent.includes("1 downloading · 1 waiting · 2 finished"));
  assert.ok(activeCard.textContent.includes("12.5%")); // 100 MB of 800 MB
  assert.ok(activeCard.textContent.includes("3 MB/s"));
  assert.ok(activeCard.querySelector("img.pd-card__poster").getAttribute("src").includes("/bb.jpg"));
  assert.ok(finishedCard.textContent.includes("2 episodes · 2.0 GB"));
  assert.equal(finishedCard.querySelector(".pd-card__bar"), null); // nothing fetching there
  // The movie is its own card; no episode is listed outside its show.
  const singles = [...host.querySelectorAll(".pd-card:not(.pd-card--show)")];
  assert.deepEqual(singles.map((c) => c.querySelector(".pd-card__title").textContent), ["Inception (2010)"]);
  assert.ok(!host.textContent.includes("S01 E01"));
});

await t("tab: a show opens its episodes in order with live state and controls; back returns", async () => {
  const list = [
    ep("e3", BB, 1, 3, "downloading", { bytesDownloaded: 100 * MB, totalBytes: 400 * MB, progress: 25, speedBps: MB }),
    ep("e1", BB, 1, 1, "completed", { finalBytes: GB }),
    ep("e2", BB, 1, 2, "paused", { bytesDownloaded: 50 * MB, totalBytes: 400 * MB, progress: 12.5 }),
    movie("m", "completed", { finalBytes: 2 * GB }),
  ];
  const { host, calls, click, update } = await mount(list);
  await click(host.querySelector(".pd-card--show"));
  assert.ok(host.querySelector(".pd-back"));
  assert.ok(host.textContent.includes("Breaking Bad"));
  assert.ok(host.textContent.includes("3 episodes"));
  const eps = [...host.querySelectorAll(".pd-card--episode")];
  assert.deepEqual(eps.map((c) => c.querySelector(".pd-card__title").textContent), ["S1 E1", "S1 E2", "S1 E3"]);
  assert.ok(eps[0].textContent.includes("Finished") && eps[0].querySelector('[aria-label="Play S1 E1"]'));
  assert.ok(eps[1].textContent.includes("Paused") && eps[1].textContent.includes("12.5%"));
  assert.ok(eps[2].textContent.includes("Downloading") && eps[2].textContent.includes("25.0%"));
  assert.ok(!host.textContent.includes("Inception")); // only this show
  await click(eps[0].querySelector('[aria-label="Play S1 E1"]'));
  await click(eps[1].querySelector('[aria-label="Resume S1 E2"]'));
  await click(eps[2].querySelector('[aria-label="Pause S1 E3"]'));
  assert.deepEqual(calls, [["play", "e1"], ["resume", "e2"], ["pause", "e3"]]);
  // Live: a progress update shows in the open view.
  await update(list.map((r) => (r.id === "e3" ? { ...r, progress: 60 } : r)));
  assert.ok(host.querySelectorAll(".pd-card--episode")[2].textContent.includes("60.0%"));
  // Every touch target is a real button (44pt in CSS).
  for (const b of host.querySelectorAll(".pd-card--episode button, .pd-back")) assert.equal(b.tagName, "BUTTON");
  await click(host.querySelector(".pd-back"));
  assert.equal(host.querySelector(".pd-back"), null);
  assert.ok(host.textContent.includes("Local Files"));
  assert.ok(host.textContent.includes("Inception"));
});

await t("tab: deleting a show's last episode removes the show and returns to the list", async () => {
  const list = [ep("e1", DARK, 1, 1, "completed", { finalBytes: GB }), ep("e2", DARK, 1, 2, "completed", { finalBytes: GB }), movie("m", "completed", { finalBytes: GB })];
  const { host, click } = await mount(list);
  await click(host.querySelector(".pd-card--show"));
  await click(host.querySelector('[aria-label="Delete S1 E1"]'));
  assert.equal(host.querySelectorAll(".pd-card--episode").length, 1);
  assert.ok(host.textContent.includes("1 episode · 1.0 GB"));
  await click(host.querySelector('[aria-label="Delete S1 E2"]'));
  assert.equal(host.querySelector(".pd-back"), null); // back on the list
  assert.equal(host.querySelectorAll(".pd-card--show").length, 0); // the group is gone
  assert.ok(host.textContent.includes("Inception"));
  assert.ok(!host.textContent.includes("Dark"));
  // Same in the pure grouping.
  assert.deepEqual(m.groupDownloads([movie("m", "completed")]).map((g) => g.kind), ["item"]);
});

await t("tab: phone only (no desktop controls)", async () => {
  const { host } = await mount([ep("e1", BB, 1, 1, "completed"), ep("e2", BB, 1, 2, "completed")]);
  for (const text of ["Ctrl", "Untracked", "Sort by", "Folder"]) assert.ok(!host.textContent.includes(text), text);
});


// ── Picking several episodes ──────────────────────────────────────────────

const SEV = { id: 95396, name: "Severance", poster: "/sev.jpg" };
const SEV_KEY = "tv:95396";
const sevEps = (n, runtime = 50) => Array.from({ length: n }, (_, i) => ({ episode_number: i + 1, name: `Ep ${i + 1}`, runtime }));
// Fake stream lookup per episode: one 1080p and one 720p tier.
const probed = [];
const fakeProbe = async ({ ctx }) => {
  probed.push(`${ctx.season}:${ctx.episode}`);
  return {
    ok: true,
    streamUrl: `https://x/${ctx.season}-${ctx.episode}.m3u8`,
    headers: {},
    subtitles: [{ url: `s/${ctx.episode}/en`, lang: "en", code: "en", label: "English" }],
    options: [
      { name: "1080p", label: "1080p", url: `u/${ctx.episode}/1080`, estBytes: GB, sizing: false },
      { name: "720p", label: "720p", url: `u/${ctx.episode}/720`, estBytes: GB / 2, sizing: false },
    ],
    ctx,
    tried: [],
  };
};
const sevJobs = () => jobs.filter((j) => JSON.parse(j.meta).tmdbId === SEV.id);

await t("picker: already downloaded/downloading episodes are ticked off; failed ones can be picked", () => {
  const downloads = [
    ep("h1", SEV, 1, 1, "completed"),
    ep("h2", SEV, 1, 2, "downloading"),
    ep("h3", SEV, 1, 3, "error"),
    ep("o1", BB, 1, 4, "completed"), // another show
  ];
  const c = m.episodeChoices({ season: 1, episodes: sevEps(4), downloads, showKey: SEV_KEY });
  assert.deepEqual(c.map((x) => x.download?.status ?? null), ["completed", "downloading", null, null]);
  assert.equal(m.episodeChoices({ season: 2, episodes: sevEps(2), downloads, showKey: SEV_KEY }).filter((x) => x.download).length, 0);
});

await t("picker: selection size estimated from one measured episode, by runtime", () => {
  assert.equal(m.batchEstimate([{ runtime: 50 }, { runtime: 25 }], { bytes: GB, runtime: 50 }), 1.5 * GB);
  assert.equal(m.batchEstimate([{ runtime: 0 }, { runtime: 0 }], { bytes: GB, runtime: 50 }), 2 * GB); // no runtime: one each
  assert.equal(m.batchEstimate([{ runtime: 50 }], null), 0);
});

await t("batch: several episodes queue at one quality into one show group; existing ones skipped", async () => {
  const show = { tmdbId: SEV.id, name: SEV.name, posterPath: SEV.poster };
  // S1E1 already has a job.
  const pre = await api.runDownload({ name: "Severance S01 E01", showName: "Severance", mediaId: SEV.id, tmdbId: SEV.id, mediaType: "tv", season: 1, episode: 1, posterPath: SEV.poster, probe: await fakeProbe({ ctx: { season: 1, episode: 1 } }), option: { name: "1080p", url: "u" } });
  assert.ok(pre.ok);
  probed.length = 0;
  const res = await d.downloadEpisodes({
    show,
    episodes: [{ season: 1, episode: 1 }, { season: 1, episode: 2 }, { season: 1, episode: 3 }, { season: 2, episode: 1 }],
    option: { name: "720p" },
    subtitleLangs: ["en"],
    ctx: { title: "Severance" },
    probe: fakeProbe,
  });
  assert.equal(res.ok, true);
  assert.equal(res.started.length, 3);
  assert.deepEqual(res.skipped, [{ season: 1, episode: 1 }]);
  assert.deepEqual(probed, ["1:2", "1:3", "2:1"]); // no lookup for the skipped one
  const starts = sent.filter((x) => x.op === "start" && JSON.parse(x.meta).tmdbId === SEV.id).slice(1);
  assert.deepEqual(starts.map((x) => x.variantUrl), ["u/2/720", "u/3/720", "u/1/720"]); // one quality for the batch
  assert.ok(starts.every((x) => x.subtitles.length === 1 && x.subtitles[0].lang === "en"));
  assert.deepEqual(starts.map((x) => x.name), ["Severance S01 E02", "Severance S01 E03", "Severance S02 E01"]);
  // All of them in one group, in order.
  const groups = m.groupDownloads((await api.getDownloads()).filter((r) => r.tmdbId === SEV.id));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "Severance");
  assert.deepEqual(groups[0].episodes.map(m.episodeLabel), ["S1 E1", "S1 E2", "S1 E3", "S2 E1"]);
  // Running the same batch again starts nothing.
  const again = await d.downloadEpisodes({ show, episodes: [{ season: 1, episode: 2 }, { season: 2, episode: 1 }], option: { name: "720p" }, ctx: {}, probe: fakeProbe });
  assert.equal(again.started.length, 0);
  assert.equal(again.skipped.length, 2);
  assert.equal(sevJobs().length, 4);
});

await t("picker sheet: checkboxes, Select all, season switcher, size, one quality, queued into the show", async () => {
  // Start clean for this show.
  for (const j of sevJobs()) jobs.splice(jobs.indexOf(j), 1);
  const pre = await api.runDownload({ name: "Severance S01 E01", showName: "Severance", mediaId: SEV.id, tmdbId: SEV.id, mediaType: "tv", season: 1, episode: 1, probe: await fakeProbe({ ctx: { season: 1, episode: 1 } }), option: { name: "1080p", url: "u" } });
  const downloads = (await api.getDownloads()).filter((r) => r.id === pre.id);
  downloads.push(ep("dl2", SEV, 1, 2, "downloading"));
  const show = { tmdbId: SEV.id, name: SEV.name, posterPath: SEV.poster };
  const calls = [];
  let closed = false;
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  await act(async () =>
    root.render(
      React.createElement(EpisodeSheet, {
        showName: "Severance",
        showKey: SEV_KEY,
        seasons: [{ season_number: 1 }, { season_number: 2 }],
        initialSeason: 1,
        loadEpisodes: async (s) => (s === 1 ? sevEps(4, 50) : sevEps(2, 25)),
        downloads,
        probe: (c) => fakeProbe({ ctx: { season: c.season, episode: c.episode } }),
        measure: async (_p, options) => options,
        start: async (args) => {
          calls.push(args);
          return d.downloadEpisodes({ ...args, show, ctx: {}, probe: fakeProbe });
        },
        onClose: () => (closed = true),
      }),
    ),
  );
  await flush();
  const boxes = () => [...host.querySelectorAll('.pd-row--check input[type="checkbox"]')].slice(1);
  // E1 already queued, E2 downloading: ticked and disabled.
  assert.deepEqual(boxes().map((b) => [b.checked, b.disabled]), [[true, true], [true, true], [false, false], [false, false]]);
  assert.ok(host.textContent.includes(m.STATUS_LABEL[downloads[0].status]) && host.textContent.includes("Downloading"));
  assert.ok(host.textContent.includes("0 episodes selected"));
  // Select all picks only what is not downloaded yet.
  await act(async () => host.querySelector('[aria-label="Select all of season 1"]').click());
  assert.ok(host.textContent.includes("2 episodes selected"));
  assert.ok(host.textContent.includes("~2.0 GB at 1080p"), host.textContent);
  // Other season: pick one episode (25 min, half the measured one's 50).
  await act(async () => [...host.querySelectorAll(".pd-season")][1].click());
  await flush();
  assert.equal(boxes().length, 2);
  await act(async () => boxes()[0].click());
  assert.ok(host.textContent.includes("3 episodes selected"));
  assert.ok(host.textContent.includes("~2.5 GB at 1080p"));
  for (const b of host.querySelectorAll(".pd-season, .pd-batchbar .pd-btn")) assert.equal(b.tagName, "BUTTON");
  // One quality for the whole batch, with the batch's total.
  await act(async () => host.querySelector(".pd-batchbar .pd-btn").click());
  const rows = [...host.querySelectorAll("button.pd-row")];
  assert.deepEqual(rows.map((r) => r.textContent), ["1080p~2.5 GB total", "720p~1.3 GB total"]);
  await act(async () => rows[1].click());
  for (let i = 0; i < 100 && !closed; i++) await flush(); // each episode is looked up and queued in turn
  assert.equal(closed, true, host.textContent);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].episodes.map((e) => `${e.season}:${e.episode}`), ["1:3", "1:4", "2:1"]);
  assert.equal(calls[0].option.name, "720p");
  // Queued into the same show group as the episode already there.
  const groups = m.groupDownloads((await api.getDownloads()).filter((r) => r.tmdbId === SEV.id));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].episodes.map(m.episodeLabel), ["S1 E1", "S1 E3", "S1 E4", "S2 E1"]);
  root.unmount();
});

await t("row download: one episode preselected, sheet opens on the quality step, queues just that episode", async () => {
  for (const j of sevJobs()) jobs.splice(jobs.indexOf(j), 1);
  const show = { tmdbId: SEV.id, name: SEV.name, posterPath: SEV.poster };
  const calls = [];
  const probed = [];
  let closed = false;
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  await act(async () =>
    root.render(
      React.createElement(EpisodeSheet, {
        showName: "Severance",
        showKey: SEV_KEY,
        seasons: [{ season_number: 1 }, { season_number: 2 }],
        initialSeason: 1,
        preselect: { season: 2, episode: 2 },
        loadEpisodes: async (s) => (s === 1 ? sevEps(4, 50) : sevEps(2, 25)),
        downloads: [],
        probe: (c) => (probed.push(`${c.season}:${c.episode}`), fakeProbe({ ctx: { season: c.season, episode: c.episode } })),
        measure: async (_p, options) => options,
        start: async (args) => {
          calls.push(args);
          return d.downloadEpisodes({ ...args, show, ctx: {}, probe: fakeProbe });
        },
        onClose: () => (closed = true),
      }),
    ),
  );
  await flush();
  assert.ok(host.textContent.includes("1 episode selected"), host.textContent);
  assert.equal(probed[0], "2:2", "the tapped episode is the one measured");
  const rows = [...host.querySelectorAll("button.pd-row")];
  assert.ok(rows.length >= 1, "quality step shown right away");
  await act(async () => rows[0].click());
  for (let i = 0; i < 100 && !closed; i++) await flush();
  assert.equal(closed, true, host.textContent);
  assert.deepEqual(calls[0].episodes.map((e) => `${e.season}:${e.episode}`), ["2:2"]);
  root.unmount();
});

await t("row download: an already-downloaded episode opens the list instead", async () => {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  await act(async () =>
    root.render(
      React.createElement(EpisodeSheet, {
        showName: "Severance",
        showKey: SEV_KEY,
        seasons: [{ season_number: 1 }],
        preselect: { season: 1, episode: 2 },
        loadEpisodes: async () => sevEps(4, 50),
        downloads: [ep("dl2b", SEV, 1, 2, "downloading")],
        probe: (c) => fakeProbe({ ctx: { season: c.season, episode: c.episode } }),
        measure: async (_p, options) => options,
        start: async () => ({ ok: true }),
        onClose: () => {},
      }),
    ),
  );
  await flush();
  assert.ok(host.textContent.includes("0 episodes selected"), host.textContent);
  assert.ok(host.querySelector(".pd-batchbar"), "episode list shown");
  root.unmount();
});

console.log(`\n${pass} download grouping checks passed`);
process.exit(0);
