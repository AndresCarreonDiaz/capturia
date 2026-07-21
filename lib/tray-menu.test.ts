import { describe, expect, it } from "vitest";
import { buildTrayMenu, sysextItem, trayStatusLabel, type TrayState } from "./tray-menu";

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

  it("always exposes Control Room, Settings, Check for Updates, and Quit", () => {
    const actions = buildTrayMenu(state({ reported: false, voiceSupported: false })).map(
      (i) => i.action
    );
    expect(actions).toContain("open-control-room");
    expect(actions).toContain("open-settings");
    expect(actions).toContain("check-updates");
    expect(actions).toContain("quit");
  });

  it("keeps Check for Updates clickable regardless of renderer state", () => {
    // The check runs in main against GitHub; a still-booting or voiceless
    // renderer is no reason to block it, and the click always answers.
    const item = buildTrayMenu(state({ reported: false, voiceSupported: false })).find(
      (i) => i.action === "check-updates"
    );
    expect(item?.label).toBe("Check for Updates");
    expect(item?.enabled).toBe(true);
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

  it("labels a pending connect as Connecting, beating every other state", () => {
    // The click while connecting CANCELS the pending start, so the label must
    // say the feed is in flight, not a settled On/Off.
    const item = buildTrayMenu(
      state({
        cameraAvailable: true,
        cameraRunning: false,
        cameraConnecting: true,
        cameraHasError: true,
      })
    ).find((i) => i.action === "toggle-camera");
    expect(item?.label).toBe("Camera: Connecting…");
    expect(item?.enabled).toBe(true);
  });

  it("labels a running feed with no paints as Frozen, never a healthy On", () => {
    const frozen = buildTrayMenu(
      state({ cameraAvailable: true, cameraRunning: true, cameraFrozen: true })
    ).find((i) => i.action === "toggle-camera");
    const healthy = buildTrayMenu(
      state({ cameraAvailable: true, cameraRunning: true, cameraFrozen: false })
    ).find((i) => i.action === "toggle-camera");
    expect(frozen?.label).toBe("Camera: Frozen");
    expect(healthy?.label).toBe("Camera: On");
  });

  it("labels a stopped feed with an error as Error, not a plain Off", () => {
    const item = buildTrayMenu(
      state({ cameraAvailable: true, cameraRunning: false, cameraHasError: true })
    ).find((i) => i.action === "toggle-camera");
    expect(item?.label).toBe("Camera: Error");
  });
});

describe("restart-ai menu entry", () => {
  it("shows no restart item while the AI engine is up or has a fallback", () => {
    expect(buildTrayMenu(state()).filter((i) => i.action === "restart-ai")).toHaveLength(0);
    expect(
      buildTrayMenu(state({ aiEngineDown: false })).filter((i) => i.action === "restart-ai")
    ).toHaveLength(0);
  });

  it("offers Restart AI engine while the engine is down", () => {
    const item = buildTrayMenu(state({ aiEngineDown: true })).find(
      (i) => i.action === "restart-ai"
    );
    expect(item?.label).toBe("Restart AI engine");
    expect(item?.enabled).toBe(true);
  });

  it("keeps the restart item clickable even before the renderer reports", () => {
    // The engine restarts in MAIN; a hung or still-booting renderer is no
    // reason to block the one recovery path the failure dialog points at.
    const item = buildTrayMenu(state({ aiEngineDown: true, reported: false })).find(
      (i) => i.action === "restart-ai"
    );
    expect(item?.enabled).toBe(true);
  });
});

describe("sysextItem / install-camera menu entry", () => {
  it("shows no install item when the shell has no sysext module", () => {
    const items = buildTrayMenu(state()).filter((i) => i.action === "install-camera");
    expect(items).toHaveLength(0);
  });

  it("hides the item on unsupported builds (dev shell, unsigned pack)", () => {
    expect(sysextItem("unsupported")).toBeNull();
    const items = buildTrayMenu(state({ sysextStatus: "unsupported" })).filter(
      (i) => i.label?.toLowerCase().includes("camera install") || i.action === "install-camera"
    );
    expect(items).toHaveLength(0);
  });

  it("offers Install camera when the extension is missing", () => {
    const item = buildTrayMenu(state({ sysextStatus: "not-installed" })).find(
      (i) => i.action === "install-camera"
    );
    expect(item?.label).toBe("Install camera");
    expect(item?.enabled).toBe(true);
  });

  it("confirms Camera installed as a disabled line", () => {
    const item = sysextItem("installed");
    expect(item?.label).toBe("Camera installed");
    expect(item?.enabled).toBe(false);
    expect(item?.action).toBeUndefined();
  });

  it("signposts the System Settings approval without a click target", () => {
    const item = sysextItem("awaiting-approval");
    expect(item?.label).toBe("Approve camera in System Settings");
    expect(item?.enabled).toBe(false);
  });

  it("disables the item while a request is in flight", () => {
    expect(sysextItem("installing")?.enabled).toBe(false);
  });

  it("keeps error and needs-move clickable (retry / move offer)", () => {
    expect(sysextItem("error")?.action).toBe("install-camera");
    expect(sysextItem("error")?.enabled).toBe(true);
    expect(sysextItem("needs-move")?.action).toBe("install-camera");
    expect(sysextItem("needs-move")?.enabled).toBe(true);
  });
});
