// Profile pictures in party chat: the profile's avatar string (see
// platform/ios/profiles/avatars.js) made ready for the room and for the
// native players.
import { avatarImageUrl, isGradientAvatar, DEFAULT_AVATARS } from "../platform/ios/profiles/avatars.js";

export const THUMB_PX = 64;

/**
 * The avatar as the room carries it. A photo stored as a data: URL (web
 * profiles) becomes a small JPEG thumbnail so it fits the room's limit;
 * gradient ids, TMDB paths and https art go as they are.
 */
export async function partyAvatar(avatar) {
  if (typeof avatar !== "string" || !avatar) return null;
  if (!avatar.startsWith("data:")) return avatar;
  try {
    const img = new Image();
    img.src = avatar;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = THUMB_PX;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    c.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, THUMB_PX, THUMB_PX);
    for (const q of [0.7, 0.5, 0.35]) {
      const out = c.toDataURL("image/jpeg", q);
      if (out.length <= 7800) return out;
    }
  } catch {}
  return null;
}

/** For the native players: an image URL, or the gradient's two colours, plus the initial. */
export function nativeAvatar(avatar, name) {
  const g = DEFAULT_AVATARS.find((a) => a.id === avatar) || DEFAULT_AVATARS[hash(name) % DEFAULT_AVATARS.length];
  const url = isGradientAvatar(avatar) ? null : avatarImageUrl(avatar, "w92");
  return { avatarUrl: url || "", avatarFrom: g.from, avatarTo: g.to, initial: String(name || "?").trim().charAt(0).toUpperCase() || "?" };
}

/** Gradient avatar id for someone with no picture (stable per name). */
export const fallbackAvatar = (name) => DEFAULT_AVATARS[hash(name) % DEFAULT_AVATARS.length].id;

function hash(s) {
  let h = 0;
  for (const ch of String(s || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}
