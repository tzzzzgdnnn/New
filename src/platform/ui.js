// Platform-split UI. IS_IOS is a build-time constant, so each ternary folds
// and the unused side (module and chunk) is dropped from that build: the
// phone bundle carries no desktop chrome, and desktop carries no iOS UI.
import { lazy } from "react";
import { IS_IOS } from "./target";
import DesktopWindowTitlebar from "../components/WindowTitlebar";
import Sidebar from "../components/Sidebar";
import TabBar from "./ios/TabBar";
import IOSActionSheet from "./ios/ActionSheet";
import IOSInfoSheet from "./ios/InfoSheet";
import IOSServerSheet from "./ios/ServerSheet";
import { longPressProps } from "./ios/longPress";

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

// App navigation: the desktop sidebar, or the phone's bottom tab bar.
export const Navigation = IS_IOS ? TabBar : Sidebar;

// Secondary actions: right-click + context menu on desktop; long-press +
// action sheet on iOS (ActionSheet is null on desktop).
export const ActionSheet = IS_IOS ? IOSActionSheet : null;

// Read-only text (episode synopsis): a bottom sheet on iOS, null on desktop.
export const InfoSheet = IS_IOS ? IOSInfoSheet : null;

// Server picker: a dropdown on desktop (in the pages); a bottom sheet with
// "Auto" + manual servers on iOS (ServerSheet is null on desktop).
export const ServerSheet = IS_IOS ? IOSServerSheet : null;
export const contextMenuProps = IS_IOS
  ? longPressProps
  : (open) => ({ onContextMenu: open });
