// Where the web build is running: iPhone/iPad Safari tab, Home Screen app, or
// the native (Capacitor) app.
import { Capacitor } from "@capacitor/core";

export function isNativeApp() {
  try {
    if (Capacitor?.isNativePlatform?.()) return true;
  } catch {}
  return !!window.webkit?.messageHandlers?.bridge; // Capacitor's iOS bridge
}

export function isStandalone() {
  try {
    if (navigator.standalone === true) return true;
    return !!window.matchMedia?.("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

/** iPhone, iPod or iPad, including iPadOS's desktop-class (Macintosh) UA on a touch screen. */
export function isAppleMobile(ua = navigator.userAgent, platform = navigator.platform, touch = navigator.maxTouchPoints) {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && (platform === "MacIntel" || platform === "iPad") && Number(touch) > 1;
}

/** Real Safari (only Safari can install a configuration profile), not Chrome/Firefox/Edge/in-app browsers. */
export function isSafari(ua = navigator.userAgent) {
  if (!/Safari\//.test(ua) || !/Version\//.test(ua)) return false;
  return !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|YaBrowser|DuckDuckGo|FBAN|FBAV|Instagram|Line\/|Snapchat|Twitter/i.test(ua);
}

/** Show the ad-block sheet: iOS Safari tab only, never the native app or a Home Screen app. */
export function shouldOfferAdBlock() {
  return !isNativeApp() && !isStandalone() && isAppleMobile() && isSafari();
}

/** Ask the browser not to evict this origin's storage (Home Screen app). */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist) {
      if (await navigator.storage.persisted?.()) return true;
      return await navigator.storage.persist();
    }
  } catch {}
  return false;
}
