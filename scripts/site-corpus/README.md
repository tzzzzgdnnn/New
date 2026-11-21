# Site corpus for the Custom Servers site adder (work in progress)

Run: `sh scripts/run-ios-tests.sh` (last step), or bundle run.mjs the same way
and `node` it (`--json` for raw results). run.mjs runs smartAdd on each site's
`paste` link fully offline: fixture HTTP from routes.json (other hosts don't
answer), a fake TMDB with the corpus titles, no native page tries. Score per
site = expected routes (sites.json) learned exactly (www. ignored). Report only:
known-failing sites are listed and never fail the run. Sites without fixtures
(7movies, videasy) are skipped.

Baseline 2026-11-21 (after 1f87c26): 11/18 sites fully learned, 26/35 routes (74%).
With the fake AniList (corpus anime) and anime link detection: 12/18, 27/35 (77%); ani-pm passes.
Failing offline: m-zone (keeps /details/ links; switching to /embed/ needs a
page try), movy (built-in; stays
http because the fixture has no "/"), vidsrc-sh, 2embed, autoembed, multiembed
(TV link shape not learned).

Sandbox notes: Playwright Chromium launches after `sudo apt-get install` of
libatk1.0-0t64 and friends (playwright@latest, chromium_headless_shell-1255);
WebKit still fails (missing gstreamer, gtk4, graphene, libxslt, libevent, etc.).
