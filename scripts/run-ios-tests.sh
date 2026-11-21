#!/bin/sh
# Dev-only: runs the iOS logic checks in Node (nothing here ships in the app).
# The search test needs happy-dom; it is installed without touching
# package.json / package-lock.json.
set -e
cd "$(dirname "$0")/.."
OUT="node_modules/.cache/sp-tests"
mkdir -p "$OUT"
node -e "require.resolve('happy-dom')" 2>/dev/null || npm install --no-save --no-audit --no-fund happy-dom@20 >/dev/null
for t in test-nav test-profiles test-search test-home test-diag test-servers test-downloads test-downloads-group test-kids test-anipm test-movy test-cinejoy test-anilist-map test-server-sheet test-player-tap test-net-pill test-skip-pill test-screen-fit test-custom-servers test-info-sheet test-nostalgia test-web-transfer test-quality test-custom-direct test-custom-smartadd test-custom-discover test-custom-scheme; do
  npx esbuild "scripts/$t.mjs" --bundle --platform=node --format=esm \
    --loader:.json=json --loader:.js=jsx --loader:.css=empty --jsx=automatic \
    --define:import.meta.env='{"VITE_TARGET":"ios","VITE_TMDB_TOKEN":""}' \
    --define:process.env.NODE_ENV='"development"' \
    --external:happy-dom --log-level=warning --outfile="$OUT/$t.mjs"
  node "$OUT/$t.mjs"
done
# Web-app build (VITE_WEB): the browser embed player (#19 leak/prewarm/failover, #26 Cinezo).
for t in test-web-player; do
  npx esbuild "scripts/$t.mjs" --bundle --platform=node --format=esm \
    --loader:.json=json --loader:.js=jsx --loader:.css=empty --jsx=automatic \
    --define:import.meta.env='{"VITE_TARGET":"ios","VITE_WEB":"1","VITE_TMDB_TOKEN":""}' \
    --define:process.env.NODE_ENV='"development"' \
    --external:happy-dom --log-level=warning --outfile="$OUT/$t.mjs"
  node "$OUT/$t.mjs"
done
