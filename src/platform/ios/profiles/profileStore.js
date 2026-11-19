// On-device profile list: up to MAX_PROFILES people, each with a name, an
// avatar, a Kids flag and an optional 4-digit PIN. Per-person data lives
// under each profile's storage namespace (see profileKey in utils/storage).
import {
  storage,
  STORAGE_PREFIX,
  NATIVE_MIRRORED_KEYS,
  isProfileScoped,
} from "../../../utils/storage";
import { profileNamespace, scopedKey, setActiveProfileScope } from "../../../utils/profileScope";
import { defaultAvatarFor } from "./avatars";

/** Most profiles one device can hold. */
export const MAX_PROFILES = 5;
/** Longest profile name. */
export const MAX_NAME_LENGTH = 20;
/** PIN length (digits). */
export const PIN_LENGTH = 4;

// Global (unscoped) keys holding the profile list and the last one used.
const PROFILES_KEY = "profiles";
const LAST_PROFILE_KEY = "lastProfileId";
const FIRST_PROFILE_NAME = "Main";

const PIN_PATTERN = new RegExp(`^\\d{${PIN_LENGTH}}$`);

/** True for a well-formed PIN ("0420"). */
export const isValidPin = (pin) => typeof pin === "string" && PIN_PATTERN.test(pin);

function newProfileId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalize(p, index) {
  return {
    id: String(p.id),
    name: String(p.name || "").trim().slice(0, MAX_NAME_LENGTH) || `Profile ${index + 1}`,
    avatar: typeof p.avatar === "string" && p.avatar ? p.avatar : defaultAvatarFor(index),
    kids: !!p.kids,
    // A PIN is a lock against other people in the household, not a secret
    // that leaves the device, so it is kept as typed.
    pin: isValidPin(p.pin) ? p.pin : null,
  };
}

/** All profiles, in display order. */
export function listProfiles() {
  const raw = storage.get(PROFILES_KEY);
  return Array.isArray(raw) ? raw.filter((p) => p?.id).map(normalize) : [];
}

const saveProfiles = (profiles) => storage.set(PROFILES_KEY, profiles.map(normalize));

/** Id of the profile used last, or null. */
export const getLastProfileId = () => storage.get(LAST_PROFILE_KEY);

/**
 * Move per-person data written before profiles existed into a profile.
 * Mirrors for the native player keep their global copy.
 */
function adoptLegacyData(profileId) {
  for (const physical of Object.keys(localStorage)) {
    if (!physical.startsWith(STORAGE_PREFIX)) continue;
    const key = physical.slice(STORAGE_PREFIX.length);
    if (!isProfileScoped(key)) continue;
    localStorage.setItem(STORAGE_PREFIX + scopedKey(profileId, key), localStorage.getItem(physical));
    if (!NATIVE_MIRRORED_KEYS.has(key)) localStorage.removeItem(physical);
  }
}

/**
 * Profiles, creating "Main" on first run and moving existing history, lists,
 * progress and settings into it. Safe to call on every launch.
 */
export function ensureProfiles() {
  const existing = listProfiles();
  if (existing.length) return existing;
  const main = normalize({ id: newProfileId(), name: FIRST_PROFILE_NAME }, 0);
  adoptLegacyData(main.id);
  saveProfiles([main]);
  return [main];
}

/**
 * Add a profile. Throws when the device already has MAX_PROFILES.
 * @param {{name: string, avatar?: string, kids?: boolean, pin?: string|null}} fields
 * @returns {object} the new profile
 */
export function createProfile(fields) {
  const profiles = listProfiles();
  if (profiles.length >= MAX_PROFILES) throw new Error(`At most ${MAX_PROFILES} profiles`);
  const profile = normalize({ ...fields, id: newProfileId() }, profiles.length);
  saveProfiles([...profiles, profile]);
  return profile;
}

/**
 * Change a profile's name, avatar, Kids flag or PIN.
 * @returns {object} the updated profile
 */
export function updateProfile(id, changes) {
  const profiles = listProfiles();
  const index = profiles.findIndex((p) => p.id === id);
  if (index < 0) throw new Error(`Unknown profile ${id}`);
  const updated = normalize({ ...profiles[index], ...changes, id }, index);
  profiles[index] = updated;
  saveProfiles(profiles);
  return updated;
}

/**
 * Delete a profile and everything stored for it. The last profile can't go.
 */
export function deleteProfile(id) {
  const profiles = listProfiles();
  if (profiles.length <= 1) throw new Error("The last profile can't be deleted");
  const ns = STORAGE_PREFIX + profileNamespace(id);
  Object.keys(localStorage)
    .filter((k) => k.startsWith(ns))
    .forEach((k) => localStorage.removeItem(k));
  saveProfiles(profiles.filter((p) => p.id !== id));
  if (getLastProfileId() === id) storage.remove(LAST_PROFILE_KEY);
}

/**
 * Route every per-person read/write to this profile and refresh the global
 * copies the native player reads.
 */
export function activateProfile(profile) {
  setActiveProfileScope(profile);
  storage.set(LAST_PROFILE_KEY, profile.id);
  for (const key of NATIVE_MIRRORED_KEYS) {
    const own = localStorage.getItem(STORAGE_PREFIX + scopedKey(profile.id, key));
    if (own === null) localStorage.removeItem(STORAGE_PREFIX + key);
    else localStorage.setItem(STORAGE_PREFIX + key, own);
  }
}
