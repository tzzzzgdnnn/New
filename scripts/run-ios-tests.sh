#!/bin/sh
# Dev-only: runs the iOS logic checks in Node (nothing here ships in the app).
set -e
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"
for t in test-nav test-profiles; do
  npx esbuild "scripts/$t.mjs" --bundle --platform=node --format=esm \
    --loader:.json=json --log-level=warning --outfile="$OUT/$t.mjs"
  node "$OUT/$t.mjs"
done
rm -rf "$OUT"
