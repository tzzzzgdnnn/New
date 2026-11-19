// Branded launch: a black screen with the app icon fading and scaling in,
// shown from first paint for SPLASH_MS while the app boots. Pure DOM so it
// paints before React; native storyboards are untouched.

/** How long the splash stays fully visible. */
export const SPLASH_MS = 350;
/** Fade-out length after SPLASH_MS (matches .sp-splash transition). */
const SPLASH_FADE_MS = 280;
const ICON_SRC = "./sp-icon.png";

/**
 * Show the launch splash. Returns a function that hides it; it also hides
 * itself once SPLASH_MS has passed and the page has a frame to reveal.
 * @returns {() => void}
 */
export function showLaunchSplash() {
  const el = document.createElement("div");
  el.className = "sp-splash";
  el.setAttribute("aria-hidden", "true");
  const icon = document.createElement("img");
  icon.className = "sp-splash-icon";
  icon.src = ICON_SRC;
  icon.alt = "";
  el.appendChild(icon);
  document.body.appendChild(el);

  let hidden = false;
  const hide = () => {
    if (hidden) return;
    hidden = true;
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), SPLASH_FADE_MS);
  };
  setTimeout(() => requestAnimationFrame(hide), SPLASH_MS);
  return hide;
}
