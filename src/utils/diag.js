// Crash-proof diagnostics log (iOS). Every event is written as it happens:
// to a native file through the sbDiag bridge (flushed per entry, survives a
// WebContent kill or app crash) and mirrored in localStorage. Ring of the last
// MAX_LINES lines. Viewed, copied and cleared in Settings -> About.
// Logging must never break the app: everything here is wrapped in try/catch.

export const MAX_LINES = 2000;
const MIRROR_KEY = "sb_diag_log";
const MIRROR_MAX_CHARS = 120 * 1024;
const WEB_OPEN_KEY = "sb_diag_web_open";
const MAX_MSG = 600;

let mirror = null; // lines, loaded lazily
let installed = false;

const native = () => {
  try {
    return window.webkit?.messageHandlers?.sbDiag || null;
  } catch {
    return null;
  }
};

function loadMirror() {
  if (mirror) return mirror;
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    mirror = raw ? raw.split("\n").filter(Boolean) : [];
  } catch {
    mirror = [];
  }
  return mirror;
}

// Secrets never reach the log: API keys and tokens in URLs or text are masked
// before a line is written to the native file or the localStorage mirror.
const SECRET_PARAM = /([?&;]|\b)((?:api[_-]?key|apikey|key|token|access[_-]?token|auth|password|secret|sig|signature)=)[^&\s"']+/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
export function redact(text) {
  return String(text).replace(SECRET_PARAM, "$1$2[redacted]").replace(BEARER, "$1 [redacted]");
}

function str(v) {
  try {
    if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? ` | ${v.stack.split("\n").slice(0, 3).join(" < ")}` : ""}`;
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Record one event.
 * @param {string} type short tag: error, nav, profile, app, player, net…
 * @param {...any} parts message parts (errors and objects are stringified)
 */
export function diag(type, ...parts) {
  try {
    const msg = redact(parts.map(str).join(" ").replace(/\s+/g, " ")).slice(0, MAX_MSG);
    const line = `${new Date().toISOString()} [${type}] ${msg}`;
    const h = native();
    if (h) {
      try {
        const p = h.postMessage({ op: "append", line });
        p?.catch?.(() => {});
      } catch {}
    }
    const lines = loadMirror();
    lines.push(line);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    // The localStorage mirror stays small (WebKit's ~5 MB quota is shared
    // with the viewer's profiles, history and settings).
    let text = lines.join("\n");
    if (text.length > MIRROR_MAX_CHARS) {
      text = text.slice(text.length - MIRROR_MAX_CHARS);
      text = text.slice(text.indexOf("\n") + 1);
    }
    try {
      localStorage.setItem(MIRROR_KEY, text);
    } catch {
      // Storage full: keep the newest half so logging itself never fails.
      try {
        lines.splice(0, Math.ceil(lines.length / 2));
        localStorage.setItem(MIRROR_KEY, lines.join("\n"));
      } catch {}
    }
  } catch {}
}

/** Full log as plain text (native file when available, else the mirror). */
export async function readDiag() {
  try {
    const h = native();
    if (h) {
      const text = await h.postMessage({ op: "read" });
      if (typeof text === "string" && text.trim()) return text.trim();
    }
  } catch {}
  return loadMirror().join("\n");
}

/** Erase the log (native file and mirror). */
export async function clearDiag() {
  mirror = [];
  try {
    localStorage.removeItem(MIRROR_KEY);
  } catch {}
  try {
    await native()?.postMessage({ op: "clear" });
  } catch {}
  diag("app", "diagnostics log cleared");
}

/** Hook global error sources and lifecycle events. Safe to call once at boot. */
export function installDiagnostics() {
  if (installed) return;
  installed = true;
  try {
    let prevOpen = null;
    try {
      prevOpen = localStorage.getItem(WEB_OPEN_KEY);
      localStorage.setItem(WEB_OPEN_KEY, "1");
    } catch {}
    const rec = window.__sbRecovered;
    // A reset of any kind (WebContent kill, page died while visible): copy the
    // last actions before it next to the launch line so the cause is easy to
    // see even when the log is long.
    if (rec || prevOpen === "1") {
      const before = loadMirror()
        .filter((l) => /\[(nav|profile|error|crash|console|app|native|player)\]/.test(l))
        .slice(-15);
      if (before.length) {
        diag("reset", `--- app reset detected; last ${before.length} events before it ---`);
        before.forEach((l) => diag("reset", `before: ${l}`));
      }
    }
    diag(
      "app",
      `web launch ${location.pathname} ua=${navigator.userAgent.match(/OS [\d_]+/)?.[0] || "?"}`,
      `| previous web session ended cleanly: ${prevOpen === "1" ? "no (page died or reloaded while visible)" : "yes"}`,
      rec ? `| RECOVERY reload after ${rec.reason} #${rec.count} (app ${rec.appState})` : "",
    );

    window.addEventListener("error", (e) => {
      // Resource load errors (img/script) have no message; log the element.
      if (e?.message) diag("error", e.message, `@ ${e.filename || "?"}:${e.lineno || 0}:${e.colno || 0}`, e.error || "");
      else if (e?.target && e.target !== window) diag("error", `failed to load <${e.target.tagName?.toLowerCase()}> ${e.target.src || e.target.href || ""}`);
    }, true);
    window.addEventListener("unhandledrejection", (e) => {
      const r = e?.reason;
      if (r?.name === "AbortError") return;
      diag("error", "unhandled rejection:", r ?? "(no reason)");
    });

    const origError = console.error;
    console.error = function (...args) {
      try {
        diag("console", ...args);
      } catch {}
      return origError.apply(this, args);
    };

    const setOpen = (v) => {
      try {
        localStorage.setItem(WEB_OPEN_KEY, v);
      } catch {}
    };
    document.addEventListener("visibilitychange", () => {
      diag("app", `visibility ${document.visibilityState}`);
      setOpen(document.visibilityState === "hidden" ? "0" : "1");
    });
    window.addEventListener("pagehide", () => {
      diag("app", "pagehide");
      setOpen("0");
    });
    window.addEventListener("online", () => diag("net", "online"));
    window.addEventListener("offline", () => diag("net", "offline"));
    window.addEventListener("sb-native-diag", (e) => diag("native", e?.detail || ""));
  } catch {}
}
