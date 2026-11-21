// Super Player service worker (generated). The whole app is stored on the
// phone at install, so it opens with no connection or if the site is down.
// TMDB answers and posters are kept as you browse, so pages you've seen still
// show offline. Streams always need the internet.
const VERSION = "__VERSION__";
const APP = `app-${VERSION}`;
const DATA = "tmdb-data";
const ART = "tmdb-art";
const PRECACHE = __PRECACHE__;

// Updates never pull the app out from under someone using it: a new version
// installs in the background and waits; the open app tells it to take over
// (SKIP_WAITING) without reloading, and the new version shows on the next
// launch. The last few versions' files are kept, so a page still running an
// older version keeps loading its own screens (lazy chunks) after the switch.
const KEEP_VERSIONS = 3;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(APP).then(async (c) => {
      // One by one: a single missing file never blocks the install.
      for (const u of PRECACHE) await c.add(new Request(u, { cache: "reload" })).catch(() => {});
    }),
  );
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

const versionOf = (k) => parseInt(k.slice(4), 36) || 0;
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => {
        const apps = keys.filter((k) => k.startsWith("app-")).sort((a, b) => versionOf(b) - versionOf(a));
        const keep = new Set([APP, ...apps.filter((k) => k !== APP).slice(0, KEEP_VERSIONS - 1)]);
        return Promise.all(apps.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
      })
      .then(() => self.clients.claim()),
  );
});

async function trimNow(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}
// #19: one trim per cache every few seconds, not one per poster (a Home load
// started hundreds of trims at once, each listing up to 600 entries).
const trimTimers = {};
function trim(name, max) {
  if (trimTimers[name]) return Promise.resolve();
  trimTimers[name] = setTimeout(() => {
    trimNow(name, max).catch(() => {}).finally(() => { trimTimers[name] = 0; });
  }, 5000);
  return Promise.resolve();
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Private IPA install page (get/<token>/): always straight from the site,
  // never the cached app and never cached (the IPA is tens of MB).
  if (url.origin === self.location.origin && url.pathname.includes("/get/")) return;
  // Ad-block profile (dns/): straight from the site, so Safari hands it to Settings.
  if (url.origin === self.location.origin && url.pathname.includes("/dns/")) return;

  // Downloaded shows: only ever from the phone (no internet needed).
  if (url.origin === self.location.origin && url.pathname.includes("/offline/")) {
    e.respondWith(caches.match(req.url, { ignoreSearch: true }).then((h) => h || new Response("Not downloaded", { status: 404 })));
    return;
  }

  // Opening the app: straight from the phone (this version's own page), so
  // it opens instantly, offline, or with the site down. A newer version is
  // fetched by the update check and opens on the next launch.
  const scope = new URL(self.registration.scope).pathname;
  const isAppPage = url.pathname === scope || url.pathname === `${scope}index.html`;
  if (url.origin === self.location.origin && req.mode === "navigate" && isAppPage) {
    e.respondWith(
      caches.open(APP).then(async (c) => {
        const hit = (await c.match("./", { ignoreSearch: true })) || (await c.match("./index.html", { ignoreSearch: true }));
        if (hit) return hit;
        return fetch(req, { cache: "no-store" }).catch(() => new Response("Offline", { status: 503 }));
      }),
    );
    return;
  }

  // Other pages on the site (watch/ etc.): the newest copy when online
  // (2.5 s max), else the app on the phone.
  if (url.origin === self.location.origin && req.mode === "navigate") {
    e.respondWith(
      caches.open(APP).then(async (c) => {
        const net = fetch(req, { cache: "no-store" });
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
        // This version first, then an older kept version (a page still
        // running it asks for its own chunks).
        const hit = (await c.match(req, { ignoreSearch: true })) || (await caches.match(req, { ignoreSearch: true }));
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
