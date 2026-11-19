import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const isDist = process.env.ELECTRON_DIST === "1";
  const isIOS = mode === "ios";
  // iOS (Capacitor) build: swap the entry for src/main.ios.jsx. Desktop unchanged.
  const iosEntry = {
    name: "streambert-ios-entry",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace("/src/main.jsx", "/src/main.ios.jsx"),
    },
  };
  return {
    plugins: isIOS ? [react(), iosEntry] : [react()],
    base: "./",
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
            settings: ["./src/pages/SettingsPage"],
            movie: ["./src/pages/MoviePage"],
            tv: ["./src/pages/TVPage"],
            downloads: ["./src/pages/DownloadsPage"],
          },
        },
      },
    },
  };
});
