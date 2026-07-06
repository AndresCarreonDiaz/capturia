// Pure model for the menu-bar (tray) menu: renderer-reported state in, plain
// item descriptors out. electron/tray.js binds these to real Electron Tray and
// Menu objects; keeping the decisions here makes them unit-testable and shared
// through the electron/gen build like the other main-process libs.

export interface TrayState {
  // False until the studio renderer sends its first state:report this launch;
  // before that the shell cannot know whether voice is even supported.
  reported: boolean;
  listening: boolean;
  voiceSupported: boolean;
}

export type TrayAction =
  | "toggle-listening"
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

  return [
    { type: "item", label: trayStatusLabel(state), enabled: false },
    { type: "separator" },
    toggle,
    { type: "item", label: "Open Control Room", enabled: true, action: "open-control-room" },
    { type: "item", label: "Settings…", enabled: true, action: "open-settings" },
    { type: "separator" },
    { type: "item", label: "Quit Capturia", enabled: true, action: "quit" },
  ];
}
