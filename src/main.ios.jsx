// iOS entry (vite build --mode ios swaps this in for main.jsx).
// The shim must install window.electron before App's modules evaluate.
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

installDiagnostics();

// Web install: keep the whole app on the phone (works if the site is down).
// Web app: browser stand-in for the app's native downloader (saved for
// offline), installed before the app asks whether downloads are available.
if (import.meta.env.VITE_WEB) {
  document.documentElement.classList.add("sb-web");
  import("./platform/web/web.css");
}
const webReady = import.meta.env.VITE_WEB
  ? import("./platform/web/offlineDownloads").then((m) => m.installWebDownloads()).catch(() => {})
  : Promise.resolve();
if (import.meta.env.VITE_WEB && "serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
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
});
