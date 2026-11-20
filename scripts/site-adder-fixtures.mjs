// Dev-only: fixture sites for the site adder's end-to-end test
// (scripts/e2e-site-adder.mjs). Each site runs on its own port of 127.0.0.1;
// "other domain" embed hosts use localhost. Every site style the adder has
// to handle has one: a GET search form, WordPress REST, a JavaScript-built
// site with its own JSON API and server list, a sitemap-only site, server /
// mirror buttons, a series with episode pages, Cloudflare-style checks,
// DRM pages that must be refused, a sign-in wall. Not bundled.
import http from "node:http";

const MASTER = (base) =>
  `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n${base}/360/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720\n${base}/720/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n${base}/1080/index.m3u8\n`;
const MEDIA = (keyUri) =>
  `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n${keyUri ? `#EXT-X-KEY:METHOD=AES-128,URI="${keyUri}",IV=0x00000000000000000000000000000001\n` : ""}#EXTINF:6.0,\nseg0.ts\n#EXTINF:6.0,\nseg1.ts\n#EXT-X-ENDLIST\n`;
const DRM_MEDIA = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key42",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n`;
const TS = Buffer.alloc(188 * 40, 0x47);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(4096, 1)]);
const KEY = Buffer.alloc(16, 7);

const page = (title, body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const FILMS = [
  ["The General", 1926],
  ["Nosferatu", 1922],
  ["Metropolis", 1927],
  ["Sherlock Jr.", 1924],
  ["Night of the Living Dead", 1968],
  ["His Girl Friday", 1940],
];

/** Packer (Dean Edwards style), so the fixture ships what real sites ship. */
export function pack(src, radix = 62) {
  const words = [...new Set(src.match(/\b\w+\b/g))];
  const enc = (c) => (c < radix ? "" : enc(Math.floor(c / radix))) + ((c = c % radix) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
  const index = new Map(words.map((w, i) => [w, enc(i)]));
  const p = src.replace(/\b\w+\b/g, (w) => index.get(w)).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('${p}',${radix},${words.length},'${words.join("|")}'.split('|'),0,{}))`;
}

const b64 = (s) => Buffer.from(s).toString("base64");
// Fake player libraries: setup() does nothing; the adder must read the link.
const FAKE_PLAYERS = `<script>window.jwplayer=function(){return{setup:function(){return this},on:function(){return this}}};window.videojs=function(){return{src:function(){}}};window.Plyr=function(){};window.Clappr={Player:function(){}};</script>`;

/** Serve media (HLS with variants + AES-128, MP4, DRM HLS) under /media on any site. */
function media(req, res, url) {
  const p = url.pathname;
  const send = (code, type, body) => {
    res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*" });
    res.end(body);
  };
  if (p.endsWith("/master.m3u8")) return send(200, "application/vnd.apple.mpegurl", MASTER(p.replace(/\/master\.m3u8$/, "")));
  if (/\/(360|720|1080)\/index\.m3u8$/.test(p)) return send(200, "application/vnd.apple.mpegurl", MEDIA(p.includes("/aes/") ? "/media/keys/k.key" : null));
  if (p.endsWith("/drm.m3u8")) return send(200, "application/vnd.apple.mpegurl", DRM_MEDIA);
  if (p.endsWith(".ts")) return send(200, "video/mp2t", TS);
  if (p.endsWith(".key")) return send(200, "application/octet-stream", KEY);
  if (p.endsWith(".mp4")) {
    // Hotlink guard: the MP4 needs the site's Referer (the adder must carry it).
    if (url.searchParams.get("guard") && !String(req.headers.referer || "").startsWith(`http://127.0.0.1:${req.socket.localPort}`)) return send(403, "text/plain", "no hotlinking");
    return send(200, "video/mp4", MP4);
  }
  return null;
}

