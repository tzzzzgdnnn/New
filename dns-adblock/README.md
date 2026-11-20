# Super Player Ad Block (iOS DNS profile)

`SuperPlayer-AdBlock.mobileconfig` is the profile the web app's iOS sheet
installs (published on GitHub Pages at `/dns/SuperPlayer-AdBlock.mobileconfig`).
It is an unsigned `com.apple.dnsSettings.managed` profile that sets the device's
encrypted DNS (DoH) to AdGuard's public ad-blocking resolver,
`https://dns.adguard-dns.com/dns-query`.

## Optional upgrade: self-hosted worker with the app's own blocklist

`worker.js` is a Cloudflare Worker DoH endpoint (RFC 8484 GET `?dns=` and POST
`application/dns-message`). Names in `blocklist.txt` (the app's BLOCKED_HOSTS,
minus Google/DDG/CDN hosts that break other sites) or under them get
`0.0.0.0` / `::` (NOERROR, TTL 300); everything else is forwarded to
`https://cloudflare-dns.com/dns-query`. It also serves its own profile at
`/profile.mobileconfig` with the `application/x-apple-aspen-config` type.

- `node build-blocklist.mjs` embeds blocklist.txt into blocklist.js.
- `npm test` (here) runs crafted-packet tests under node.
- `.github/workflows/dns-adblock.yml` tests on every push to `dns-adblock-profile`,
  deploys the worker as `superplayer-dns` when the repo secrets
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist (skips with a warning
  otherwise), and, only when run by hand with `publish_profile` checked, replaces
  the published profile with one pointing at
  `https://superplayer-dns.<subdomain>.workers.dev/dns-query`. Both profiles share
  the same UUIDs, so installing the new one replaces the old.
