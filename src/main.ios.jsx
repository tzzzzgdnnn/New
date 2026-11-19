// iOS entry (vite build --mode ios swaps this in for main.jsx).
// The shim must install window.electron before App's modules evaluate.
import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/global.css";
import { bootIOS } from "./platform/ios/index.js";

bootIOS().then(async () => {
  const { default: App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
