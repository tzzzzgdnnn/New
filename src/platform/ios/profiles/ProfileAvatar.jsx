// One profile avatar: a built-in gradient with the profile's initial, or a
// TMDB image center-cropped into the same rounded square.
import { avatarImageUrl, gradientBackground, isGradientAvatar } from "./avatars";

/**
 * @param {{avatar: string, name?: string, size?: number, round?: boolean, className?: string, lazy?: boolean, onError?: () => void}} props
 */
export default function ProfileAvatar({ avatar, name = "", size = 96, round = false, className = "", lazy = false, onError }) {
  const url = avatarImageUrl(avatar, size > 120 ? "w342" : "w185");
  const style = {
    width: size,
    height: size,
    borderRadius: round ? "50%" : Math.round(size * 0.14),
    fontSize: Math.round(size * 0.44),
    background: isGradientAvatar(avatar) || !url ? gradientBackground(avatar) : undefined,
  };
  return (
    <span className={`sp-avatar ${className}`} style={style} aria-hidden="true">
      {url ? (
        <img src={url} alt="" draggable="false" decoding="async" loading={lazy ? "lazy" : undefined} onError={onError} />
      ) : <span className="sp-avatar-initial">{name.trim().charAt(0).toUpperCase()}</span>}
    </span>
  );
}
