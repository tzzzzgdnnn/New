// Vite plugin for the web/PWA build only (`vite build --mode web`).
// - swaps the entry for src/main.web.jsx
// - adds the manifest link, theme color and iOS home-screen meta tags
// - emits the icons, manifest.webmanifest and sw.js (with the app-shell
//   precache list) next to index.html.
// Everything uses relative URLs, so the build works at any base path
// (GitHub Pages serves it from /New/).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS = ["icon-192.png", "icon-512.png", "maskable-192.png", "maskable-512.png", "apple-touch-icon.png"];

export const APP_NAME = "Super Player";
export const THEME_COLOR = "#0a0a0a";

export const manifest = {
  id: "./",
  name: APP_NAME,
  short_name: APP_NAME,
  description: "Movies, TV and anime player",
  start_url: "./",
  scope: "./",
  display: "standalone",
  display_override: ["standalone", "fullscreen"],
  orientation: "any",
  background_color: THEME_COLOR,
  theme_color: THEME_COLOR,
  categories: ["entertainment"],
  icons: [
    { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
    { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

const HEAD = `
    <meta name="theme-color" content="${THEME_COLOR}" />
    <meta name="color-scheme" content="dark" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="${APP_NAME}" />
    <meta name="application-name" content="${APP_NAME}" />
    <meta name="format-detection" content="telephone=no" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />
    <link rel="icon" type="image/png" sizes="192x192" href="./icons/icon-192.png" />
`;

export function webPwaPlugin() {
  return {
    name: "streambert-web-pwa",
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html
          .replace("/src/main.jsx", "/src/main.web.jsx")
          .replace(/<link rel="icon"[^>]*>\s*/, "")
          .replace(
            /<meta name="viewport"[^>]*>/,
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />',
          )
          .replace("</head>", HEAD + "  </head>"),
    },
    generateBundle(_opts, bundle) {
      for (const name of ICONS) {
        this.emitFile({ type: "asset", fileName: `icons/${name}`, source: readFileSync(join(HERE, "icons", name)) });
      }
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: JSON.stringify(manifest, null, 2) });
      // App shell: html, entry chunks, css, fonts, icons. Lazy page chunks are
      // cached on first use by the service worker's runtime cache.
      const shell = ["./", "./index.html", "./manifest.webmanifest", ...ICONS.map((n) => `./icons/${n}`)];
      for (const f of Object.keys(bundle)) {
        if (/\.(js|css|woff2)$/.test(f)) shell.push("./" + f);
      }
      const version = Date.now().toString(36);
      const sw = readFileSync(join(HERE, "sw.js"), "utf8")
        .replace("__SB_VERSION__", version)
        .replace("__SB_PRECACHE__", JSON.stringify(shell));
      this.emitFile({ type: "asset", fileName: "sw.js", source: sw });
    },
  };
}
