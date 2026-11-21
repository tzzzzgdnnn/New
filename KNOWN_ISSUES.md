# Known issues (updated every push)

Last update: 2026-11-21 00:23 EST, after f5d7720.

## Fixed in code, not yet verified on a device
- Per-site link wait used everywhere (no more fixed "15 s" message).
- HLS checked before playing (#EXTM3U, master -> variant -> first segment); bad links fall through to the next one.
- Generic page titles ("Fly Stream - Now Playing / Now Streaming") are neutral, not a wrong title.
- HTTP 4xx/404 pages show red and never count as working.
- Test rounds (default 3, max 10), servers checked 4 at a time, "N of M servers work" count.
- Every API server tried; each working one is its own Sources entry; learned API saved as a recipe for all titles.
- Anime links saved only to the Anime list (beside ani.pm); sub and dub separate.

## Still to fix
- flystream.net: CoreMedia 1718449215 on device. Root cause unconfirmed (live request hit a bot check). Disguised segments (.png/.jpg) are detected and skipped, not played (no local proxy).
- fmfau.com: pinned sub-server copy is dead (404 "Removed"); sub-server rotation unconfirmed on device.
- Site corpus: 12/18 sites, 27/35 routes (77%). Failing: m-zone, movy, vidsrc-sh, 2embed, autoembed, multiembed.
- Anime: no Dub link for sites whose links have no sub/dub part; no site-search anime id lookup; site-search servers default Anime off.
- UI tests failing in sandbox: test-search, test-kids, test-downloads-group.
- Swift changes not compiled locally; IPA build is the first compile check.
- Watch party screens not built; Worker not deployed.
- Thanksgiving holiday row not found / not built.

## Won't do
- Bypassing Cloudflare, bot checks, captchas, logins or DRM. Blocked sites are dropped.
