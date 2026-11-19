// Web app (PWA) downloads: the browser stand-in for the iOS app's native
// downloader (Downloads.swift). It answers the same messages ("probe",
// "measure", "start", "list", "remove", "pause", "resume", "play") so the
// shared download code and the Downloads page work unchanged.
//
// Each download is stored in Cache Storage as a rewritten HLS playlist plus
// its segments, under ./offline/<id>/... The service worker serves those
// paths from the cache, so playback (hls.js) needs no internet at all.
// Downloads run while the app is open; one left unfinished resumes on Resume.

const JOBS_KEY = "sb_web_downloads";
const PARALLEL = 4;
const base = () => new URL("./", location.href).href;
const localUrl = (id, name) => `${base()}offline/${id}/${name}`;
const cacheName = (id) => `dl-${id}`;

let jobs = [];
try {
  jobs = JSON.parse(localStorage.getItem(JOBS_KEY) || "[]");
} catch {}
// Anything mid-download when the app closed waits for Resume.
for (const j of jobs) if (j.status === "downloading" || j.status === "queued") j.status = "paused";
const running = new Map(); // id -> { stop: bool }

const save = () => {
  try {
    localStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
  } catch {}
};
const emit = (j) => {
  save();
  try {
    window.__sbDownloadEvent?.(j ? { ...j } : j);
  } catch {}
};
const find = (id) => jobs.find((j) => j.id === id);

async function getText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// Master playlist -> variants; media playlist -> null.
function parseMaster(text, url) {
  if (!/#EXT-X-STREAM-INF/.test(text)) return null;
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#EXT-X-STREAM-INF:(.*)$/);
    if (!m) continue;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
    if (!uri) continue;
    const bw = Number(m[1].match(/(?:^|,)BANDWIDTH=(\d+)/)?.[1]) || 0;
    const res = m[1].match(/RESOLUTION=(\d+)x(\d+)/);
    out.push({ url: new URL(uri, url).href, bandwidth: bw, width: res ? +res[1] : 0, height: res ? +res[2] : 0 });
  }
  return out;
}

function parseMedia(text, url) {
  const lines = text.split(/\r?\n/);
  const segs = [];
  let dur = 0;
  let total = 0;
  for (const l of lines) {
    const inf = l.match(/^#EXTINF:([\d.]+)/);
    if (inf) dur = Number(inf[1]) || 0;
    else if (l && !l.startsWith("#")) {
      segs.push({ url: new URL(l, url).href, dur });
      total += dur;
    }
  }
  return { lines, segs, total };
}

async function mediaPlaylistUrl(streamUrl, variantUrl) {
  if (variantUrl) return variantUrl;
  const text = await getText(streamUrl);
  const vs = parseMaster(text, streamUrl);
  if (!vs?.length) return streamUrl;
  return vs.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a)).url;
}

// Some hosts wrap MPEG-TS segments in a fake image header: cut to the TS sync.
function unwrap(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0x47) return buf;
  for (let i = 0; i < Math.min(b.length - 376, 4096); i++) {
    if (b[i] === 0x47 && b[i + 188] === 0x47 && b[i + 376] === 0x47) return buf.slice(i);
  }
  return buf;
}

