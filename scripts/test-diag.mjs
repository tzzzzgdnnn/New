// Dev-only: diagnostics log ring buffer, never-throw guarantees, reset trail.
import assert from "node:assert/strict";
const mem = new Map();
let failWrites = false;
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { if (failWrites && k === "sb_diag_log") throw new Error("QuotaExceededError"); mem.set(k, String(v)); },
  removeItem: (k) => mem.delete(k),
};
const listeners = {};
globalThis.window = globalThis;
window.addEventListener = (t, f) => ((listeners[t] ||= []).push(f));
globalThis.document = { addEventListener: () => {}, visibilityState: "visible" };
globalThis.location = { pathname: "/index.html" };
const appended = [];
window.webkit = { messageHandlers: { sbDiag: { postMessage: async (m) => { if (m.op === "append") appended.push(m.line); if (m.op === "read") return appended.join("\n"); return true; } } } };

const d = await import("../src/utils/diag.js");
let pass = 0;
const t = async (n, f) => { await f(); pass++; console.log("ok -", n); };

await t("every entry goes to the native file and the mirror", async () => {
  d.diag("nav", "home -> settings");
  assert.ok(appended.at(-1).includes("[nav] home -> settings"));
  assert.ok(mem.get("sb_diag_log").includes("home -> settings"));
});
await t("ring buffer keeps the last MAX_LINES", async () => {
  for (let i = 0; i < d.MAX_LINES + 50; i++) d.diag("x", `line ${i}`);
  const lines = mem.get("sb_diag_log").split("\n");
  assert.equal(lines.length, d.MAX_LINES);
  assert.ok(lines.at(-1).endsWith(`line ${d.MAX_LINES + 49}`));
});
await t("logging never throws (storage full, bad bridge, circular objects)", async () => {
  failWrites = true;
  const circ = {}; circ.self = circ;
  window.webkit.messageHandlers.sbDiag.postMessage = () => { throw new Error("bridge gone"); };
  assert.doesNotThrow(() => d.diag("error", circ, new Error("boom"), undefined, null));
  failWrites = false;
});
await t("a reset copies the last events before it next to the launch line", async () => {
  mem.set("sb_diag_web_open", "1"); // previous page never hid -> died while visible
  d.diag("nav", "settings -> home (tab bar back, depth 0)");
  d.installDiagnostics();
  const log = mem.get("sb_diag_log");
  assert.ok(/previous web session ended cleanly: no/.test(log));
  assert.ok(/app reset detected/.test(log));
  assert.ok(/before: .*settings -> home/.test(log));
});
await t("JS errors and unhandled rejections are captured", async () => {
  listeners.error[0]({ message: "TypeError: x is undefined", filename: "app.js", lineno: 3, colno: 9 });
  listeners.unhandledrejection[0]({ reason: new Error("fetch blew up") });
  const log = mem.get("sb_diag_log");
  assert.ok(log.includes("[error] TypeError: x is undefined"));
  assert.ok(log.includes("unhandled rejection: Error: fetch blew up"));
});
console.log(`\n${pass} diagnostics tests passed`);
