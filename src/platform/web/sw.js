/* Super Player service worker (web/PWA build only).
 *
 * 1. App shell: precached on install, served cache-first, so the installed
 *    app opens offline and fast. Navigations are network-first with the
 *    cached index.html as the fallback.
 * 2. Streaming downloads: the page opens a MessagePort for a download id and
 *    then requests ./__sbdl/<id>/<file name>. This worker answers that
 *    request with a ReadableStream fed chunk by chunk from the page (pull
 *    based, so the file is never held whole in memory) and a
 *    Content-Disposition: attachment header, so the browser saves it like a
 *    normal download (Files on iOS, Downloads on Android/desktop).
 */
const VERSION = "__SB_VERSION__";
const SHELL = __SB_PRECACHE__;
const CACHE = "sp-shell-" + VERSION;
const RUNTIME = "sp-runtime-" + VERSION;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ── Streaming downloads ───────────────────────────────────────────────────
const streams = new Map(); // id -> { port, filename, mime, size }

self.addEventListener("message", (event) => {
  const d = event.data || {};
  if (d.type === "sbdl-open" && d.id && event.ports[0]) {
    streams.set(String(d.id), { port: event.ports[0], filename: d.filename, mime: d.mime, size: d.size || 0 });
    event.ports[0].postMessage({ type: "registered" });
  } else if (d.type === "sbdl-ping") {
    // keeps the worker alive while a download streams
  } else if (d.type === "skip-waiting") {
    self.skipWaiting();
  }
});

function streamResponse(id) {
  const entry = streams.get(id);
  if (!entry) return new Response("Download expired", { status: 404 });
  streams.delete(id);
  const { port, filename, mime, size } = entry;
  let waiting = null; // resolve of the pending pull
  let cancelled = false;
  const body = new ReadableStream(
    {
      start() {
        port.onmessage = (e) => {
          const m = e.data || {};
          if (!waiting) return;
          const w = waiting;
          waiting = null;
          w(m);
        };
        port.postMessage({ type: "started" });
      },
      pull(controller) {
        return new Promise((resolve) => {
          waiting = (m) => {
            if (m.type === "chunk") controller.enqueue(new Uint8Array(m.chunk));
            else if (m.type === "end") controller.close();
            else if (m.type === "abort") controller.error(new Error(m.reason || "aborted"));
            resolve();
          };
          port.postMessage({ type: "pull" });
        });
      },
      cancel() {
        cancelled = true;
        try {
          port.postMessage({ type: "cancelled" });
        } catch {}
      },
    },
    { highWaterMark: 4 },
  );
  void cancelled;
  const safe = String(filename || "download").replace(/["\\\r\n]/g, "_");
  const headers = {
    "Content-Type": mime || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${safe.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
  if (size > 0) headers["Content-Length"] = String(size);
  return new Response(body, { headers });
}

// ── Fetch routing ─────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // TMDB, players, media: network only

  const m = url.pathname.match(/\/__sbdl\/([^/]+)\//);
  if (m) {
    event.respondWith(streamResponse(decodeURIComponent(m[1])));
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("./index.html", { ignoreSearch: true }).then((r) => r || caches.match("./"))),
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && /\.(js|css|woff2|png|svg|json|webmanifest)$/.test(url.pathname)) {
            const copy = res.clone();
            caches.open(RUNTIME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }),
    ),
  );
});
