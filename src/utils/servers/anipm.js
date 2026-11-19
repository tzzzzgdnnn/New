// ani.pm anime resolver: AniList id (or a title match) + episode + Sub/Dub ->
// a playable HLS master URL, through ani.pm's own API:
//   1. title:   /api/anime/ani/<anilistId> (exact) or /api/anime/search?q=
//   2. episode: /api/anime/playback-bootstrap/<source>/<id>?ep=&lang=
//               -> settlarSelection, effectiveLanguage, availability {sub,dub}
//   3. session: /api/anime/settlar/session?selection=&provider=anipm&ep=&channel=
//               -> embedUrl (https://embed.settlar.io/embed/v1?t=…)
//   4. stream:  embed.settlar.io/api/embed/session?t=… -> { kind:"hls", source }
// None of these send CORS headers, so the app calls them through a native
// HTTP client (the caller passes `http`). Pure logic, no DOM.

export const ANIPM_ORIGIN = "https://ani.pm";
export const ANIPM_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const HEADERS = { Accept: "application/json", Referer: ANIPM_ORIGIN + "/", "User-Agent": ANIPM_UA };

/** Lowercase, accents and punctuation dropped, spaces collapsed. */
export const normalizeTitle = (s) =>
  String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Best search hit for a title, or null. Exact AniList/MAL id wins outright;
 * otherwise an exact (normalized) title/native match, then year, then type
 * (TV/Movie) and episode count decide.
 * @param {Array<object>} items /api/anime/search items
 * @param {{ title?: string, altTitles?: string[], year?: number, type?: string,
 *           episodes?: number, anilistId?: number, malId?: number }} want
 */
export function matchTitle(items, want = {}) {
  if (!Array.isArray(items) || !items.length) return null;
  const byId = items.find(
    (i) =>
      (want.anilistId && String(i.anilistId) === String(want.anilistId)) ||
      (want.malId && String(i.malId) === String(want.malId)),
  );
  if (byId) return byId;
  const names = [want.title, ...(want.altTitles || [])].map(normalizeTitle).filter(Boolean);
  if (!names.length) return null;
  let best = null;
  let bestScore = 0;
  for (const i of items) {
    const own = [i.title, i.native, ...(Array.isArray(i.providerTitles) ? i.providerTitles : [])]
      .map((t) => normalizeTitle(typeof t === "string" ? t : t?.title))
      .filter(Boolean);
    let s = 0;
    if (own.some((t) => names.includes(t))) s += 100;
    else if (own.some((t) => names.some((n) => t.startsWith(n) || n.startsWith(t)))) s += 30;
    else continue;
    if (want.year && i.year) s += Number(i.year) === Number(want.year) ? 40 : -Math.min(30, Math.abs(i.year - want.year) * 5);
    if (want.type && i.type) s += String(i.type).toLowerCase() === String(want.type).toLowerCase() ? 15 : -15;
    if (want.episodes && i.episodeCount) s += Number(i.episodeCount) === Number(want.episodes) ? 10 : 0;
    if (s > bestScore) {
      best = i;
      bestScore = s;
    }
  }
  return bestScore >= 60 ? best : null;
}

/**
 * Resolve one episode to a playable HLS master.
 * @param {(url: string, headers: object, signal?: AbortSignal) => Promise<any>} http
 *   GET returning parsed JSON (throws on HTTP errors / non-JSON answers)
 * @param {{ anilistId?: number, title?: string, year?: number, type?: string,
 *           episode?: number, lang?: "sub"|"dub" }} q
 * @returns {Promise<{ ok: true, source: string, embedUrl: string, lang: string,
 *   requestedLang: string, availability: {sub:boolean,dub:boolean},
 *   audioLang?: string, subtitles: Array, ms: object }>}
 */
export async function resolveAnipm(http, q, { signal, now = Date.now } = {}) {
  const t0 = now();
  const lang = q.lang === "dub" ? "dub" : "sub";
  const ep = Math.max(1, Number(q.episode) || 1);
  let route = null; // [source, id]
  if (q.anilistId) route = ["anilist", q.anilistId];
  else if (q.title) {
    const hits = await http(`${ANIPM_ORIGIN}/api/anime/search?q=${encodeURIComponent(q.title)}`, HEADERS, signal);
    const hit = matchTitle(hits?.items, q);
    if (!hit) throw new Error(`ani.pm: no match for "${q.title}"`);
    route = hit.anilistId ? ["anilist", hit.anilistId] : [hit.source === "anilist" ? "anilist" : "settlar", hit.id];
  } else throw new Error("ani.pm: needs an AniList id or a title");

  const boot = await http(
    `${ANIPM_ORIGIN}/api/anime/playback-bootstrap/${route[0]}/${encodeURIComponent(route[1])}?ep=${ep}&lang=${lang}`,
    HEADERS,
    signal,
  );
  const t1 = now();
  if (!boot?.settlarSelection) throw new Error("ani.pm: episode not available");
  const effective = boot.effectiveLanguage === "dub" ? "dub" : "sub";
  const params = new URLSearchParams({
    selection: boot.settlarSelection,
    provider: "anipm",
    ep: String(ep),
    channel: effective,
    telemetry: "0",
  });
  const ses = await http(`${ANIPM_ORIGIN}/api/anime/settlar/session?${params}`, HEADERS, signal);
  const t2 = now();
  const embedUrl = ses?.embedUrl;
  if (!embedUrl || !/^https:\/\//.test(embedUrl)) throw new Error("ani.pm: no player session");
  const embed = new URL(embedUrl);
  const token = embed.searchParams.get("t");
  const play = await http(
    `${embed.origin}/api/embed/session?t=${encodeURIComponent(token || "")}`,
    { Accept: "application/json", Referer: embedUrl, "User-Agent": ANIPM_UA },
    signal,
  );
  const t3 = now();
  if (play?.kind !== "hls" || typeof play.source !== "string") throw new Error("ani.pm: no HLS stream");
  const source = new URL(play.source, embed.origin).href;
  return {
    ok: true,
    source,
    embedUrl,
    lang: effective,
    requestedLang: lang,
    availability: { sub: !!boot.availability?.sub, dub: !!boot.availability?.dub },
    audioLang: play.audioLang || null,
    subtitles: Array.isArray(play.subtitles) ? play.subtitles : [],
    expiresAt: Number(play.expiresAt || ses.expiresAt || 0) * 1000 || null,
    ms: { bootstrap: t1 - t0, session: t2 - t1, stream: t3 - t2, total: t3 - t0 },
  };
}
