#!/bin/sh
# Dev-only: runs the iOS logic checks in Node (nothing here ships in the app).
# The search test needs happy-dom; it is installed without touching
# package.json / package-lock.json.
set -e
cd "$(dirname "$0")/.."
OUT="node_modules/.cache/sp-tests"
mkdir -p "$OUT"
node -e "require.resolve('happy-dom')" 2>/dev/null || npm install --no-save --no-audit --no-fund happy-dom@20 >/dev/null
for t in test-nav test-profiles test-search test-diag; do
  npx esbuild "scripts/$t.mjs" --bundle --platform=node --format=esm \
    --loader:.json=json --loader:.js=jsx --jsx=automatic \
    --define:import.meta.env='{"VITE_TARGET":"ios","VITE_TMDB_TOKEN":""}' \
    --define:process.env.NODE_ENV='"development"' \
    --external:happy-dom --log-level=warning --outfile="$OUT/$t.mjs"
  node "$OUT/$t.mjs"
done
