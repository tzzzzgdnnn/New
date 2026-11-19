// Profile avatars. A profile stores one string: either a built-in gradient id
// ("sp:<name>") or a TMDB image path ("/abc123.jpg") resolved through imgUrl.
import { imgUrl } from "../../../utils/api";

const GRADIENT_PREFIX = "sp:";

/** Built-in gradient avatars, offered first and used for new profiles. */
export const DEFAULT_AVATARS = [
  { id: "sp:ember", from: "#ff3b30", to: "#7a0010" },
  { id: "sp:ocean", from: "#0a84ff", to: "#0b1f6b" },
  { id: "sp:aurora", from: "#30d158", to: "#0a4d5c" },
  { id: "sp:violet", from: "#bf5af2", to: "#3a0a6b" },
  { id: "sp:sunset", from: "#ff9f0a", to: "#c2185b" },
  { id: "sp:ice", from: "#64d2ff", to: "#5e5ce6" },
  { id: "sp:gold", from: "#ffd60a", to: "#a05a00" },
  { id: "sp:graphite", from: "#8e8e93", to: "#1c1c1e" },
];

/** True for a built-in gradient avatar id. */
export const isGradientAvatar = (avatar) =>
  typeof avatar === "string" && avatar.startsWith(GRADIENT_PREFIX);

/**
 * CSS background for a gradient avatar (falls back to the first gradient).
 * @param {string} avatar gradient id
 */
export function gradientBackground(avatar) {
  const g = DEFAULT_AVATARS.find((a) => a.id === avatar) || DEFAULT_AVATARS[0];
  return `radial-gradient(120% 120% at 20% 10%, ${g.from} 0%, ${g.to} 75%)`;
}

/**
 * Image URL of a TMDB avatar path, or null for gradient avatars.
 * @param {string} avatar
 * @param {string} [size] TMDB image size
 */
export const avatarImageUrl = (avatar, size = "w185") => {
  if (isGradientAvatar(avatar) || !avatar) return null;
  // Character art is stored as its full https URL; older avatars as TMDB paths.
  return /^(https:\/\/|data:image\/)/.test(avatar) ? avatar : imgUrl(avatar, size);
};

/** Gradient for the n-th new profile, so new profiles look distinct. */
export const defaultAvatarFor = (index) =>
  DEFAULT_AVATARS[index % DEFAULT_AVATARS.length].id;
