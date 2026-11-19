// Context the profile gate provides to the app: the active profile and the
// switcher/manager openers. Null outside the gate (desktop build).
import { createContext, useContext } from "react";

export const ProfileContext = createContext(null);

/**
 * Active profile plus the switcher and manager openers, or null when no
 * profile gate is mounted.
 * @returns {{profile: object, openSwitcher: () => void, openManager: () => void} | null}
 */
export const useProfiles = () => useContext(ProfileContext);
