// Build target flag. "ios" only for `vite build --mode ios` (see .env.ios);
// a compile-time constant, so desktop builds tree-shake every iOS branch.
//
// The web/PWA build (`vite build --mode web`, see .env.web) reuses the phone
// UI, so IS_IOS is also true there ("phone UI build"); IS_WEB tells the
// browser build apart from the Capacitor IPA. Both are constants, so the iOS
// and desktop bundles compile exactly as before.
export const IS_WEB = import.meta.env.VITE_TARGET === "web";
export const IS_IOS = import.meta.env.VITE_TARGET === "ios" || IS_WEB;

// Display name of the iOS build.
export const IOS_APP_NAME = "Super Player";
