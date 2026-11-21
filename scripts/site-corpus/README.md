# Site corpus for the Custom Servers site adder (work in progress)

Status (2026-11-20 23:07 EST): stopped on request before run.mjs was written.
Present: sites.json (20 sites: expected movie/TV/anime routes, ID type, search,
servers, stream recipe, blocking, scheme, appCanPlay) and trimmed fixtures/
(HTML/JSON per site + router-route excerpts of site bundles; routes.json maps
path -> file + HTTP status). No success rate measured yet.

Not yet done: run.mjs (smartAdd offline against fixtures, --live), baseline numbers.

Sandbox notes: Playwright Chromium launches after `sudo apt-get install` of
libatk1.0-0t64 and friends (playwright@latest, chromium_headless_shell-1255);
WebKit still fails (missing gstreamer, gtk4, graphene, libxslt, libevent, etc.).
