# Known issues (updated every push)

Last update: 2026-11-21 00:36 EST (retest memory needs a real play, 404 pages end fast, rounds give each link its full wait; tracking issue #28).

## Fixed in code, not yet verified on a device
- Per-site link wait used everywhere (no more fixed "15 s" message).
- HLS checked before playing (#EXTM3U, master -> variant -> first segment); bad links fall through to the next one.
- Generic page titles ("Fly Stream - Now Playing / Now Streaming") are neutral, not a wrong title.
- HTTP 4xx/404 pages show red and never count as working.
- Test rounds (default 3, max 10), servers checked 4 at a time, "N of M servers work" count.
- Every API server tried; each working one is its own Sources entry; learned API saved as a recipe for all titles.
- Anime links saved only to the Anime list (beside ani.pm); sub and dub separate.
- iPhone search field has an accessible label; its loading poster tiles say "Searching" to VoiceOver (role=status, aria-busy).
- UI tests test-search, test-kids, test-downloads-group pass again: they now read the iPhone search screen and the episode picker where they are drawn (over the whole app), and test-kids also checks the iPhone search uses the kids filter.

- Retest memory keeps a link as "worked" only when its Plays check passed (play-pass mark, memory version 2). Older "worked" flags (e.g. flystream /movie/345887, sniffed but never played) are re-tested; a stream found but not playable is re-tested every round; a link the real player failed on is forgotten.
- A custom site's HTTP 4xx/5xx page (e.g. flystream /tv/1396/1/1 404) ends its hidden page at once instead of "Still looking… of 115 s".
- Rounds no longer burn out in seconds: a link's try that ends early with nothing definite is reopened on the same clock until its per-link wait is used (or a 404 / block / page error / stream check gives an answer); the next round starts only after that.

## Still to fix
- basementx.lol-style sites: "Also plays <title>" extra-title checks aren't retried in later rounds, don't show the built link, and don't press the play/Resume button the main link needed.
- Site adder: test every server on the page for every title ("N of M servers work" per title) and fall back to the site's own search (title + year) when a built link 404s or shows the wrong title; save the search method in the recipe.
- A CoreMedia failure inside the native player only clears "worked" when the app's server failover runs (JS side); no direct native -> memory report yet.
- flystream.net: CoreMedia 1718449215 on device. Root cause unconfirmed (live request hit a bot check). Disguised segments (.png/.jpg) are detected and skipped, not played (no local proxy).
- fmfau.com: pinned sub-server copy is dead (404 "Removed"); sub-server rotation unconfirmed on device.
- Site corpus: 12/18 sites, 27/35 routes (77%). Failing: m-zone, movy, vidsrc-sh, 2embed, autoembed, multiembed.
- Anime: no Dub link for sites whose links have no sub/dub part; no site-search anime id lookup; site-search servers default Anime off.
- Swift changes not compiled locally; IPA build is the first compile check (run for 026158e still building at 00:50 EST; f5d7720 run was cancelled by the newer push).
- Watch party screens not built; Worker not deployed.
- Thanksgiving holiday row not found / not built.

## Won't do
- Bypassing Cloudflare, bot checks, captchas, logins or DRM. Blocked sites are dropped.
