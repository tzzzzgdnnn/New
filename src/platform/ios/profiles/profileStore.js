// On-device profile list: up to MAX_PROFILES people, each with a name, an
// avatar, a Kids flag and an optional 4-digit PIN. Per-person data lives
// under each profile's storage namespace (see profileKey in utils/storage).
import {
  storage,
  rawStored,
  secureStorage,
  STORAGE_PREFIX,
  NATIVE_MIRRORED_KEYS,
  isProfileScoped,
} from "../../../utils/storage";
import {
  getActiveProfileId,
  profileNamespace,
  scopedKey,
  setActiveProfileScope,
} from "../../../utils/profileScope";
import { defaultAvatarFor } from "./avatars";
import { diag } from "../../../utils/diag";

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

/**
 * A PIN as the 4-digit string it was typed as, or null. Older saves (and
 * hand-restored data) can hold it as a number, which loses leading zeros
 * (0420 -> 420) and used to be dropped as invalid on load, silently
 * removing the lock. Numbers are padded back; strings are trimmed.
 */
export function normalizePin(pin) {
  if (typeof pin === "number" && Number.isInteger(pin) && pin >= 0) pin = String(pin).padStart(PIN_LENGTH, "0");
  if (typeof pin !== "string") return null;
  const t = pin.trim();
  return PIN_PATTERN.test(t) ? t : null;
}

/** Constant-shape comparison of a typed PIN with a profile's PIN. */
export const pinMatches = (profile, typed) => {
  const want = normalizePin(profile?.pin);
  return !!want && want === normalizePin(String(typed ?? ""));
};

// Keychain copy of the profile list. WKWebView writes localStorage to disk
// lazily, so a PIN set just before the app is closed could vanish; the
// Keychain write is durable and is the source of truth for PINs on launch.
const KEYCHAIN_KEY = "profiles";

function newProfileId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// A stored PIN that can't be read back as 4 digits (corrupt or hand-edited
// data) must never hard-lock a profile: it is treated as no PIN, with a warning.
function safePin(p) {
  const raw = p?.pin;
  if (raw == null || raw === "") return null;
  const pin = normalizePin(raw);
  if (!pin) console.warn(`[profiles] Ignoring invalid stored PIN for profile ${p.id}; profile is unlocked`);
  return pin;
}

function normalize(p, index) {
  return {
    id: String(p.id),
    name: String(p.name || "").trim().slice(0, MAX_NAME_LENGTH) || `Profile ${index + 1}`,
    avatar: typeof p.avatar === "string" && p.avatar ? p.avatar : defaultAvatarFor(index),
    kids: !!p.kids,
    // A PIN is a lock against other people in the household, not a secret
    // that leaves the device, so it is kept as typed.
    pin: safePin(p),
  };
}

/** All profiles, in display order. */
export function listProfiles() {
  const raw = storage.get(PROFILES_KEY);
  return Array.isArray(raw) ? raw.filter((p) => p?.id).map(normalize) : [];
}

/**
 * Save the list to localStorage and the Keychain. Resolves once the Keychain
 * copy is written; callers await it before treating a change as saved.
 */
function saveProfiles(profiles) {
  const list = profiles.map(normalize);
  storage.set(PROFILES_KEY, list);
  return secureStorage.set(KEYCHAIN_KEY, JSON.stringify(list)).catch((err) => {
    console.warn("[profiles] Keychain save failed", err);
  });
}

async function readKeychainProfiles() {
  try {
    const raw = await secureStorage.get(KEYCHAIN_KEY);
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? list.filter((p) => p?.id).map(normalize) : null;
  } catch (err) {
    console.warn("[profiles] Keychain read failed", err);
    return null;
  }
}

/**
 * Profiles for launch: the local list reconciled with the Keychain copy.
 * A local list that was lost (or never flushed) is restored from the
 * Keychain; otherwise each profile takes its PIN from the Keychain copy.
 * Always resolves with at least one profile.
 */
