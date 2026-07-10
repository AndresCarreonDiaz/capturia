import { describe, expect, it } from "vitest";
import { buildTrayMenu, trayStatusLabel, type TrayState } from "./tray-menu";

const state = (over: Partial<TrayState> = {}): TrayState => ({
  reported: true,
  listening: false,
  voiceSupported: true,
  ...over,
});

describe("trayStatusLabel", () => {
  it("shows starting until the renderer reports", () => {
    expect(trayStatusLabel(state({ reported: false }))).toBe("Capturia: starting");
  });

  it("shows voice unavailable when speech is unsupported", () => {
    expect(trayStatusLabel(state({ voiceSupported: false }))).toBe(
      "Capturia: voice unavailable"
    );
  });

  it("shows listening while the mic loop runs", () => {
    expect(trayStatusLabel(state({ listening: true }))).toBe("Capturia: listening");
  });

  it("shows idle otherwise", () => {
    expect(trayStatusLabel(state())).toBe("Capturia: idle");
  });

  it("prefers starting over unsupported before the first report", () => {
    // Before the first report voiceSupported is a default, not a fact; the
    // label must not claim voice is broken yet.
    expect(trayStatusLabel(state({ reported: false, voiceSupported: false }))).toBe(
      "Capturia: starting"
    );
  });
});

describe("buildTrayMenu", () => {
  it("leads with a disabled status line", () => {
    const [status] = buildTrayMenu(state());
    expect(status.type).toBe("item");
    expect(status.enabled).toBe(false);
    expect(status.label).toBe("Capturia: idle");
    expect(status.action).toBeUndefined();
  });

  it("offers Start Listening when idle and Stop Listening when live", () => {
    const idle = buildTrayMenu(state()).find((i) => i.action === "toggle-listening");
    const live = buildTrayMenu(state({ listening: true })).find(
      (i) => i.action === "toggle-listening"
    );
    expect(idle?.label).toBe("Start Listening");
    expect(idle?.enabled).toBe(true);
    expect(live?.label).toBe("Stop Listening");
  });

  it("disables the toggle before the renderer reports", () => {
    const toggle = buildTrayMenu(state({ reported: false })).find(
      (i) => i.action === "toggle-listening"
    );
    expect(toggle?.enabled).toBe(false);
  });

  it("disables the toggle when voice is unsupported", () => {
    const toggle = buildTrayMenu(state({ voiceSupported: false })).find(
      (i) => i.action === "toggle-listening"
    );
    expect(toggle?.enabled).toBe(false);
  });

  it("threads the hotkey through as a display accelerator", () => {
    const toggle = buildTrayMenu(state(), "CmdOrCtrl+Alt+Space").find(
      (i) => i.action === "toggle-listening"
    );
    expect(toggle?.accelerator).toBe("CmdOrCtrl+Alt+Space");
    const bare = buildTrayMenu(state()).find((i) => i.action === "toggle-listening");
    expect(bare?.accelerator).toBeUndefined();
  });

  it("always exposes Control Room, Settings, and Quit", () => {
    const actions = buildTrayMenu(state({ reported: false, voiceSupported: false })).map(
      (i) => i.action
    );
    expect(actions).toContain("open-control-room");
    expect(actions).toContain("open-settings");
    expect(actions).toContain("quit");
  });

  it("every non-separator item has a label", () => {
    for (const item of buildTrayMenu(state())) {
      if (item.type === "separator") continue;
      expect(item.label).toBeTruthy();
    }
  });

  it("shows no camera item when the shell reports no camera state", () => {
    const items = buildTrayMenu(state()).filter((i) => i.action === "toggle-camera");
    expect(items).toHaveLength(0);
  });

  it("labels the camera toggle by its running state", () => {
    const off = buildTrayMenu(state({ cameraAvailable: true, cameraRunning: false })).find(
      (i) => i.action === "toggle-camera"
    );
    const on = buildTrayMenu(state({ cameraAvailable: true, cameraRunning: true })).find(
      (i) => i.action === "toggle-camera"
    );
    expect(off?.label).toBe("Camera: Off");
    expect(on?.label).toBe("Camera: On");
  });

  it("keeps the camera toggle enabled even when the extension is missing", () => {
    // Clicking while unavailable retries discovery (someone may have just
    // approved the extension in System Settings), so it must stay clickable.
    const item = buildTrayMenu(
      state({ cameraAvailable: false, cameraRunning: false })
    ).find((i) => i.action === "toggle-camera");
    expect(item?.enabled).toBe(true);
    expect(item?.label).toBe("Camera: Off");
  });
});
