// Embed blocklist.txt into blocklist.js at build time (the worker imports it).
// Usage: node build-blocklist.mjs            writes blocklist.js
//        node build-blocklist.mjs --check    fails when blocklist.js is stale
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseBlocklist } from "./dns.js";

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const hosts = parseBlocklist(readFileSync(here("./blocklist.txt"), "utf8"));
const js =
  "// Generated from blocklist.txt by build-blocklist.mjs. Do not edit by hand.\n" +
  `export const BLOCKLIST = ${JSON.stringify(hosts, null, 1)};\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(here("./blocklist.js"), "utf8"); } catch {}
  if (current !== js) {
    console.error("blocklist.js is out of date; run: node dns-adblock/build-blocklist.mjs");
    process.exit(1);
  }
  console.log(`blocklist.js up to date (${hosts.length} hosts)`);
} else {
  writeFileSync(here("./blocklist.js"), js);
  console.log(`wrote blocklist.js (${hosts.length} hosts)`);
}
