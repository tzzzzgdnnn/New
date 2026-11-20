// Write SuperPlayer-AdBlock.mobileconfig for a DoH ServerURL.
// Usage: node make-profile.mjs https://superplayer-dns.<sub>.workers.dev/dns-query [out]
import { writeFileSync } from "node:fs";
import { buildMobileconfig } from "./profile.js";

const [url, out = new URL("./SuperPlayer-AdBlock.mobileconfig", import.meta.url)] = process.argv.slice(2);
if (!url) {
  console.error("usage: node make-profile.mjs <ServerURL> [out]");
  process.exit(2);
}
writeFileSync(out, buildMobileconfig(url));
console.log(`wrote ${out} for ${url}`);
