# iOS production configuration

## Web inspector
`capacitor.config.json` → `ios.webContentsDebuggingEnabled: false`. Release
builds can no longer be inspected from Safari's Develop menu. For a debug
session, flip it to `true` locally (do not commit). Crash/reset details are
in **Settings › Diagnostics log** instead.

## App Transport Security (Info.plist)
Kept, and why:

| Key | Why it stays |
|---|---|
| `NSAllowsArbitraryLoadsForMedia` | The native player (AVPlayer) plays HLS/MP4 from whatever CDN a streaming server hands out; some still serve plain `http`. |
| `NSAllowsArbitraryLoadsInWebContent` | Embed pages (visible fallback iframe and the hidden stream sniffer web views) load third-party players and their sub-resources, some over `http`. |
| `NSAllowsLocalNetworking` | AirPlay / local-network targets and `localhost`-style hosts. |

Removed: `NSAllowsArbitraryLoads`. Since iOS 10 it is ignored whenever
`NSAllowsArbitraryLoadsForMedia` or `NSAllowsArbitraryLoadsInWebContent` is
present, so it granted nothing and only made the exemption look broader. All
other app traffic (TMDB, AniList, Wyzie, downloads through URLSession) needs
`https`.

If a streaming provider stops working with a TLS/ATS error in the
diagnostics log, add a per-domain `NSExceptionDomains` entry for that host
rather than a global exemption.
