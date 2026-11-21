// Copies src/utils/customServers/nudge.js (NUDGE_JS) into StreambertPlayer.swift
// between the BEGIN / END NUDGE_JS markers, as a Swift raw string.
// Run: node scripts/gen-nudge-swift.mjs   (scripts/test-custom-discover.mjs checks it)
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const SWIFT = path.join(root, "ios/App/App/StreambertPlayer.swift");

export function nudgeSwiftBlock(js) {
  const body = js.replace(/^\n/, "").replace(/\n$/, "").split("\n").map((l) => (l ? "    " + l : l)).join("\n");
  if (body.includes('"""#')) throw new Error('nudge.js must not contain """#');
  return `    static let nudgeJS = #"""\n${body}\n    """#\n`;
}

export function withNudge(swift, js) {
  const a = swift.indexOf("    // BEGIN NUDGE_JS\n");
  const b = swift.indexOf("    // END NUDGE_JS\n");
  if (a < 0 || b < a) throw new Error("NUDGE_JS markers missing");
  return swift.slice(0, a) + "    // BEGIN NUDGE_JS\n" + nudgeSwiftBlock(js) + swift.slice(b);
}

// Run from the repo root: node scripts/gen-nudge-swift.mjs
if (/gen-nudge-swift\.mjs$/.test(process.argv[1] || "")) {
  const src = fs.readFileSync(path.join(root, "src/utils/customServers/nudge.js"), "utf8");
  const m = /export const NUDGE_JS = String\.raw`([\s\S]*?)`;/.exec(src);
  if (!m) throw new Error("NUDGE_JS not found");
  fs.writeFileSync(SWIFT, withNudge(fs.readFileSync(SWIFT, "utf8"), m[1]));
  console.log("StreambertPlayer.swift: nudge updated");
}