async function run(job) {
  const ctl = { stop: false };
  running.set(job.id, ctl);
  job.status = "downloading";
  emit(job);
  try {
    const cache = await caches.open(cacheName(job.id));
    const mediaUrl = await mediaPlaylistUrl(job.streamUrl, job.variantUrl);
    const { lines, segs, total } = parseMedia(await getText(mediaUrl), mediaUrl);
    if (!segs.length) throw new Error("Empty stream");
    job.fragmentsTotal = segs.length;
    job.durationSec = total;
    // Keys and init segments ride along under local names.
    const extras = [];
    const out = lines.map((l) => {
      const m = l.match(/^(#EXT-X-(?:KEY|MAP):.*URI=")([^"]+)(".*)$/);
      if (!m) return l;
      const name = `x${extras.length}`;
      extras.push({ url: new URL(m[2], mediaUrl).href, name });
      return m[1] + localUrl(job.id, name) + m[3];
    });
    let n = 0;
    const local = out.map((l) => (l && !l.startsWith("#") ? localUrl(job.id, `s${n++}`) : l)).join("\n");
    for (const x of extras) {
      if (!(await cache.match(localUrl(job.id, x.name)))) {
        const r = await fetch(x.url);
        await cache.put(localUrl(job.id, x.name), new Response(await r.arrayBuffer()));
      }
    }
    for (const [i, s] of (job.subtitles || []).entries()) {
      try {
        const t = await getText(s.url);
        await cache.put(localUrl(job.id, `sub${i}.vtt`), new Response(t, { headers: { "Content-Type": "text/vtt" } }));
      } catch {}
    }
    let done = 0;
    let bytes = 0;
    const started = Date.now();
    // Count what an earlier run already saved.
    const todo = [];
    for (let i = 0; i < segs.length; i++) {
      const hit = await cache.match(localUrl(job.id, `s${i}`));
      if (hit) {
        done++;
        bytes += Number(hit.headers.get("x-len")) || 0;
      } else todo.push(i);
    }
    let saved = 0;
    const next = async () => {
      while (todo.length && !ctl.stop) {
        const i = todo.shift();
        let buf;
        for (let a = 0; a < 3; a++) {
          try {
            const r = await fetch(segs[i].url);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            buf = unwrap(await r.arrayBuffer());
            break;
          } catch (e) {
            if (a === 2) throw e;
          }
        }
        await cache.put(
          localUrl(job.id, `s${i}`),
          new Response(buf, { headers: { "Content-Type": "video/mp2t", "x-len": String(buf.byteLength) } }),
        );
        done++;
        bytes += buf.byteLength;
        saved += buf.byteLength;
        const secs = (Date.now() - started) / 1000;
        Object.assign(job, {
          fragmentsDone: done,
          bytesDownloaded: bytes,
          totalBytes: Math.round((bytes / done) * segs.length),
          totalIsExact: false,
          progress: (done / segs.length) * 100,
          speedBps: secs > 0 ? Math.round(saved / secs) : 0,
        });
        emit(job);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, next));
    if (ctl.stop) return;
    await cache.put(localUrl(job.id, "index.m3u8"), new Response(local, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }));
    Object.assign(job, { status: "completed", progress: 100, finalBytes: bytes, bytesDownloaded: bytes, speedBps: 0 });
    emit(job);
  } catch (e) {
    if (!ctl.stop) {
      Object.assign(job, { status: "error", error: e?.message || String(e), speedBps: 0 });
      emit(job);
    }
  } finally {
    running.delete(job.id);
  }
}

async function probe({ candidates = [] }) {
  // The browser can only read streams handed over directly (no page to sniff).
  for (const c of candidates) {
    if (!/#sb-direct$/.test(c.url || "")) continue;
    const streamUrl = c.url.replace(/#sb-direct$/, "");
    try {
      const text = await getText(streamUrl);
      const variants = parseMaster(text, streamUrl) || [];
      return { ok: true, server: c.id, streamUrl, kind: "hls", variants, subtitles: [], headers: {} };
    } catch {}
  }
  return { ok: false, error: "No server gave a downloadable stream. Try again in a moment." };
}

async function measure({ items = [] }) {
  const out = [];
  for (const it of items) {
    try {
      const mediaUrl = await mediaPlaylistUrl(it.url, null);
      const { segs, total } = parseMedia(await getText(mediaUrl), mediaUrl);
      let bytes = 0;
      if (segs.length) {
        const r = await fetch(segs[0].url, { method: "HEAD" }).catch(() => null);
        const len = Number(r?.headers.get("content-length")) || 0;
        bytes = len * segs.length;
      }
      out.push({ bytes, durationSec: total, method: "sampled" });
    } catch {
      out.push({});
    }
  }
  return out;
}

// Offline player: full screen, hls.js reading the saved copy.
async function play({ id, ctx = {} }) {
  const job = find(id);
  if (!job || job.status !== "completed") return false;
  const { default: Hls } = await import("hls.js");
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;inset:0;z-index:99999;background:#000;display:flex;align-items:center;justify-content:center";
  const video = document.createElement("video");
  video.controls = true;
  video.playsInline = true;
  video.autoplay = true;
  video.style.cssText = "width:100%;height:100%;object-fit:contain";
  (job.subtitles || []).forEach((s, i) => {
    const t = document.createElement("track");
    t.kind = "subtitles";
    t.srclang = s.lang || "";
    t.label = s.lang || `Sub ${i + 1}`;
    t.src = localUrl(id, `sub${i}.vtt`);
    video.appendChild(t);
  });
  const close = document.createElement("button");
  close.textContent = "✕";
  close.style.cssText = "position:absolute;top:calc(env(safe-area-inset-top) + 12px);left:16px;z-index:2;font-size:22px;color:#fff;background:rgba(0,0,0,.5);border:0;border-radius:20px;width:40px;height:40px";
  wrap.append(video, close);
  document.body.appendChild(wrap);
  const src = localUrl(id, "index.m3u8");
  let hls = null;
  if (Hls.isSupported()) {
    hls = new Hls({ enableWorker: true });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else {
    video.src = src;
  }
  if (ctx.startAt > 0) video.addEventListener("loadedmetadata", () => (video.currentTime = ctx.startAt), { once: true });
  const saveAt = () => {
    if (ctx.progressKey && video.currentTime > 0) {
      try {
        window.dispatchEvent(new CustomEvent("sb-offline-progress", { detail: { key: ctx.progressKey, time: video.currentTime, duration: video.duration } }));
      } catch {}
    }
  };
  const iv = setInterval(saveAt, 5000);
  close.onclick = () => {
    saveAt();
    clearInterval(iv);
    hls?.destroy();
    video.pause();
    wrap.remove();
  };
  return true;
}

async function remove({ id }) {
  const c = running.get(id);
  if (c) c.stop = true;
  jobs = jobs.filter((j) => j.id !== id);
  await caches.delete(cacheName(id)).catch(() => {});
  save();
  try {
    window.__sbDownloadEvent?.({ id, removed: true });
  } catch {}
  return { ok: true };
}

const handlers = {
  probe,
  measure,
  play,
  remove,
  list: async () => jobs.map((j) => ({ ...j })),
  start: async (a) => {
    try {
      navigator.storage?.persist?.();
    } catch {}
    const job = {
      id: a.id,
      name: a.name,
      streamUrl: a.streamUrl,
      variantUrl: a.variantUrl || null,
      subtitles: a.subtitles || [],
      meta: a.meta || "{}",
      status: "queued",
      progress: 0,
      bytesDownloaded: 0,
      totalBytes: a.estBytes || 0,
      fragmentsDone: 0,
      fragmentsTotal: 0,
      createdAt: Date.now(),
    };
    jobs.push(job);
    emit(job);
    run(job);
    return { ok: true };
  },
  pause: async ({ id }) => {
    const c = running.get(id);
    if (c) c.stop = true;
    const j = find(id);
    if (j && j.status !== "completed") {
      Object.assign(j, { status: "paused", speedBps: 0 });
      emit(j);
    }
    return { ok: true };
  },
  resume: async ({ id }) => {
    const j = find(id);
    if (j && (j.status === "paused" || j.status === "error") && !running.has(id)) run(j);
    return { ok: true };
  },
};

/** Installs the web downloader where the iOS app's native one would be. */
export function installWebDownloads() {
  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  if (window.webkit.messageHandlers.sbDownload) return;
  window.webkit.messageHandlers.sbDownload = {
    postMessage: ({ op, ...args }) => {
      const h = handlers[op];
      return h ? h(args) : Promise.reject(new Error(`unknown op ${op}`));
    },
  };
}
