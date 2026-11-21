// Best-quality rule (every title, every platform): among the streams a title
// has, play the one with the highest picture, and start on its top rendition
// instead of climbing up from the lowest one.
//
//  parseHlsVariants(text, base)  variants of an HLS master playlist
//  streamMaxHeight(text)         tallest rendition in a playlist (0 = unknown / media playlist)
//  rankByQuality(list)           candidates best first: height, then bitrate; unknown last, order kept
//  topLevelIndex(levels)         hls.js level to start on: the tallest, then the highest bitrate

const attr = (line, name) => {
  const m = new RegExp(`(?:^|,)${name}=("[^"]*"|[^,]*)`).exec(line);
  return m ? m[1].replace(/^"|"$/g, "") : null;
};

/** Variants of an HLS master playlist: [{ url, width, height, bandwidth }]. */
export function parseHlsVariants(text, base = "") {
  const out = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.startsWith("#EXT-X-STREAM-INF:")) continue;
    const a = l.slice("#EXT-X-STREAM-INF:".length);
    const res = attr(a, "RESOLUTION");
    const [w, h] = res ? res.split("x").map(Number) : [0, 0];
    const bandwidth = Number(attr(a, "AVERAGE-BANDWIDTH") || attr(a, "BANDWIDTH")) || 0;
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith("#"))) j++;
    const uri = lines[j]?.trim();
    if (!uri) continue;
    let url = uri;
    try { url = base ? new URL(uri, base).href : uri; } catch {}
    out.push({ url, width: w || 0, height: h || 0, bandwidth });
  }
  return out;
}

/** Tallest rendition a playlist offers (0 when it lists none, e.g. a media playlist). */
export function streamMaxHeight(text) {
  return parseHlsVariants(text).reduce((m, v) => Math.max(m, v.height), 0);
}

const better = (a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0);

/** Variants best first (tallest, then highest bitrate). */
export const sortVariants = (variants) => [...(variants || [])].sort(better);

/**
 * Candidates best first. Each may carry `height` (tallest rendition) and
 * `bandwidth`; ones with no known height keep their order after the known ones.
 */
export function rankByQuality(list) {
  const known = [], unknown = [];
  (list || []).forEach((c, i) => ((c?.height > 0 ? known : unknown).push({ c, i })));
  known.sort((x, y) => better(x.c, y.c) || x.i - y.i);
  return [...known, ...unknown].map((x) => x.c);
}

/** hls.js level to start on: the tallest rendition, then its highest bitrate. -1 if none. */
export function topLevelIndex(levels) {
  let best = -1;
  (levels || []).forEach((l, i) => {
    if (!l) return;
    const cur = { height: l.height || 0, bandwidth: l.bitrate || l.bandwidth || 0 };
    const b = best < 0 ? null : { height: levels[best].height || 0, bandwidth: levels[best].bitrate || levels[best].bandwidth || 0 };
    if (!b || better(cur, b) < 0) best = i;
  });
  return best;
}
