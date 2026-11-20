# HANDOFF — Super Player (2026-11-20, 18:20 ET)

Branches: `apk-port` (Android + all shared JS), `ipa-test-build` (iOS IPA + web Pages deploy). Shared JS is
copied file-by-file from apk-port to ipa-test-build (worktree pattern; never merge the Android folder there).
Live web app: https://tzzzzgdnnn.github.io/New/ (gh-pages, built by `.github/workflows/deploy-web.yml` on push to ipa-test-build).

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
- Web Auto test (local build, WebKit): Auto still ended on vidrift for Avatar after 2 silent skips
  (MAX_SILENT_SKIPS=2 in webview.js `armStartWatch`) — Cinezo loads its player but waits for a tap, so the 8 s
  no-start watch skips it. Next: check `src/platform/ios/autoRank.js` order on web and let a loaded-but-waiting
  player stay (or count Cinezo's PLAYER_EVENT messages as alive).
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
- Android 44835617107 (apk-port 1b8a2cf), iOS 44835682224, web deploy 44835682400, room server 44835682598 (ccd322d).
  https://github.com/tzzzzgdnnn/New/actions

## Test tools
- /workspace/work/superplayer/livecheck/check.mjs (WebKit iPhone, per-server; LOCAL=dist dir serves a local build
  at the live URL), sbx.mjs (sandbox modes per embed), scroll.mjs (bottom clearance). WebKit needs the proxy
  passed explicitly and ignoreHTTPSErrors.