const SITES = {
  // 1. Plain HTML, GET search form, <video> tag on the title page.
  form: (ctx) => ({
    "/": () => page("Classic Flix | Old movies", `<form action="/search" method="get"><input name="keyword" placeholder="Search movies"><button>Go</button></form>
      <nav><a href="/genre/comedy/">Comedy</a> <a href="/about/">About</a></nav>
      ${FILMS.map(([t, y]) => `<a href="/film/${slug(t)}-${y}/">${t} (${y})</a>`).join(" ")}`),
    "/search": (url) => {
      const q = (url.searchParams.get("keyword") || "").toLowerCase();
      return page("Search", FILMS.filter(([t]) => t.toLowerCase().includes(q)).map(([t, y]) => `<div class="item"><a href="/film/${slug(t)}-${y}/"><img alt="${t}"></a><h2><a href="/film/${slug(t)}-${y}/">${t} (${y})</a></h2></div>`).join(""));
    },
    "/film/*": (url) => page("Watch", `<h1>${url.pathname}</h1><video controls preload="auto" src="/media/${url.pathname.split("/")[2]}/movie.mp4?guard=1"></video>`),
  }),
  // 2. WordPress: REST search; the player is an iframe on another host with a packed JWPlayer setup (HLS master + AES-128).
  wp: (ctx) => ({
    "/": () => page("Silent Era Archive", `<link rel="https://api.w.org/" href="/wp-json/"><link rel="stylesheet" href="/wp-content/themes/x/style.css">
      ${FILMS.map(([t, y], i) => `<a href="/${2019 + (i % 3)}/0${1 + i}/${slug(t)}/">${t}</a>`).join(" ")}<a href="/category/drama/">Drama</a>`),
    "/wp-json/wp/v2/search": (url) => {
      const q = (url.searchParams.get("search") || "").toLowerCase();
      return { json: FILMS.map(([t, y], i) => ({ id: i, title: `${t} (${y})`, url: `http://127.0.0.1:${ctx.port}/${2019 + (i % 3)}/0${1 + i}/${slug(t)}/`, type: "post", subtype: "post" })).filter((x) => x.title.toLowerCase().includes(q)) };
    },
    "/20*": (url) => page("Film", `<article><iframe src="http://localhost:${ctx.port}/embed/${url.pathname.split("/")[3]}" allowfullscreen></iframe></article>`),
    "/embed/*": () => page("player", `${FAKE_PLAYERS}<div id="vplayer"></div><script>${pack(`jwplayer("vplayer").setup({sources:[{file:"http://localhost:${ctx.port}/media/aes/master.m3u8",label:"auto"}],autostart:false});`)}</script>`),
  }),
  // 3. JavaScript-built site with its own JSON API: list, search, title details and a server list. Source hidden in base64 + reversed string.
  spa: (ctx) => ({
    "/": () => page("ReelVault", `<div id="app">Loading…</div><input type="search" id="q" placeholder="Search"><script>
      fetch('/api/v1/list').then(r=>r.json()).then(d=>{document.getElementById('app').innerHTML=d.items.map(m=>'<a href="/title/'+m.id+'/'+m.slug+'">'+m.name+'</a>').join(' ')});
      var q=document.getElementById('q'); var t; q.addEventListener('input',function(){clearTimeout(t);t=setTimeout(function(){fetch('/api/v1/search?query='+encodeURIComponent(q.value)).then(r=>r.json()).then(function(d){document.getElementById('app').innerHTML=d.results.map(m=>'<a href="/title/'+m.id+'/'+m.slug+'">'+m.name+'</a>').join(' ')})},300)});
    </script>`),
    "/api/v1/list": () => ({ json: { items: FILMS.map(([t, y], i) => ({ id: 100 + i, slug: slug(t), name: t, year: y })) } }),
    "/api/v1/search": (url) => {
      const q = (url.searchParams.get("query") || "").toLowerCase();
      return { json: { results: FILMS.map(([t, y], i) => ({ id: 100 + i, slug: slug(t), name: t, year: y, url: `/title/${100 + i}/${slug(t)}` })).filter((x) => x.name.toLowerCase().includes(q)) } };
    },
    "/title/*": (url) => page("Title", `<div id="p"></div><script>
      fetch('/api/v1/sources?id=${url.pathname.split("/")[2]}').then(r=>r.json()).then(function(d){
        var s=d.servers[0]; var u=atob(s.data).split('').reverse().join('');
        var v=document.createElement('video'); v.muted=true; document.getElementById('p').appendChild(v); v.src=u;
      });</script>`),
    "/api/v1/sources": () => ({ json: { servers: [{ name: "Vault HD", data: b64([...`http://127.0.0.1:${ctx.port}/media/spa/v.mp4`].reverse().join("")) }, { name: "Backup", data: b64([...`http://127.0.0.1:${ctx.port}/media/spa2/v.mp4`].reverse().join("")) }] } }),
  }),
  // 4. No search at all: sitemap index; Video.js setup on the title page.
  sitemap: (ctx) => ({
    "/": () => page("Public Domain Theater", `<p>Browse by year.</p><a href="/about">About</a>`),
    "/robots.txt": () => ({ text: `User-agent: *\nSitemap: http://127.0.0.1:${ctx.port}/sitemap_index.xml\n` }),
    "/sitemap_index.xml": () => ({ xml: `<?xml version="1.0"?><sitemapindex><sitemap><loc>http://127.0.0.1:${ctx.port}/tag-sitemap.xml</loc></sitemap><sitemap><loc>http://127.0.0.1:${ctx.port}/movie-sitemap.xml</loc></sitemap></sitemapindex>` }),
    "/movie-sitemap.xml": () => ({ xml: `<?xml version="1.0"?><urlset>${FILMS.map(([t, y]) => `<url><loc>http://127.0.0.1:${ctx.port}/movie/${slug(t)}-${y}/</loc></url>`).join("")}</urlset>` }),
    "/tag-sitemap.xml": () => ({ xml: `<?xml version="1.0"?><urlset><url><loc>http://127.0.0.1:${ctx.port}/tag/silent/</loc></url></urlset>` }),
    "/movie/*": () => page("Movie", `${FAKE_PLAYERS}<video id="v" class="video-js"></video><script>var p=videojs('v',{}); p.src({type:'application/x-mpegURL',src:'\\/media\\/vjs\\/master.m3u8'});</script>`),
  }),
  // 5. Server / mirror buttons (base64 data-hash); the first server is dead, the second has a Plyr setup.
  mirrors: (ctx) => ({
    "/": () => page("Cinema Mirrors", `<form action="/" method="get"><input type="search" name="s"></form>${FILMS.map(([t, y]) => `<a href="/watch/${slug(t)}/">${t} ${y}</a>`).join(" ")}`),
    "/?s": (url) => page("Search", FILMS.filter(([t]) => t.toLowerCase().includes((url.searchParams.get("s") || "").toLowerCase())).map(([t, y]) => `<a href="/watch/${slug(t)}/">${t} ${y}</a>`).join("")),
    "/watch/*": () => page("Watch", `<ul class="servers"><li data-hash="${b64(`http://localhost:${ctx.port}/dead/1`)}">Server 1</li><li data-hash="${b64(`http://localhost:${ctx.port}/plyr/1`)}">Server 2</li></ul><div id="frame"></div>`),
    "/dead/*": () => page("gone", "File was deleted"),
    "/plyr/*": () => page("plyr", `${FAKE_PLAYERS}<video id="p"></video><script>var player=new Plyr('#p'); player.source = { type: 'video', sources: [{ src: 'http://localhost:${ctx.port}/media/plyr/master.m3u8', type: 'application/x-mpegURL' }] };</script>`),
  }),
  // 6. A series: title page lists episode pages; each episode packs a Clappr setup.
  tv: (ctx) => ({
    "/": () => page("Retro TV", `<form action="/find"><input name="q"></form>${["The Twilight Zone", "Dragnet", "Bonanza", "Lassie"].map((t) => `<a href="/show/${slug(t)}/">${t}</a>`).join(" ")}`),
    "/find": (url) => page("Find", ["The Twilight Zone", "Dragnet", "Bonanza", "Lassie"].filter((t) => t.toLowerCase().includes((url.searchParams.get("q") || "").toLowerCase())).map((t) => `<a href="/show/${slug(t)}/">${t}</a>`).join("")),
    "/show/*": (url) => {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 2) return page("Show", [1, 2].flatMap((s) => [1, 2, 3].map((e) => `<a href="/show/${parts[1]}/season-${s}/episode-${e}/">S${s} E${e}</a>`)).join(" "));
      return page("Episode", `${FAKE_PLAYERS}<script>${pack(`var player=new Clappr.Player({source:"http://127.0.0.1:${ctx.port}/media/${parts.slice(1).join("-")}/master.m3u8",parentId:"#p"});`)}</script>`);
    },
  }),
  // 7. Cloudflare-style check: a JS challenge sets a clearance cookie bound to the browser's User-Agent.
  cloudflare: (ctx) => ({
    gate: (req, url) => {
      if (url.pathname.startsWith("/media/") || url.pathname === "/__clear") return null;
      const m = /cf_clearance=([a-z0-9]+)/.exec(req.headers.cookie || "");
      const ua = m && ctx.clearance.get(m[1]);
      if (ua && ua === req.headers["user-agent"]) return null;
      ctx.blocked++;
      return { status: 403, html: `<!doctype html><html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget">Checking your browser</div><script>window._cf_chl_opt={};setTimeout(function(){fetch('/__clear').then(function(){location.reload()})},800)</script></body></html>` };
    },
    "/__clear": (url, req, res) => {
      const token = Math.random().toString(36).slice(2);
      ctx.clearance.set(token, req.headers["user-agent"]);
      res.setHeader("set-cookie", `cf_clearance=${token}; Path=/; HttpOnly`);
      return { text: "ok" };
    },
    "/": () => page("Guarded Classics", `<form action="/search"><input name="q" placeholder="Search"></form>${FILMS.map(([t, y]) => `<a href="/m/${slug(t)}-${y}">${t}</a>`).join(" ")}`),
    "/search": (url) => page("Results", FILMS.filter(([t]) => t.toLowerCase().includes((url.searchParams.get("q") || "").toLowerCase())).map(([t, y]) => `<a href="/m/${slug(t)}-${y}">${t} (${y})</a>`).join("")),
    "/m/*": () => page("Movie", `${FAKE_PLAYERS}<script>var cfg = JSON.parse('{"sources":[{"file":"http:\\\\/\\\\/127.0.0.1:${ctx.port}\\\\/media\\\\/cf\\\\/master.m3u8"}]}'); jwplayer('p').setup(cfg);</script>`),
  }),
  // 8. DRM (EME): the page asks for Widevine / FairPlay. Must be refused.
  drm: () => ({
    "/": () => page("Premium Classics", `<form action="/search"><input name="q"></form>${FILMS.map(([t, y]) => `<a href="/v/${slug(t)}-${y}">${t}</a>`).join(" ")}`),
    "/search": (url) => page("Results", FILMS.filter(([t]) => t.toLowerCase().includes((url.searchParams.get("q") || "").toLowerCase())).map(([t, y]) => `<a href="/v/${slug(t)}-${y}">${t}</a>`).join("")),
    "/v/*": () => page("Watch", `<video id="v"></video><script>
      var cfg=[{initDataTypes:['cenc'],videoCapabilities:[{contentType:'video/mp4; codecs="avc1.42E01E"'}]}];
      (navigator.requestMediaKeySystemAccess ? navigator.requestMediaKeySystemAccess('com.widevine.alpha', cfg).catch(function(){}) : 0);
      document.getElementById('v').src='/media/drm/movie.mp4';</script>`),
  }),
  // 9. DRM in the manifest only (FairPlay SAMPLE-AES): must be refused at the stream check.
  drmhls: (ctx) => ({
    "/": () => page("Locked Reels", `<form action="/search"><input name="q"></form>${FILMS.map(([t, y]) => `<a href="/v/${slug(t)}-${y}">${t}</a>`).join(" ")}`),
    "/search": (url) => page("Results", FILMS.filter(([t]) => t.toLowerCase().includes((url.searchParams.get("q") || "").toLowerCase())).map(([t, y]) => `<a href="/v/${slug(t)}-${y}">${t}</a>`).join("")),
    "/v/*": () => page("Watch", `<script>var s = "http://127.0.0.1:${ctx.port}/media/x/drm.m3u8";</script>`),
  }),
  // 10. Sign-in wall: the title page only has a login form.
  login: () => ({
    "/": () => page("Members Cinema", `<form action="/search"><input name="q"></form>${FILMS.map(([t, y]) => `<a href="/film/${slug(t)}-${y}">${t}</a>`).join(" ")}`),
    "/search": (url) => page("Results", FILMS.filter(([t]) => t.toLowerCase().includes((url.searchParams.get("q") || "").toLowerCase())).map(([t, y]) => `<a href="/film/${slug(t)}-${y}">${t}</a>`).join("")),
    "/film/*": () => page("Sign in", `<form method="post" action="/login"><input name="user"><input type="password" name="pw"></form>`),
  }),
};

function route(routes, path, search) {
  if (search && routes[`${path}?${[...new URLSearchParams(search).keys()][0]}`]) return routes[`${path}?${[...new URLSearchParams(search).keys()][0]}`];
  if (routes[path]) return routes[path];
  for (const k of Object.keys(routes)) if (k.endsWith("*") && path.startsWith(k.slice(0, -1))) return routes[k];
  return null;
}

/** Start every fixture site. Resolves to { sites: { name: url }, stats, close }. */
export async function startFixtures() {
  const servers = [];
  const sites = {};
  const stats = {};
  for (const [name, make] of Object.entries(SITES)) {
    const ctx = { port: 0, clearance: new Map(), blocked: 0, hits: [] };
    const routes = make(ctx);
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${ctx.port}`);
      ctx.hits.push({ path: url.pathname, ua: req.headers["user-agent"], cookie: req.headers.cookie || "", referer: req.headers.referer || "" });
      try {
        if (routes.gate) {
          const g = routes.gate(req, url);
          if (g) {
            res.writeHead(g.status, { "content-type": "text/html" });
            return res.end(g.html);
          }
        }
        if (url.pathname.startsWith("/media/") && media(req, res, url) !== null) return;
        const fn = route(routes, url.pathname, url.search);
        if (!fn) {
          res.writeHead(404, { "content-type": "text/html" });
          return res.end(page("Not found", "404"));
        }
        const out = await fn(url, req, res);
        if (typeof out === "string") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(out);
        }
        if (out.json !== undefined) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify(out.json));
        }
        res.writeHead(200, { "content-type": out.xml ? "application/xml" : "text/plain" });
        res.end(out.xml ?? out.text);
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    await new Promise((r) => srv.listen(0, "0.0.0.0", r));
    ctx.port = srv.address().port;
    sites[name] = `http://127.0.0.1:${ctx.port}/`;
    stats[name] = ctx;
    servers.push(srv);
  }
  return { sites, stats, close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))) };
}
