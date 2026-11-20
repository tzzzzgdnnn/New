// Is ad-blocking DNS (the iOS profile or Android Private DNS, both AdGuard)
// active on this device? AdGuard answers 0.0.0.0 for ad hosts, so a request
// to one fails at once, while an ordinary host still loads. A failing control
// request (offline, captive portal) makes the answer unknown, never "installed".

/** Hosts AdGuard DNS blocks (0.0.0.0). Both must fail for "blocked". */
export const AD_PROBES = [
  "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
  "https://securepubads.g.doubleclick.net/tag/js/gpt.js",
];
/** A host AdGuard never blocks: proves the network itself works. */
export const CONTROL_PROBE = "https://www.gstatic.com/generate_204";
export const PROBE_TIMEOUT_MS = 3000;

/** Persisted flag (streambert_ prefix: mirrored by keepData, carried by #sp-import). */
export const INSTALLED_KEY = "streambert_adblockInstalled";

export const isAdBlockInstalled = () => {
  try {
    return localStorage.getItem(INSTALLED_KEY) === "1";
  } catch {
    return false;
  }
};
export const markAdBlockInstalled = () => {
  try {
    localStorage.setItem(INSTALLED_KEY, "1");
  } catch {}
};

/** "ok" (loaded), "error" (refused at once: DNS-blocked) or "timeout". */
function reach(url, fetchFn, timeoutMs) {
  const sep = url.includes("?") ? "&" : "?";
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ctrl?.abort();
      resolve("timeout");
    }, timeoutMs);
    fetchFn(`${url}${sep}sp=${Date.now().toString(36)}`, { mode: "no-cors", cache: "no-store", credentials: "omit", signal: ctrl?.signal })
      .then(() => "ok", () => "error")
      .then((r) => {
        clearTimeout(timer);
        resolve(r);
      });
  });
}

/**
 * true: ad hosts are blocked while the network works (installed);
 * false: an ad host loaded; null: can't tell (offline, slow network).
 */
export async function probeAdBlock({ fetchFn = globalThis.fetch?.bind(globalThis), timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!fetchFn) return null;
  const [control, ...ads] = await Promise.all([CONTROL_PROBE, ...AD_PROBES].map((u) => reach(u, fetchFn, timeoutMs)));
  if (ads.includes("ok")) return false;
  if (control !== "ok" || ads.includes("timeout")) return null;
  return true;
}

/** Probe and, when ad-blocking DNS is on, set the flag for good. Resolves to the flag. */
export async function detectAdBlock(opts) {
  if (isAdBlockInstalled()) return true;
  if ((await probeAdBlock(opts)) === true) markAdBlockInstalled();
  return isAdBlockInstalled();
}
