// Per-profile settings of the native player (quality, subtitles) and its
// "Up Next" card. Only talks to the native player UI: nothing here picks,
// resolves or switches streams.
import { storage, STORAGE_KEYS } from "../../utils/storage";
import { SUBTITLE_LANGUAGES } from "../../utils/subtitles";

const handler = (name) => window.webkit?.messageHandlers?.[name];

/** Send the active profile's player settings to the native player. */
export function syncPlayerPrefs() {
  const h = handler("sbPrefs");
  if (!h) return;
  try {
    h.postMessage({
      quality: Number(storage.get(STORAGE_KEYS.PLAYER_QUALITY) ?? 0) || 0,
      subsOn: storage.get(STORAGE_KEYS.PLAYER_SUBS_ON) ?? undefined,
      subScale: storage.get(STORAGE_KEYS.PLAYER_SUB_SCALE) ?? undefined,
      subLang: storage.get(STORAGE_KEYS.SUBTITLE_LANG) || "en",
    });
  } catch (e) {
    console.warn("[native] sbPrefs failed", e);
  }
}

const langCode = (lang) => {
  const l = String(lang || "").toLowerCase();
  const hit = SUBTITLE_LANGUAGES.find((x) => x.code.toLowerCase().split("-")[0] === l);
  return hit ? hit.code : l;
};

// Native player -> page: a setting changed, save it on the active profile.
window.__sbPlayerPref = ({ key, value } = {}) => {
  switch (key) {
    case "quality":
      storage.set(STORAGE_KEYS.PLAYER_QUALITY, Number(value) || 0);
      break;
    case "subsOn":
      storage.set(STORAGE_KEYS.PLAYER_SUBS_ON, !!value);
      break;
    case "subScale":
      storage.set(STORAGE_KEYS.PLAYER_SUB_SCALE, Number(value) || 1);
      break;
    case "subLang":
      if (value) storage.set(STORAGE_KEYS.SUBTITLE_LANG, langCode(value));
      break;
    default:
  }
};

/**
 * Offer (or withdraw, with null) the Up Next episode for the playing one.
 * @param {null | {progressKey: string, title: string, subtitle?: string, thumb?: string, countdown: number}} info
 */
export function postUpNext(info) {
  const h = handler("sbUpNext");
  if (!h) return;
  try {
    h.postMessage(info ? info : { clear: true });
  } catch (e) {
    console.warn("[native] sbUpNext failed", e);
  }
}

// Native player -> page: Up Next was accepted (the player already closed).
window.__sbUpNextPlay = () => window.dispatchEvent(new CustomEvent("sb-up-next-play"));
