// Super Player service worker (generated). The whole app is stored on the
// phone at install, so it opens with no connection or if the site is down.
// TMDB answers and posters are kept as you browse, so pages you've seen still
// show offline. Streams always need the internet.
const VERSION = "__VERSION__";
const APP = `app-${VERSION}`;
const DATA = "tmdb-data";
const ART = "tmdb-art";
const PRECACHE = __PRECACHE__;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(APP).then(async (c) => {
      // One by one: a single missing file never blocks the install.
      for (const u of PRECACHE) await c.add(new Request(u, { cache: "reload" })).catch(() => {});
    }).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("app-") && k !== APP).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Private IPA install page (get/<token>/): always straight from the site,
  // never the cached app and never cached (the IPA is tens of MB).
  if (url.origin === self.location.origin && url.pathname.includes("/get/")) return;

  // Downloaded shows: only ever from the phone (no internet needed).
  if (url.origin === self.location.origin && url.pathname.includes("/offline/")) {
    e.respondWith(caches.match(req.url, { ignoreSearch: true }).then((h) => h || new Response("Not downloaded", { status: 404 })));
    return;
  }

  // Opening the app: the newest version when online (2.5 s max), else the
  // copy on the phone, so it still opens offline or if the site is down.
  if (url.origin === self.location.origin && req.mode === "navigate") {
    e.respondWith(
      caches.open(APP).then(async (c) => {
        const net = fetch(req, { cache: "no-store" }).then((r) => {
          if (r.ok) c.put("./", r.clone());
          return r;
        });
        const slow = new Promise((r) => setTimeout(() => r(null), 2500));
        const first = await Promise.race([net.catch(() => null), slow]);
        if (first) return first;
        const hit = (await c.match("./")) || (await c.match("./index.html"));
        return hit || (await net.catch(() => null)) || new Response("Offline", { status: 503 });
      }),
    );
    return;
  }

  // The app's files: from the phone first; refresh in the background.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(APP).then(async (c) => {
        const hit = (await c.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? await c.match("./") : null);
        const net = fetch(req).then((r) => {
          if (r.ok && !url.pathname.endsWith("/sw.js")) c.put(req, r.clone());
          return r;
        }).catch(() => null);
        return hit || (await net) || new Response("Offline", { status: 503 });
      }),
    );
    return;
  }

  // TMDB data: fresh when online, last copy when not.
  if (url.hostname === "api.themoviedb.org") {
    e.respondWith(
      fetch(req).then((r) => {
        if (r.ok) caches.open(DATA).then((c) => c.put(req, r.clone()).then(() => trim(DATA, 400)));
        return r;
      }).catch(() => caches.match(req).then((h) => h || Response.error())),
    );
    return;
  }

  // Posters and artwork: kept once seen.
  if (url.hostname === "image.tmdb.org" || url.hostname === "static.tvmaze.com") {
    e.respondWith(
      caches.match(req).then((h) => h || fetch(req).then((r) => {
        if (r.ok || r.type === "opaque") caches.open(ART).then((c) => c.put(req, r.clone()).then(() => trim(ART, 600)));
        return r;
      })),
    );
  }
});
