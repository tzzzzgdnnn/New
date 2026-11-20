// Build target flag. "ios" only for `vite build --mode ios` (see .env.ios);
// a compile-time constant, so desktop builds tree-shake every iOS branch.
export const IS_IOS = import.meta.env.VITE_TARGET === "ios";

// Display name of the iOS build.
export const IOS_APP_NAME = "Super Player";
// Android builds with VITE_WEB=1 but downloads natively (SbDownloadPlugin).
export const CAN_DOWNLOAD = IS_IOS && (!import.meta.env.VITE_WEB || !!import.meta.env.VITE_ANDROID);
