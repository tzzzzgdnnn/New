// Web build only (iPhone/iPad Safari, Android browsers and the Home Screen
// app); a no-op in the native Capacitor app.
import { adBlockPlatform, isNativeApp, isStandalone, requestPersistentStorage } from "./env";
import { detectAdBlock, isAdBlockInstalled } from "./probe";
import { SHEET_KEY, importFromHash, readImportHash, stripImportHash } from "./transfer";

/** Before the app boots: Home Screen launch imports carried data once. */
export async function prepareWebLaunch() {
  if (isNativeApp()) return;
  if (isStandalone()) {
    requestPersistentStorage();
    const res = await importFromHash();
    if (res.imported) console.info("[sp-import] imported", res);
    return;
  }
  // Safari tab: a leftover #sp-import from a finished/dismissed sheet goes.
  let state = null;
  try {
    state = localStorage.getItem(SHEET_KEY);
  } catch {}
  if (readImportHash() && state !== "step2") stripImportHash();
}

/**
 * After the app renders: while ad-blocking DNS isn't known to be on, probe
 * for it quietly (every launch, any web context); once it is, the flag is set
 * and the sheet never shows again. Otherwise offer the sheet for this device
 * (iOS profile or Android Private DNS) unless the viewer closed it.
 */
export function offerAdBlockSheet(delayMs = 2500) {
  if (isNativeApp() || isAdBlockInstalled()) return;
  const platform = adBlockPlatform();
  const probed = detectAdBlock();
  if (!platform) return;
  let state = null;
  try {
    state = localStorage.getItem(SHEET_KEY);
  } catch {}
  if (state === "dismissed" || state === "done") return;
  setTimeout(async () => {
    if (await probed) return;
    const [{ default: React }, { createRoot }, { default: AdBlockSheet }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./AdBlockSheet"),
    ]);
    const host = document.createElement("div");
    host.id = "sp-adblock-sheet-root";
    document.body.appendChild(host);
    createRoot(host).render(React.createElement(AdBlockSheet, { platform }));
  }, delayMs);
}
