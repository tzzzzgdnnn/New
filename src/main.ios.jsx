// iOS entry (vite build --mode ios swaps this in for main.jsx).
// The shim must install window.electron before App's modules evaluate.
// First: keep localStorage room for the viewer's data (see storageGuard).
import "./utils/storageGuard";
import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import { bootIOS } from "./platform/ios/index.js";
import "./platform/ios/polish.css";
// Last: phone sizing pass (titles, gutters, landscape).
import "./platform/ios/screen-fit.css";
import { showLaunchSplash } from "./platform/ios/splash";
import { installImageReadyMarker } from "./platform/ios/imageReady";

import { installDiagnostics } from "./utils/diag";
import { keepData } from "./platform/web/keepData";
import { prepareWebLaunch, offerAdBlockSheet } from "./platform/ios/web";

installDiagnostics();

// Web install: keep the whole app on the phone (works if the site is down).
// Web app: browser stand-in for the app's native downloader (saved for
// offline), installed before the app asks whether downloads are available.
let webLaunch = Promise.resolve();
if (import.meta.env.VITE_WEB) {
  document.documentElement.classList.add("sb-web");
  // A Home Screen launch first imports the data carried over from Safari
  // (#sp-import), then keepData runs on the merged storage: persistent
  // storage + IndexedDB backup, restored (then reloaded) if the browser ever
  // empties localStorage.
  webLaunch = prepareWebLaunch()
    .catch((e) => console.warn("[web] launch prep failed", e))
    .then(() => keepData())
    .then((restored) => restored && location.reload());
  if (import.meta.env.VITE_ANDROID) {
    document.documentElement.classList.add("sb-android");
    import("./platform/tv/tv.js").then((m) => m.installTV()).catch(() => {});
    // Light on GPU: no live blur layers (the costliest effect on Android).
    const st = document.createElement("style");
    // Smooth 90/120 Hz: no blur layers, scroll areas on their own GPU layer,
    // off-screen rows skipped, and no tap-highlight repaints.
    st.textContent = [
      ".sb-android *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;-webkit-tap-highlight-color:transparent}",
      ".sb-android [class*=scroll],.sb-android [class*=Scroll],.sb-android [class*=row],.sb-android [class*=Row]{transform:translateZ(0);overscroll-behavior:contain}",
      ".sb-android [class*=row],.sb-android [class*=Row],.sb-android section{content-visibility:auto;contain-intrinsic-size:auto 260px}",
      ".sb-android img{content-visibility:auto}",
      // OLED: true-black base (pixels off), crisper white text, and cards a
      // touch lighter so they still separate from the black. Kept gentle.
      ".sb-android{--bg:#000;--sp-sheet-bg:#000;--text:#fff;--sp-chrome-bg:rgba(0,0,0,.82)}",
      ".sb-android,.sb-android body,.sb-android #root{background:#000!important}",
      ".sb-android{--surface:#141416;--sp-group-bg:#18181b}",
      ".sb-android body{-webkit-font-smoothing:antialiased;color:#fff}",
    ].join("");
    document.head.appendChild(st);
  }
  // Cinejoy (direct, no ads) becomes the default server once on the web app.
  try {
    if (!localStorage.getItem("sbWebCinejoyDefault")) {
      localStorage.setItem("sbWebCinejoyDefault", "1");
      for (const k of Object.keys(localStorage)) {
        if (/playerSource/i.test(k) && !/anime/i.test(k)) localStorage.setItem(k, JSON.stringify("cinejoy-direct"));
      }
    }
  } catch {}
  import("./platform/web/web.css");
  // Pop-up ads: no script on the page may open a new tab or window.
  try {
    window.__sbOpen = window.open.bind(window); // the app's own links (Settings, help)
    window.open = () => null;
  } catch {}
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target?.closest?.("a[target=_blank]");
      if (a && !a.dataset.sbAllow) e.preventDefault();
    },
    true,
  );
}
// Android app: the native downloader (like the iPhone app's). Web app: the
// browser downloader.
const webReady = import.meta.env.VITE_ANDROID
  ? webLaunch.then(() => import("./platform/web/androidDownloads")).then((m) => m.installAndroidDownloads()).catch(() => {})
  : import.meta.env.VITE_WEB
    ? webLaunch.then(() => import("./platform/web/offlineDownloads")).then((m) => m.installWebDownloads()).catch(() => {})
    : Promise.resolve();
if (import.meta.env.VITE_WEB && !import.meta.env.VITE_ANDROID && "serviceWorker" in navigator) {
  // Updates never reload the open app (that used to happen every time it
  // came back to the foreground after a deploy). A new version installs in
  // the background and takes over quietly; the app on screen keeps running
  // (the worker keeps the older version's files) and the new version shows
  // on the next launch.
  const takeOver = (reg) => reg.waiting?.postMessage({ type: "SKIP_WAITING" });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((reg) => {
      takeOver(reg);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => w.state === "installed" && takeOver(reg));
      });
      let lastCheck = 0;
      const check = () => {
        if (Date.now() - lastCheck < 10 * 60 * 1000) return;
        lastCheck = Date.now();
        reg.update().catch(() => {});
      };
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
      setInterval(check, 30 * 60 * 1000);
      check();
    }).catch(() => {});
  });
}
showLaunchSplash();
installImageReadyMarker();

webReady.then(bootIOS).then(async () => {
  const [{ default: App }, { default: ProfileGate }] = await Promise.all([
    import("./App"),
    import("./platform/ios/profiles/ProfileGate"),
  ]);
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <ProfileGate>
        <App />
      </ProfileGate>
    </React.StrictMode>,
  );
  if (import.meta.env.VITE_WEB) offerAdBlockSheet();
});
