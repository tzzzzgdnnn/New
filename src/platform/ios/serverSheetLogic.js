// Pure logic of the iOS server sheet (ServerSheet.jsx; not "serverSheet.js": that clashes on case-insensitive file systems): the rows it lists and
// when a drag on it dismisses it. No DOM here, so Node tests can run it.
import { AUTO_SERVER, ANIPM_CHOICE } from "./autoServer";

/** Drag past this many px, or flick faster than DISMISS_VELOCITY, to close. */
export const DISMISS_DISTANCE = 96;
export const DISMISS_VELOCITY = 0.6; // px per ms

/**
 * Rows of the sheet: "Auto" first, then every manual server for this kind of
 * content (TV drops movie-only servers). Exactly one row is selected: the
 * saved choice, or Auto when that server is no longer listed.
 * @param {{ sources: Array<{id:string,label?:string,tag?:string,note?:string,movieOnly?:boolean}>,
 *           choice?: string, type?: "movie"|"tv" }} opts
 */
export function serverSheetRows({ sources = [], choice = AUTO_SERVER, type = "movie", anime = false } = {}) {
  const lead = anime ? [{ id: ANIPM_CHOICE, label: "ani.pm", detail: "Main anime server", auto: false }] : [];
  const servers = lead.concat(sources
    .filter((s) => s && s.id && !(type === "tv" && s.movieOnly))
    .map((s) => ({
      id: s.id,
      label: s.label || s.id,
      detail: [s.tag, s.note].filter(Boolean).join(" · ") || null,
      auto: false,
    })));
  const picked = servers.some((s) => s.id === choice) ? choice : AUTO_SERVER;
  return [
    {
      id: AUTO_SERVER,
      label: "Auto",
      detail: anime
        ? "ani.pm first, then the fastest server measured now"
        : "Fastest server measured now; switches if one fails",
      auto: true,
    },
    ...servers,
  ].map((r) => ({ ...r, selected: r.id === picked }));
}

/** Label for the page's source button: "Auto" or the picked server's name. */
export function serverChoiceLabel(choice, sources = []) {
  if (!choice || choice === AUTO_SERVER) return "Auto";
  if (choice === ANIPM_CHOICE) return "ani.pm";
  return sources.find((s) => s.id === choice)?.label || "Auto";
}

/**
 * Whether a downward drag of `dy` px over `ms` ms closes the sheet: far
 * enough, or a quick flick. Upward drags never close it.
 */
export function shouldDismissDrag(dy, ms) {
  if (!(dy > 0)) return false;
  if (dy >= DISMISS_DISTANCE) return true;
  return dy >= 24 && ms > 0 && dy / ms >= DISMISS_VELOCITY;
}

/**
 * Sub/Dub control state for anime: Dub is disabled when ani.pm reported that
 * this episode has no dub (`availability.dub === false`); unknown keeps it on.
 */
export function dubControl(mode, availability) {
  const noDub = availability ? availability.dub === false : false;
  return { mode: mode === "dub" && !noDub ? "dub" : "sub", dubDisabled: noDub, wanted: mode === "dub" ? "dub" : "sub" };
}
