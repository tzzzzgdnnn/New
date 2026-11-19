// Active-profile state shared by storage, the TMDB client and the age-rating
// helpers. Only the iOS build ever activates a profile; with none active every
// helper here is a no-op, so desktop storage keys are unchanged.

let activeProfile = null; // { id: string, kids: boolean } | null

/**
 * Make a profile the one every per-person read and write goes to.
 * @param {{id: string, kids?: boolean} | null} profile null clears it
 */
export function setActiveProfileScope(profile) {
  activeProfile = profile ? { id: String(profile.id), kids: !!profile.kids } : null;
  // Theme hook: Kids profiles get the sky-blue look (kids.css).
  try {
    const root = typeof document !== "undefined" ? document.documentElement : null;
    if (root) {
      if (activeProfile?.kids) root.setAttribute("data-profile", "kids");
      else root.removeAttribute("data-profile");
    }
  } catch {}
}

/** Id of the active profile, or null when none is active (desktop). */
export const getActiveProfileId = () => activeProfile?.id ?? null;

/** True while a Kids profile is active. */
export const isKidsProfileActive = () => !!activeProfile?.kids;

/** Storage-key namespace of one profile ("p.<id>."). */
export const profileNamespace = (profileId) => `p.${profileId}.`;

/**
 * Key a per-person value is stored under for a given profile.
 * @param {string} profileId
 * @param {string} key logical key, e.g. "history"
 */
export const scopedKey = (profileId, key) => profileNamespace(profileId) + key;
