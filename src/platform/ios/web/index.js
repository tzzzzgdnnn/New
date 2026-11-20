// Web build only (iPhone/iPad Safari and the Home Screen app); a no-op in the
// native Capacitor app.
import { isNativeApp, isStandalone, requestPersistentStorage, shouldOfferAdBlock } from "./env";
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

/** After the app renders: offer the ad-block sheet in iOS Safari. */
export function offerAdBlockSheet(delayMs = 2500) {
  if (!shouldOfferAdBlock()) return;
  let state = null;
  try {
    state = localStorage.getItem(SHEET_KEY);
  } catch {}
  if (state === "dismissed" || state === "done") return;
  setTimeout(async () => {
    const [{ default: React }, { createRoot }, { default: AdBlockSheet }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./AdBlockSheet"),
    ]);
    const host = document.createElement("div");
    host.id = "sp-adblock-sheet-root";
    document.body.appendChild(host);
    createRoot(host).render(React.createElement(AdBlockSheet));
  }, delayMs);
}
