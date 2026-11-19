// Web (installable PWA) build: manifest, home-screen tags and a service worker
// that keeps every file of the app on the phone, so the installed app opens
// even when the site it came from is down. Only used by `vite build --mode web`.
import fs from "node:fs";
import path from "node:path";

const NAME = "Super Player";

export default function pwa() {
  let outDir = "dist";
  return {
    name: "streambert-pwa",
    configResolved(c) {
      outDir = c.build.outDir;
    },
    transformIndexHtml: {
      order: "post",
      handler: (html) =>
        html
          .replace('href="/logo.svg"', 'href="./logo.svg"')
          .replace(
            "</head>",
            `    <link rel="manifest" href="./manifest.webmanifest" />
        <link rel="apple-touch-icon" href="./sized/512x512.png" />
        <meta name="theme-color" content="#000000" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="${NAME}" />
    </head>`,
          ),
    },
    closeBundle() {
      const files = [];
      const walk = (d) => {
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f);
          if (fs.statSync(p).isDirectory()) walk(p);
          else files.push(path.relative(outDir, p).split(path.sep).join("/"));
        }
      };
      walk(outDir);
      const precache = ["./", ...files.filter((f) => !/\.(bmp|map)$/.test(f) && f !== "sw.js").map((f) => `./${f}`)];
      fs.writeFileSync(
        path.join(outDir, "manifest.webmanifest"),
        JSON.stringify(
          {
            name: NAME,
            short_name: NAME,
            start_url: "./",
            scope: "./",
            display: "standalone",
            orientation: "any",
            background_color: "#000000",
            theme_color: "#000000",
            icons: [
              { src: "./sized/256x256.png", sizes: "256x256", type: "image/png" },
              { src: "./sized/512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
            ],
          },
          null,
          2,
        ),
      );
      const version = Date.now().toString(36);
      const sw = fs.readFileSync(new URL("./sw.template.js", import.meta.url), "utf8")
        .replace("__VERSION__", version)
        .replace("__PRECACHE__", JSON.stringify(precache));
      fs.writeFileSync(path.join(outDir, "sw.js"), sw);
    },
  };
}
