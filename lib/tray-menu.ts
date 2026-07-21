// Pure model for the menu-bar (tray) menu: renderer-reported state in, plain
// item descriptors out. electron/tray.js binds these to real Electron Tray and
// Menu objects; keeping the decisions here makes them unit-testable and shared
// through the electron/gen build like the other main-process libs.

import type { SysextUiStatus } from "./sysext";

export interface TrayState {
  // False until the studio renderer sends its first state:report this launch;
  // before that the shell cannot know whether voice is even supported.
  reported: boolean;
  listening: boolean;
  voiceSupported: boolean;
  // Virtual camera feed (M7b). Omit ALL of these when the shell has no camera
  // module (the menu then shows no camera item at all); cameraAvailable=false
  // means the Capturia camera extension is not installed or approved.
  cameraAvailable?: boolean;
  cameraRunning?: boolean;
  // Wanted but not delivering yet (page load retries or sink-connect backoff).
  cameraConnecting?: boolean;
  // Running, but the Program Output page has stopped painting: viewers see a
  // repeated frozen frame, and the menu must not claim a healthy "On".
  cameraFrozen?: boolean;
  // The feed reports an error (load failure, extension missing, crash loop).
  cameraHasError?: boolean;
  // In-app camera-extension activation (M8 slice 2). Omit when the shell has
  // no sysext module; "unsupported" (dev shell, unsigned build) also hides
  // the item, because that build can never submit an activation request (the
  // dev host app in native/CapturiaCamera owns that workflow).
  sysextStatus?: SysextUiStatus;
  // The loopback AI runtime failed to start AND the shell has no fallback
  // route (static/file:// UI; dev serves the runtime through Next either
  // way). Shows the restart entry point (issue #51): without it the only
  // recovery from a failed runtime start is relaunching the whole app.
  aiEngineDown?: boolean;
}

export type TrayAction =
  | "toggle-listening"
  | "toggle-camera"
  | "install-camera"
  | "restart-ai"
  | "open-control-room"
  | "open-settings"
  | "quit";

export interface TrayItem {
  type: "item" | "separator";
  label?: string;
  enabled?: boolean;
  action?: TrayAction;
  // Display-only shortcut hint; the real global registration stays in main.
  accelerator?: string;
}

export function trayStatusLabel(state: TrayState): string {
  if (!state.reported) return "Capturia: starting";
  if (!state.voiceSupported) return "Capturia: voice unavailable";
  return state.listening ? "Capturia: listening" : "Capturia: idle";
}

// Label for the camera toggle, most-specific state first: a pending connect
// beats everything (the click cancels it), a frozen feed must never read as
// a healthy "On", and a stopped feed distinguishes error from plain off.
export function cameraToggleLabel(state: TrayState): string {
  if (state.cameraConnecting) return "Camera: Connecting…";
  if (state.cameraRunning) return state.cameraFrozen ? "Camera: Frozen" : "Camera: On";
  return state.cameraHasError ? "Camera: Error" : "Camera: Off";
}

// Label + enablement for the extension-install item. Only three states are
// clickable: install, retry after an error, and the pre-install move nudge
// (the click routes to the move offer in main). Approval lives in System
// Settings, so that state is a signpost, not a button; "installed" stays
// visible as a disabled confirmation (the Krisp "everything is fine" line).
export function sysextItem(status: SysextUiStatus): TrayItem | null {
  switch (status) {
    case "unsupported":
      return null;
    case "installed":
      return { type: "item", label: "Camera installed", enabled: false };
    case "awaiting-approval":
      return {
        type: "item",
        label: "Approve camera in System Settings",
        enabled: false,
      };
    case "installing":
      return { type: "item", label: "Installing camera…", enabled: false };
    case "error":
      return { type: "item", label: "Retry camera install", enabled: true, action: "install-camera" };
    case "needs-move":
      return {
        type: "item",
        label: "Install camera (moves app to Applications)",
        enabled: true,
        action: "install-camera",
      };
    case "not-installed":
      return { type: "item", label: "Install camera", enabled: true, action: "install-camera" };
  }
}

export function buildTrayMenu(state: TrayState, toggleHotkey?: string): TrayItem[] {
  const toggle: TrayItem = {
    type: "item",
    label: state.listening ? "Stop Listening" : "Start Listening",
    // No point offering the toggle before the renderer is up, or when the
    // speech engine is missing; the click would silently do nothing.
    enabled: state.reported && state.voiceSupported,
    action: "toggle-listening",
  };
  if (toggleHotkey) toggle.accelerator = toggleHotkey;

  // Camera item only when the shell reports camera state at all. Always
  // enabled (unlike the voice toggle): when the extension is missing, the
  // click retries discovery, which is exactly what someone who just approved
  // the extension in System Settings needs; it never silently does nothing.
  // The click acts on INTENT (stop while connecting OR running, else start),
  // so a pending auto-connect is cancellable before it goes live mid-call.
  const camera: TrayItem[] =
    state.cameraAvailable === undefined
      ? []
      : [
          {
            type: "item",
            label: cameraToggleLabel(state),
            enabled: true,
            action: "toggle-camera",
          },
        ];

  // The activation item sits under the feed toggle: install first, then the
  // toggle above it starts meaning something. Absent entirely when the shell
  // has no sysext module or the build cannot request activation.
  const install =
    state.sysextStatus === undefined ? null : sysextItem(state.sysextStatus);

  // Present only while the engine is down: a working engine needs no restart
  // item, and on builds with a route fallback the item would be noise.
  const restartAi: TrayItem[] = state.aiEngineDown
    ? [{ type: "item", label: "Restart AI engine", enabled: true, action: "restart-ai" }]
    : [];

  return [
    { type: "item", label: trayStatusLabel(state), enabled: false },
    { type: "separator" },
    toggle,
    ...camera,
    ...(install ? [install] : []),
    ...restartAi,
    { type: "item", label: "Open Control Room", enabled: true, action: "open-control-room" },
    { type: "item", label: "Settings…", enabled: true, action: "open-settings" },
    { type: "separator" },
    { type: "item", label: "Quit Capturia", enabled: true, action: "quit" },
  ];
}