export async function loadProfiles() {
  let local = listProfiles();
  const saved = await readKeychainProfiles();
  // A stored list that can't be read is never silently replaced by a fresh
  // "Main" (that would orphan every profile's data): it is backed up and
  // logged, and the Keychain copy is used when there is one.
  const raw = rawStored(PROFILES_KEY);
  if (!local.length && raw && raw !== "[]") {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}profiles_corrupt_${Date.now()}`, raw);
    } catch {}
    diag("profile", `stored profile list unreadable (${raw.length} chars); ${saved?.length ? "restored from Keychain" : "no Keychain copy"}`);
    try {
      window.dispatchEvent(new CustomEvent("sb-storage-error", { detail: { kind: "profiles-corrupt", key: PROFILES_KEY } }));
    } catch {}
    if (!saved?.length) {
      // Rebuild entries from the per-profile data namespaces still on disk.
      const ids = new Set();
      const ns = new RegExp(`^${STORAGE_PREFIX}p\\.([0-9a-f]+)\\.`);
      for (const k of Object.keys(localStorage)) {
        const m = k.match(ns);
        if (m) ids.add(m[1]);
      }
      local = [...ids].map((id, i) => normalize({ id, name: `Profile ${i + 1}` }, i));
      if (local.length) {
        diag("profile", `rebuilt ${local.length} profile(s) from their stored data`);
        storage.set(PROFILES_KEY, local);
        await saveProfiles(local);
        return local;
      }
    }
  }
  if (!local.length && saved?.length) {
    storage.set(PROFILES_KEY, saved);
    return saved;
  }
  if (!local.length) {
    const created = ensureProfiles();
    await saveProfiles(created);
    return created;
  }
  if (!saved) {
    await saveProfiles(local); // first launch with the Keychain copy
    return local;
  }
  const pins = new Map(saved.map((p) => [p.id, p.pin]));
  const merged = local.map((p) => (pins.has(p.id) ? { ...p, pin: pins.get(p.id) } : p));
  if (merged.some((p, i) => p.pin !== local[i].pin)) storage.set(PROFILES_KEY, merged);
  return merged;
}

/** Id of the profile used last, or null. */
export const getLastProfileId = () => storage.get(LAST_PROFILE_KEY);

/**
 * The profile to open at launch instead of the picker, or null for the picker.
 * A reload in this session (`sessionId`) or a recovery reload goes straight
 * back in. After an app restart the last profile used opens again; a locked
 * one asks for its PIN first (`needsPin`).
 * @param {object[]} profiles
 * @param {{sessionId: string|null, recovery: boolean}} launch
 * @returns {{profile: object, needsPin: boolean} | null}
 */
export function profileToResume(profiles, { sessionId, recovery }) {
  const byId = (id) => (id && profiles.find((p) => p.id === id)) || null;
  const current = byId(sessionId);
  if (current) return { profile: current, needsPin: false };
  const last = byId(getLastProfileId());
  if (!last) return null;
  return { profile: last, needsPin: !!last.pin && !recovery };
}

/**
 * Move per-person data written before profiles existed into a profile.
 * Mirrors for the native player keep their global copy.
 */
function adoptLegacyData(profileId) {
  for (const physical of Object.keys(localStorage)) {
    if (!physical.startsWith(STORAGE_PREFIX)) continue;
    const key = physical.slice(STORAGE_PREFIX.length);
    if (!isProfileScoped(key)) continue;
    try {
      localStorage.setItem(STORAGE_PREFIX + scopedKey(profileId, key), localStorage.getItem(physical));
    } catch (e) {
      // Keep the legacy copy when the move failed; never delete unmoved data.
      diag("profile", `legacy migration of ${key} failed: ${e?.name || e}`);
      continue;
    }
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
  storage.set(PROFILES_KEY, [main]);
  return [main];
}

/**
 * Add a profile. Throws when the device already has MAX_PROFILES.
 * @param {{name: string, avatar?: string, kids?: boolean, pin?: string|null}} fields
 * @returns {Promise<object>} the new profile, once saved
 */
export async function createProfile(fields) {
  const profiles = listProfiles();
  if (profiles.length >= MAX_PROFILES) throw new Error(`At most ${MAX_PROFILES} profiles`);
  const profile = normalize({ ...fields, id: newProfileId() }, profiles.length);
  await saveProfiles([...profiles, profile]);
  return profile;
}

/**
 * Change a profile's name, avatar, Kids flag or PIN.
 * Only the given fields change; the rest (the PIN included) are kept.
 * @returns {Promise<object>} the updated profile, once saved
 */
export async function updateProfile(id, changes) {
  const profiles = listProfiles();
  const index = profiles.findIndex((p) => p.id === id);
  if (index < 0) throw new Error(`Unknown profile ${id}`);
  const updated = normalize({ ...profiles[index], ...changes, id }, index);
  profiles[index] = updated;
  await saveProfiles(profiles);
  return updated;
}

/**
 * Delete a profile and everything stored for it. The last profile can't go.
 * Deleting the active profile also ends its storage scope, so a late write
 * can't recreate its data under a profile that no longer exists.
 */
export async function deleteProfile(id) {
  const profiles = listProfiles();
  if (profiles.length <= 1) throw new Error("The last profile can't be deleted");
  if (getActiveProfileId() === id) setActiveProfileScope(null);
  const ns = STORAGE_PREFIX + profileNamespace(id);
  Object.keys(localStorage)
    .filter((k) => k.startsWith(ns))
    .forEach((k) => localStorage.removeItem(k));
  if (getLastProfileId() === id) storage.remove(LAST_PROFILE_KEY);
  await saveProfiles(profiles.filter((p) => p.id !== id));
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
