// Page-side glue between the React pages (TVPage / MoviePage) and the iOS
// native player. The pages publish what is playing in window.__sbCtx and
// react to servers picked in the native server menu ("sb-select-server").
import { useEffect, useRef } from "react";
import { IS_IOS } from "../target";
import { storage, STORAGE_KEYS } from "../../utils/storage";
import { PLAYER_SOURCES, sourcesForContent } from "../../utils/api";
import { parseServerKey } from "../../utils/servers/catalog";
import { setServerChoice, ANIPM_CHOICE } from "./autoServer";

export const normalizeDubMode = (mode) => (mode === "dub" ? "dub" : "sub");

/** Saved anime audio preference ("sub" | "dub"). */
export const getAnimeDubMode = () =>
  normalizeDubMode(storage.get(STORAGE_KEYS.HIANIME_DUB_MODE));

/** True once the viewer answered the first-run "Sub or Dub?" prompt. */
export const hasChosenAnimeDubMode = () =>
  !!storage.get(STORAGE_KEYS.ANIME_DUB_CHOSEN);

/** Save the anime audio preference and mark the prompt as answered. */
export function setAnimeDubMode(mode) {
  const m = normalizeDubMode(mode);
  storage.set(STORAGE_KEYS.HIANIME_DUB_MODE, m);
  storage.set(STORAGE_KEYS.ANIME_DUB_CHOSEN, true);
  window.dispatchEvent(new CustomEvent("sb-dub-mode-changed", { detail: m }));
  return m;
}

/** Publish the playing title for the native player (read by webview.js). */
export function publishPlayerContext(ctx) {
  if (!IS_IOS) return;
  window.__sbCtx = ctx;
  // Anime: look the episode up on ani.pm now, so Play starts on it at once.
  // (Dynamic import: keeps ani.pm and the native HTTP client out of desktop.)
  if (ctx?.isAnime && ctx.anilistId) import("./anipm").then((m) => m.prefetchAnipm(ctx)).catch(() => {});
  // Movies and series: Movy's stream API, resolved now so Play is instant.
  if (!import.meta.env.VITE_WEB && ctx && !ctx.isAnime && ctx.tmdbId) import("./movy").then((m) => m.prefetchMovy(ctx)).catch(() => {});
  if (ctx && !ctx.isAnime && ctx.tmdbId) import("./cinejoy").then((m) => m.prefetchCinejoy(ctx)).catch(() => {});
  // Measure the title's servers now (player Auto ranking), not on Play.
  import("./webview").then((m) => m.prefetchTitle(ctx)).catch(() => {});
}

/**
 * Listen for a server picked in the native player. Ids may carry the anime
 * audio mode ("vidnest:dub"); the handler gets `{ sourceId, dubMode }` with
 * dubMode null for plain ids. Unknown ids are ignored. A pick by hand turns
 * Auto off, so that server leads until the viewer chooses Auto again. The
 * handler is kept in a ref, so callers never see stale state.
 */
export function useNativeServerSelect(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!IS_IOS) return;
    const onSelect = (e) => {
      const raw = typeof e?.detail === "string" ? e.detail : null;
      if (!raw) return;
      const { sourceId, mode } = parseServerKey(raw);
      if (sourceId === ANIPM_CHOICE) {
        // ani.pm is not a page source: pin it, keep the page's own server.
        setServerChoice(ANIPM_CHOICE);
        ref.current?.({ sourceId: null, dubMode: mode });
        return;
      }
      if (!PLAYER_SOURCES.some((s) => s.id === sourceId)) return;
      setServerChoice(sourceId);
      ref.current?.({ sourceId, dubMode: mode });
    };
    window.addEventListener("sb-select-server", onSelect);
    return () => window.removeEventListener("sb-select-server", onSelect);
  }, []);
}

/**
 * Anime titles on iOS always play on an anime-capable server. When the title
 * opens in Dub mode, or the viewer switches to Dub, start on the dedicated
 * anime route (AniList id + dub) since it carries real English audio; a server
 * picked by hand afterwards is kept.
 */
export function useAnimeServerGuard({ isAnime, playerSource, dubMode, setPlayerSource }) {
  const dubAppliedRef = useRef(null);
  useEffect(() => {
    if (!IS_IOS || !isAnime) return;
    const usable = sourcesForContent(true).filter((s) => !s.async);
    if (!usable.length) return;
    const animeRoute = usable.find((s) => s.animeUrl);
    const enteredDub = dubMode === "dub" && dubAppliedRef.current !== "dub";
    dubAppliedRef.current = dubMode;
    if (enteredDub && animeRoute && playerSource !== animeRoute.id) {
      setPlayerSource(animeRoute.id);
    } else if (!usable.some((s) => s.id === playerSource)) {
      setPlayerSource((animeRoute || usable[0]).id);
    }
  }, [isAnime, playerSource, dubMode, setPlayerSource]);
}

/**
 * Apply a pick from the server sheet: "auto", "anipm" or a page source id.
 * A page source becomes the page's server (its URL changes, which restarts
 * the native player when playing); Auto / ani.pm / the same server keep the
 * URL, so a play in progress is restarted here.
 */
export function applyServerChoice(choice, { playerSource, setPlayerSource, reset, playing }) {
  const saved = setServerChoice(choice);
  const isSource = PLAYER_SOURCES.some((s) => s.id === saved);
  if (isSource && saved !== playerSource) {
    setPlayerSource(saved);
    reset?.();
    return saved;
  }
  if (playing) window.dispatchEvent(new CustomEvent("sb-replay"));
  return saved;
}
