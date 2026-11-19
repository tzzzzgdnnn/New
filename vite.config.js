import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import stripDesktopCss from "./vite/strip-desktop-css.mjs";
import pwa from "./vite/pwa.mjs";

export default defineConfig(({ mode }) => {
  const isDist = process.env.ELECTRON_DIST === "1";
  // "web" = the iPhone/Android UI as an installable web app (PWA).
  const isWeb = mode === "web";
  // "android" = the same phone app as iOS, wrapped by Capacitor as an APK.
  const isAndroid = mode === "android";
  const isIOS = mode === "ios" || isWeb || isAndroid;
  // iOS (Capacitor) build: swap the entry for src/main.ios.jsx. Desktop unchanged.
  const iosEntry = {
    name: "streambert-ios-entry",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace("/src/main.jsx", "/src/main.ios.jsx"),
    },
  };
  return {
    plugins: isIOS ? [react(), iosEntry, ...(isWeb ? [pwa()] : [])] : [react()],
    base: "./",
    // iOS: drop desktop-only rules from the shared stylesheets. Desktop CSS
    // is left exactly as written.
    ...(isIOS ? { css: { postcss: { plugins: [stripDesktopCss()] } } } : {}),
    build: {
      minify: "terser",
      terserOptions: {
        compress: {
          drop_console: isDist,
          drop_debugger: isDist,
        },
      },
      rollupOptions: {
        output: {
          manualChunks: {
            react: ["react", "react-dom"],
            // Desktop only; listing it here would pull it into the iOS build.
            ...(isIOS ? {} : { settings: ["./src/pages/SettingsPage"] }),
            movie: ["./src/pages/MoviePage"],
            tv: ["./src/pages/TVPage"],
            downloads: ["./src/pages/DownloadsPage"],
          },
        },
      },
    },
  };
});
