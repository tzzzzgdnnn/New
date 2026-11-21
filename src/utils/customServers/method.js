// Site adder: which technique found a server's stream, in words the Test
// shows ("HLS (m3u8) · sniffed from the embedded player on vidplay.site,
// after pressing “Server 2”"). Pure functions, shared by the page Test
// (native sniffer result) and the whole-site adder (collector.js render).
import { siteDomain } from "./template";

/** How a stream was seen, by the collector's / site.js `how`. */
export const HOW_LABELS = Object.freeze({
  request: "sniffed the page's stream request",
  manifest: "sniffed the playlist the page loaded",
  element: "read from the page's video player",
  api: "found in the site's API answer",
  decoded: "found in the page's scripts",
  direct: "the site's API (Direct mode)",
  tap: "sniffed after pressing play",
});

/** "HLS (m3u8)" / "MP4" / "WebM" for a stream kind or url. */
export function kindLabel(kind, url = "") {
  const k = String(kind || "").toLowerCase() || (/\.mp4(\?|#|$)/i.test(url) ? "mp4" : /\.webm(\?|#|$)/i.test(url) ? "webm" : "hls");
  return k === "mp4" ? "MP4" : k === "webm" ? "WebM" : k === "m4v" ? "M4V" : "HLS (m3u8)";
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/**
 * The method behind one stream.
 * @param {{ kind?, url?, how?, streamPage?, pageUrl?, site?, taps?: string[], direct?: boolean }} s
 * @returns {{ id: string, label: string, host: string|null, tap: string|null }}
 *   id: "direct" | "embed" | "tap" | "page" | one of HOW_LABELS' keys
 */
export function methodOf({ kind = null, url = "", how = null, streamPage = null, pageUrl = null, site = null, taps = [], direct = false } = {}) {
  const k = kindLabel(kind, url);
  if (direct || how === "direct") return { id: "direct", label: `${k} · ${HOW_LABELS.direct}`, host: null, tap: null };
  const siteDom = site ? siteDomain(/^https?:/i.test(site) ? site : `https://${site}`) : pageUrl ? siteDomain(pageUrl) : null;
  const frameHost = streamPage ? hostOf(streamPage) : "";
  const embedded = !!(frameHost && siteDom && siteDomain(`https://${frameHost}`) !== siteDom);
  const tap = (taps || []).filter(Boolean).slice(-1)[0] || null;
  const known = how && how !== "request" && HOW_LABELS[how];
  const where = embedded ? `followed the embedded player on ${frameHost}` : known ? HOW_LABELS[how] : "sniffed from the site's own player";
  const label = `${k} · ${where}${tap ? `, after pressing “${String(tap).slice(0, 40)}”` : ""}`;
  const id = embedded ? "embed" : tap ? "tap" : how && HOW_LABELS[how] ? how : "page";
  return { id, label, host: embedded ? frameHost : null, tap };
}

/** The method of a native page try (`nativeTry` result) for a link. */
export function methodOfTry(r, { link = null, site = null } = {}) {
  const st = r?.stream;
  if (!st?.ok) return null;
  return methodOf({
    kind: st.kind,
    url: st.url,
    how: st.how || null,
    streamPage: st.page || null,
    pageUrl: r?.page?.url || link,
    site,
    taps: r?.page?.taps || [],
    direct: !!st.direct,
  });
}
