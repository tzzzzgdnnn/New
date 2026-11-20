// Rivestream (www.rivestream.app) stream API, taken from its Next.js web
// player (_next/static/chunks/pages/_app-*.js). Sources come from
//   /api/backendfetch?requestID=movieVideoProvider&id=<tmdb>&service=<server>
//   /api/backendfetch?requestID=tvVideoProvider&id=<tmdb>&season=&episode=&service=
// plus "&secretKey=<k>&proxyMode=undefined", where k is the site's own hash of
// the TMDB id (copied verbatim below). Answers are plain JSON:
//   { data: { sources: [{ quality, url, source, format: "hls" }], captions } }
// Pure logic; the caller passes the HTTP GET.

export const RIVE_ORIGIN = "https://www.rivestream.app";
export const RIVE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// Servers whose playlists and segments were verified to load (TMDB 550 and 1396 S1E1).
// pick: which of the server's sources to use (others are disguised/unplayable).
export const RIVE_SERVERS = {
  citadel: { label: "Rive Citadel", pick: (s) => s.find((x) => /english/i.test(x.quality || "")) || s[0] },
  primevids: { label: "Rive PrimeVids", pick: (s) => s.find((x) => x.quality === "dcloud") || null },
};

// The site's key table and hash (minified, verbatim from its bundle).
const c = ["4Z7lUo","gwIVSMD","PLmz2elE2v","Z4OFV0","SZ6RZq6Zc","zhJEFYxrz8","FOm7b0","axHS3q4KDq","o9zuXQ","4Aebt","wgjjWwKKx","rY4VIxqSN","kfjbnSo","2DyrFA1M","YUixDM9B","JQvgEj0","mcuFx6JIek","eoTKe26gL","qaI9EVO1rB","0xl33btZL","1fszuAU","a7jnHzst6P","wQuJkX","cBNhTJlEOf","KNcFWhDvgT","XipDGjST","PCZJlbHoyt","2AYnMZkqd","HIpJh","KH0C3iztrG","W81hjts92","rJhAT","NON7LKoMQ","NMdY3nsKzI","t4En5v","Qq5cOQ9H","Y9nwrp","VX5FYVfsf","cE5SJG","x1vj1","HegbLe","zJ3nmt4OA","gt7rxW57dq","clIE9b","jyJ9g","B5jXjMCSx","cOzZBZTV","FTXGy","Dfh1q1","ny9jqZ2POI","X2NnMn","MBtoyD","qz4Ilys7wB","68lbOMye","3YUJnmxp","1fv5Imona","PlfvvXD7mA","ZarKfHCaPR","owORnX","dQP1YU","dVdkx","qgiK0E","cx9wQ","5F9bGa","7UjkKrp","Yvhrj","wYXez5Dg3","pG4GMU","MwMAu","rFRD5wlM"];
const secretKey = function(e){if(void 0===e)return"rive";try{let t,n;let r=String(e);if(isNaN(Number(e))){let e=r.split("").reduce((e,t)=>e+t.charCodeAt(0),0);t=c[e%c.length]||btoa(r),n=Math.floor(e%r.length/2)}else{let i=Number(e);t=c[i%c.length]||btoa(r),n=Math.floor(i%r.length/2)}let i=r.slice(0,n)+t+r.slice(n),a=function(e){let t=String(e),n=3735928559^t.length;for(let e=0;e<t.length;e++){let r=t.charCodeAt(e);r^=(131*e+89^r<<e%5)&255,n=(n<<7|n>>>25)>>>0^r;let i=(65535&n)*60205,a=(n>>>16)*60205<<16;n=i+a>>>0,n^=n>>>11}return n^=n>>>15,n=(65535&n)*49842+((n>>>16)*49842<<16)>>>0,n^=n>>>13,n=(65535&n)*40503+((n>>>16)*40503<<16)>>>0,n^=n>>>16,n=(65535&n)*10196+((n>>>16)*10196<<16)>>>0,(n^=n>>>15).toString(16).padStart(8,"0")}(function(e){e=String(e);let t=0;for(let n=0;n<e.length;n++){let r=e.charCodeAt(n),i=((t=r+(t<<6)+(t<<16)-t>>>0)<<n%5|t>>>32-n%5)>>>0;t^=(i^(r<<n%7|r>>>8-n%7))>>>0,t=t+(t>>>11^t<<3)>>>0}return t^=t>>>15,t=(65535&t)*49842+(((t>>>16)*49842&65535)<<16)>>>0,t^=t>>>13,t=(65535&t)*40503+(((t>>>16)*40503&65535)<<16)>>>0,(t^=t>>>16).toString(16).padStart(8,"0")}(i));return btoa(a)}catch(e){return"topSecret"}};
export const riveSecretKey = (id) => secretKey(id);

export function riveUrl(q, server, now = Date.now) {
  if (!q?.tmdbId) throw new Error("rivestream: needs a TMDB id");
  const cb = server === "primevids" || server === "citadel" ? `&cb=${Math.floor(now() / 3e6)}` : "";
  const base = `${RIVE_ORIGIN}/api/backendfetch`;
  const path =
    q.type === "tv"
      ? `?requestID=tvVideoProvider&id=${q.tmdbId}&season=${q.season ?? 1}&episode=${q.episode ?? 1}&service=${server}`
      : `?requestID=movieVideoProvider&id=${q.tmdbId}&service=${server}`;
  return `${base}${path}${cb}&secretKey=${riveSecretKey(String(q.tmdbId))}&proxyMode=undefined`;
}

/**
 * Resolve one title/episode on one Rivestream server.
 * @param {(url: string, headers: object) => Promise<string>} http GET -> body text (throws on HTTP errors)
 * @returns {Promise<{ ok: true, source: string, server: string, quality: string }>}
 */
export async function resolveRive(http, q, server, { now = Date.now } = {}) {
  const cfg = RIVE_SERVERS[server];
  if (!cfg) throw new Error(`rivestream: unknown server ${server}`);
  const body = await http(riveUrl(q, server, now), { "User-Agent": RIVE_UA, Accept: "application/json", Referer: RIVE_ORIGIN + "/" });
  const j = typeof body === "string" ? JSON.parse(body) : body;
  const list = Array.isArray(j?.data?.sources) ? j.data.sources.filter((s) => typeof s?.url === "string" && /^https:\/\//.test(s.url)) : [];
  const hit = list.length ? cfg.pick(list) : null;
  if (!hit) throw new Error(`rivestream ${server}: no source`);
  return { ok: true, source: hit.url.trim(), server, quality: hit.quality || "" };
}
