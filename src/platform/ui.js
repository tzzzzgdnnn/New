// Platform-split UI. IS_IOS is a build-time constant, so each ternary folds
// and the unused side (module and chunk) is dropped from that build: the
// phone bundle carries no desktop chrome, and desktop carries no iOS UI.
import { lazy } from "react";
import { IS_IOS } from "./target";
import DesktopWindowTitlebar from "../components/WindowTitlebar";

// Desktop only (null on iOS).
export const WindowTitlebar = IS_IOS ? null : DesktopWindowTitlebar;
export const KeyboardShortcutsModal = IS_IOS
  ? null
  : lazy(() => import("../components/KeyboardShortcutsModal"));
export const CloseConfirmModal = IS_IOS
  ? null
  : lazy(() => import("../components/CloseConfirmModal"));
export const UpdateModal = IS_IOS
  ? null
  : lazy(() => import("../components/UpdateModal"));

// Per platform.
export const SettingsPage = IS_IOS
  ? lazy(() => import("./ios/settings/IOSSettings"))
  : lazy(() => import("../pages/SettingsPage"));
