# HANDOFF — Super Player (2026-11-20, 22:50 ET)

Branches: `apk-port` (Android + all shared JS), `ipa-test-build` (iOS IPA + web Pages deploy). Shared JS is
copied file-by-file from apk-port to ipa-test-build (worktree pattern; never merge the Android folder there).
Live web app: https://tzzzzgdnnn.github.io/New/ (gh-pages, built by `.github/workflows/deploy-web.yml` on push to ipa-test-build).

## 22:50 ET session 7 — WHERE I STOPPED (read first)
- PUSHED apk-port 9b442cb / ipa-test-build 29deb24 (shared JS copied file-by-file; the 4 files were identical before):
  - Cinezo skipped for Baddies: `TITLE_SERVER_BLOCKS` / `serverBlockedFor(id, ctx)` in src/utils/api.js (16 Baddies TMDB ids
    from girlsnight.json + any TV title matching /baddies/i). Applied in webview.js `serverListFor` (native menu + web/Android
    Auto failover), `buildCandidateList` (iPhone native candidates, also a hand-picked Cinezo), `loadUrl` (a Cinezo page for a
    blocked title is never shown: Auto -> nextServer, hand pick -> our card "Cinezo plays the wrong episodes for this show"),
    and ServerSheet.jsx (not offered). Add more titles/servers to TITLE_SERVER_BLOCKS.
    Note: on web a Baddies title now has only Cinejoy direct + Vidfast (Cinejoy's Baddies playlists 404 from the sandbox).
  - Vidfast retry (rebuilt; the earlier one was lost): webview.js `retryVidfast(why)` at the top of `embedFailed` and
    `nextServer`: a failed Vidfast page gets ONE fresh load per episode before the next server (not for status 404 / wrong
    video / refused). Android resets the sniffed-stream state (`onFreshLoad`). iPhone native: `withVidfastRetry(candidates)`
    inserts one Vidfast retry candidate 3 slots after the original (sniffer runs 3 pages in parallel).
  - scripts/test-web-player.mjs: +3 tests (15/15 pass). Other suites unchanged (known failures: test-search, test-kids,
    test-downloads-group). `npx vite build --mode ios` OK (local node_modules needed `npm install` for peerjs).
- Titles 21-58 (Girls Night Shows tab, row order: Zeus Network #21-35, Now That's TV #36-43, Girls Night Shows #44-58):
  API-level check only (/workspace/work/titlecheck, results-*.json). Cinejoy has a playable stream for S1E1 only for
  Grey's Anatomy and Jane the Virgin (Polaris); the others' upstream playlists 404 or none. Vidfast/Cinezo pages answer
  200 for every id (single-page apps) so their streams could NOT be verified: Playwright WebKit and Chromium both fail to
  launch in this sandbox (missing host libraries). No saved list of the 58 titles was found; this order is my reconstruction.
- Not pushed: /workspace/work/sp-holidays (ipa-holidays, uncommitted) still applies cleanly on ipa-test-build 29deb24.
- Unverified on a device: Baddies -> Auto skipping Cinezo, Vidfast retry on iPhone native and web.
- CI: iOS 44862036011 (ipa-test-build 29deb24) success, v2.7.88, artifact Super-Player-unsigned; install page
  https://tzzzzgdnnn.github.io/New/get/a3a158950610bf718216/ shows 2.7.88. Android 44862019823 (apk-port 9b442cb) success.
  Web deploy 44862036159 success. ipa-player-android-look (94f40ea, speed pill) is an ancestor of ipa-test-build, so the
  install-page IPA already has the pill; that branch was not moved.

## 18:50 ET session 6 — WHERE I STOPPED (read first)
- PUSHED: web server list cut to servers verified playing on web: Vidfast (Auto first), Cinejoy direct, Cinezo
  (`WEB_EMBED_ORDER`/`WEB_ALLOWED` in src/utils/api.js, web branch of applyServers in src/platform/ios/servers.js;
  webview.js tryWebDirect: web Auto no longer forces Cinejoy before the picked embed). Removed from web: Vidrift,
  7Movies, Aether, Flixer, ani.pm/Movy/Orion/Evion/Flixer direct/Rive. iOS/Android lists untouched.
- PUSHED: PWA updater never reloads while a webview/video/server iframe is on screen (src/main.ios.jsx `idle`).
- NOT DONE (#19 crash): Vidfast is still UNSANDBOXED. Montez asked to sandbox it (no allow-top-navigation), but the
  previous session verified Vidfast shows "Please Disable Sandbox" in ANY sandbox, so sandboxing it would leave web
  with no working embed. Next: test `sandbox="allow-scripts allow-same-origin allow-forms allow-popups
  allow-presentation"` on vidfast in WebKit (livecheck/sbx.mjs); if it refuses, keep unsandboxed.
- NOT DONE (#19): crash not reproduced yet. livecheck/soak.mjs (WebKit iPhone soak, logs crash/popup/main-nav/
  iframe src count; env MIN, SERVER, PICK, SW=1) failed only at picking the title (`getByText(PICK)` on Home timed
  out; TMDB 429 from sandbox IP at that moment). Suspects left: one `window` "message" listener per upgrade(wv) never
  removed (webview.js ~372, leak per title mount); prewarm <video data-sb-warm> buffering while an embed plays
  (memory -> iOS WebContent jetsam); webAutoNext loop is bounded by failedServers but uses menuId("auto").
- Data reset report (18:55): no commit 362bf26..e4588cb (or any web commit today) clears/renames storage keys,
  bumps a schema, or deletes caches/IndexedDB (sw.js untouched). Hardened src/platform/web/keepData.js anyway:
  restore also when localStorage lost most keys / profiles (fill missing keys only), and a much smaller snapshot no
  longer silently replaces the backup (old copy kept under IndexedDB sp-keep/kv "rescue"). iOS: a Home Screen web
  app and a Safari tab have SEPARATE storage; data from one only moves via the #sp-import carry-over.
- Relay (#20/#21): DROPPED by Montez (no hosting). relay/deno/relay.ts + main.ts committed, unused. Verified locally
  with deno 2.9: /anipm (ani.pm + settlar session + media via Referer/Origin embed.settlar.io), /relay + /media for
  7Movies Orion & Evion (movie 550, tv 1396) and Rive Citadel/PrimeVids (playlist rewrite + Range 206 OK); Movy
  api.wecollege.net = Cloudflare IP block (403) from the sandbox. Vercel entry (export default {fetch}) not written.

## Done (pushed)
- apk-port 1b8a2cf / ipa-test-build ccd322d:
  - **Android gets the iPhone server list** (`src/utils/api.js` `BROWSER_ONLY`; `src/platform/ios/servers.js` uses the
    iPhone order unless browser-only). Cinejoy, 7Movies Orion/Evion, Flixer, Rive, Movy resolved through
    CapacitorHttp (they already used it) and played one after another in the native player:
    `tryAndroidDirect` in `src/platform/ios/webview.js`; prefetch on title open in `src/platform/ios/playerBridge.js`.
    Android anime: ani.pm first (`tryWebAnipm`) unless an embed was picked by hand. Embeds after that, with the
    existing stream sniffer (MainActivity `sb-android-stream`).
  - **Android ad blocker**: `MainActivity.java` already had no multiple windows / no JS-opened windows (pop-ups).
    Added `shouldOverrideUrlLoading`: any main-frame navigation away from `localhost` is blocked (ad redirects,
    Play Store bounces); only tapped TMDB/GitHub/YouTube links go out.
  - **Android DNS ad-block**: `SbDns` JS bridge in MainActivity (`status()` reads private_dns_mode/specifier,
    `openSettings(host)` copies `dns.adguard-dns.com` and opens Settings > Connections/Network). Ad-block sheet
    (`src/platform/ios/web/AdBlockSheet.jsx`, `env.js`, `index.js`) now shows in the Android app with a
    "Copy hostname & open Settings" button; it re-probes (`probe.js`: ad hosts must fail, control must load)
    when the app comes back and closes itself once blocking is real. User taps: Copy hostname & open Settings ›
    (Samsung) More connection settings › Private DNS › Private DNS provider hostname › paste › Save › back to app.
  - **Web servers**: Aether (X-Frame-Options DENY) and 7Movies (X-Frame-Options SAMEORIGIN / frame-ancestors 'self')
    can never be framed by another site → hidden on web (`WEB_UNFRAMEABLE`). Vidfast refuses any sandbox
    ("Please Disable Sandbox") → unsandboxed (`SANDBOX_REFUSERS` in webview.js); verified playing in WebKit.
    Web embed order: Cinejoy > Cinezo > Vidfast > Flixer > Vidrift (last). Invalid `allow-presentation` flag dropped.
  - **Scroll**: `src/platform/ios/ios.css` `.main` height 100dvh, bottom spacer `::after` = tab bar + safe area
    (+84px when the Watch Party button is on screen, via `:has(.wp-fab)`). FAB made smaller (`src/watch/watch-party.css`).
  - **PWA update**: `src/main.ios.jsx` no longer treats a stuck embed iframe as "playing" (only an embed that
    reported progress in the last 30 s, `window.__sbEmbedPlayingAt` set in webview.js); update check every 2 min on focus.

## Root causes found
- Vidrift "Remove sandboxing" on iPhone Safari happens even with NO sandbox attribute (live build already had it
  unsandboxed): its pop-up check fails under Safari's pop-up blocker. Not fixable from our side without
  defeating its check (not allowed). It is last in web Auto now.
- Cinejoy "broken" for Avatar Aang (tmdb 980431): API (api2.wing.st, CORS *) answers, but every upstream stream
  is removed/404 (Light "Removed", Sirius 404, Rigel/Polaris none). Cinejoy works on web for titles Polaris has
  (Shawshank 278, Breaking Bad S1E1 verified: playlist 200 with ACAO *).
- 7Movies black on web = X-Frame-Options; Aether same (DENY).
- Android used the web server list because Android builds with VITE_WEB=1 (+VITE_ANDROID=1).

## Still owed / half-done
- DONE 362bf26/cfe10a3: web had NO server failover at all (did-fail-load only cleared a spinner); `nextServer`
  (was Android-only) now also drives web Auto (`webAutoNext` in webview.js). Verified LIVE in WebKit iPhone:
  Avatar Aang Auto -> Cinejoy (no stream) -> Cinezo (waits for tap, skipped) -> Vidfast PLAYS. Breaking Bad
  S1E1 Auto -> Cinejoy direct stream loaded. Dragon Ball Super: Beerus (anime) Auto -> Vidfast plays.
  Live scroll check: last row bottom 518 px < Watch Party button top 539 < tab bar 610 (iPhone 15 Pro viewport).
- Cinezo plays when tapped but is skipped by Auto's 8 s no-start watch (it waits for a tap); could count its
  `PLAYER_EVENT` messages as alive.
- Flixer site embed loads on web but its video stays readyState 0 in WebKit (unverified on a real iPhone).
- vidrift/7Movies/aether render blank in headless Linux WebKit, so they can't be verified here.
- Android per-server status: compiled only (CI), not run on a device/emulator. Untested: SbDns intents on Samsung
  A16, main-frame redirect block, direct servers via CapacitorHttp on Android.
- Cloudflare secrets (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) not set → room worker relay (/anipm) not
  deployed → web ani.pm, and any relay for 7Movies/Flixer/Rive/Movy (no CORS) cannot run in a browser.
  Generic relay for those APIs NOT written yet (next: add /relay?u= allow-list of those hosts to the room worker,
  gated like anipm's runtime config).
- Server parity table (iPhone/Android vs web) — see report in chat; web lacks 7Movies Orion/Evion, Flixer direct,
  Rive, Movy (no CORS → need relay), ani.pm (relay), custom/site servers (need native hidden web view).

## CI (latest)
- Android 44836321236 (apk-port 362bf26) success; Android 44835991866 (ef5e201) success.
- iOS 44836346653 (ipa-test-build cfe10a3) in progress at handoff; earlier iOS runs were cancelled by newer pushes.
- Web deploy 44836346636 (cfe10a3) success, live bundle index-MBXqgvGn.js.
  https://github.com/tzzzzgdnnn/New/actions

## Test tools
- /workspace/work/superplayer/livecheck/check.mjs (WebKit iPhone, per-server; LOCAL=dist dir serves a local build
  at the live URL), sbx.mjs (sandbox modes per embed), scroll.mjs (bottom clearance). WebKit needs the proxy
  passed explicitly and ignoreHTTPSErrors.
