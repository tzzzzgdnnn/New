// Dev-only live check of the ani.pm resolver against the real API (not part
// of run-ios-tests.sh: needs network). Node's fetch is challenged by
// Cloudflare, so requests go through curl (like the app's native client).
// Run: node scripts/probe-anipm.mjs 21:1180:sub 16498:3:dub
import { execFileSync } from "node:child_process";
import { resolveAnipm, ANIPM_UA } from "../src/utils/servers/anipm.js";

const http = async (url, headers) => {
  const args = ["-s", "-m", "30", "-A", headers["User-Agent"] || ANIPM_UA];
  for (const [k, v] of Object.entries(headers)) if (k !== "User-Agent") args.push("-H", `${k}: ${v}`);
  const out = execFileSync("curl", [...args, url], { encoding: "utf8", maxBuffer: 1 << 24 });
  return JSON.parse(out);
};
const get = (url, range) => {
  const t = Date.now();
  const args = ["-s", "-m", "30", "-A", ANIPM_UA, "-o", "/dev/null", "-w", "%{http_code} %{size_download} %{time_starttransfer}"];
  if (range) args.push("-r", range);
  const [code, size, ttfb] = execFileSync("curl", [...args, url], { encoding: "utf8" }).split(" ");
  return { code: Number(code), size: Number(size), ttfbMs: Math.round(Number(ttfb) * 1000), ms: Date.now() - t };
};
const text = (url) => execFileSync("curl", ["-s", "-m", "30", "-A", ANIPM_UA, url], { encoding: "utf8" });

for (const spec of process.argv.slice(2)) {
  const [anilistId, episode, lang] = spec.split(":");
  try {
    const r = await resolveAnipm(http, { anilistId, episode, lang });
    const master = text(r.source);
    const variant = master.split("\n").find((l) => /^https?:/.test(l));
    const media = variant ? text(variant) : "";
    const seg = media.split("\n").find((l) => /^https?:/.test(l));
    const s = seg ? get(seg) : null;
    console.log(JSON.stringify({
      spec, ok: true, lang: r.lang, audio: r.audioLang, availability: r.availability, ms: r.ms,
      masterOk: master.startsWith("#EXTM3U"), variants: (master.match(/#EXT-X-STREAM-INF/g) || []).length,
      firstSegment: s && { code: s.code, bytes: s.size, ms: s.ms, MBps: +(s.size / 1048576 / (s.ms / 1000)).toFixed(2) },
    }));
  } catch (e) {
    console.log(JSON.stringify({ spec, ok: false, error: e.message }));
  }
}
