#!/bin/sh
# Dev-only: checks the native downloader's pure logic (DownloadMath.swift)
# with plain swiftc (Xcode on macOS, or a swift.org toolchain on Linux).
set -e
cd "$(dirname "$0")/.."
OUT="${TMPDIR:-/tmp}/sp-swift-tests"
mkdir -p "$OUT"
cp scripts/DownloadMathTests.swift "$OUT/main.swift"
swiftc -swift-version 5 ios/App/App/DownloadMath.swift "$OUT/main.swift" -o "$OUT/dlmath"
"$OUT/dlmath"
