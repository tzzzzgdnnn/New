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

/** An Android phone or tablet's browser (an app's embedded WebView, "; wv)", is not one). */
export function isAndroidBrowser(ua = navigator.userAgent) {
  return /Android/i.test(ua) && !/; wv\)/.test(ua);
}

/**
 * Which ad-block sheet this device gets: "ios" (the .mobileconfig profile,
 * Safari tab only: only Safari installs profiles, and the Home Screen app
 * can't), "android" (Private DNS steps, browser tab or installed web app),
 * or null (native app, desktop, other iOS browsers).
 */
export function adBlockPlatform() {
  // Android app: the same Private DNS steps, with a button that opens Settings.
  if (isNativeApp()) return typeof window !== "undefined" && window.SbDns ? "android" : null;
  if (isAppleMobile()) return !isStandalone() && isSafari() ? "ios" : null;
  return isAndroidBrowser() ? "android" : null;
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
