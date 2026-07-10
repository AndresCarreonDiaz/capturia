import { describe, expect, it } from "vitest";
import {
  SYSEXT_BUNDLE_ID,
  describeSysextError,
  formatExtensionVersion,
  parseSystemExtensionsList,
  reduceRequestEvent,
  sysextNeedsUpgrade,
  sysextUiStatus,
  type SysextRequestState,
  type SysextSnapshot,
} from "./sysext";

// Real shapes from `systemextensionsctl list` on a machine with the extension
// enabled next to an unapproved OBS one (the header and column layout are the
// command's actual output).
const LIST_ENABLED = [
  "2 extension(s)",
  "--- com.apple.system_extension.cmio (Go to 'System Settings > General > Login Items & Extensions > Camera Extensions' to modify these system extension(s))",
  "enabled\tactive\tteamID\tbundleID (version)\tname\t[state]",
  "*\t*\tTEAM123456\tcom.capturia.camera.extension (0.1.0/1)\tCapturia Camera\t[activated enabled]",
  "\t*\tOBS9876543\tcom.obsproject.obs-studio.mac-camera-extension (32.1.1/1)\tOBS Virtual Camera\t[activated waiting for user]",
].join("\n");

const LIST_WAITING = LIST_ENABLED.replace(
  "com.capturia.camera.extension (0.1.0/1)\tCapturia Camera\t[activated enabled]",
  "com.capturia.camera.extension (0.1.0/1)\tCapturia Camera\t[activated waiting for user]"
);

describe("parseSystemExtensionsList", () => {
  it("reads an enabled extension", () => {
    expect(parseSystemExtensionsList(LIST_ENABLED)).toEqual({
      present: true,
      enabled: true,
      awaitingApproval: false,
      enabledVersion: "0.1.0/1",
    });
  });

  it("reads an extension parked on the System Settings approval", () => {
    expect(parseSystemExtensionsList(LIST_WAITING)).toEqual({
      present: true,
      enabled: false,
      awaitingApproval: true,
      enabledVersion: null,
    });
  });

  it("does not confuse another vendor's rows with ours", () => {
    // Only the OBS row remains: Capturia is absent.
    const output = LIST_ENABLED.split("\n")
      .filter((l) => !l.includes(SYSEXT_BUNDLE_ID))
      .join("\n");
    expect(parseSystemExtensionsList(output)).toEqual({
      present: false,
      enabled: false,
      awaitingApproval: false,
      enabledVersion: null,
    });
  });

  it("lets an enabled row win over a stale terminated sibling", () => {
    // One row per version: an old copy waiting to uninstall must not mask the
    // live one.
    const output = [
      "\t\tTEAM123456\tcom.capturia.camera.extension (0.0.9/1)\tCapturia Camera\t[terminated waiting to uninstall on reboot]",
      "*\t*\tTEAM123456\tcom.capturia.camera.extension (0.1.0/1)\tCapturia Camera\t[activated enabled]",
    ].join("\n");
    expect(parseSystemExtensionsList(output)).toMatchObject({
      enabled: true,
      awaitingApproval: false,
      // The version comes from the ENABLED row, never the stale sibling.
      enabledVersion: "0.1.0/1",
    });
  });

  it("treats empty or garbage output as not installed", () => {
    expect(parseSystemExtensionsList("")).toEqual({
      present: false,
      enabled: false,
      awaitingApproval: false,
      enabledVersion: null,
    });
  });

  it("returns a null version when the enabled row does not parse", () => {
    const output = "*\t*\tTEAM123456\tcom.capturia.camera.extension\tCapturia Camera\t[activated enabled]";
    expect(parseSystemExtensionsList(output)).toMatchObject({
      enabled: true,
      enabledVersion: null,
    });
  });
});

describe("formatExtensionVersion / sysextNeedsUpgrade", () => {
  it("composes the systemextensionsctl short/bundle shape", () => {
    expect(formatExtensionVersion("0.1.0", "1")).toBe("0.1.0/1");
    expect(formatExtensionVersion(null, "1")).toBeNull();
    expect(formatExtensionVersion("0.1.0", undefined)).toBeNull();
  });

  it("wants an upgrade exactly when both versions are known and differ", () => {
    expect(
      sysextNeedsUpgrade("0.2.0/2", { enabled: true, enabledVersion: "0.1.0/1" })
    ).toBe(true);
    expect(
      sysextNeedsUpgrade("0.1.0/1", { enabled: true, enabledVersion: "0.1.0/1" })
    ).toBe(false);
  });

  it("never fires on unknown versions or a disabled extension", () => {
    // An unknown version must not trigger a surprise replacement request.
    expect(sysextNeedsUpgrade(null, { enabled: true, enabledVersion: "0.1.0/1" })).toBe(false);
    expect(sysextNeedsUpgrade("0.2.0/2", { enabled: true, enabledVersion: null })).toBe(false);
    expect(
      sysextNeedsUpgrade("0.2.0/2", { enabled: false, enabledVersion: null })
    ).toBe(false);
  });
});

describe("reduceRequestEvent", () => {
  const requesting: SysextRequestState = { phase: "requesting", completed: false, error: null };

  it("parks on awaiting-approval when the OS wants the user", () => {
    expect(reduceRequestEvent(requesting, { phase: "needsApproval" })).toEqual({
      phase: "awaiting-approval",
      completed: false,
      error: null,
    });
  });

  it("completes back to idle and flags the completion", () => {
    const done = reduceRequestEvent(requesting, { phase: "completed", result: "completed" });
    expect(done).toEqual({ phase: "idle", completed: true, error: null });
  });

  it("keeps the in-flight phase through a replacing event", () => {
    expect(reduceRequestEvent(requesting, { phase: "replacing" }).phase).toBe("requesting");
    const waiting = reduceRequestEvent(requesting, { phase: "needsApproval" });
    expect(reduceRequestEvent(waiting, { phase: "replacing" }).phase).toBe("awaiting-approval");
  });

  it("maps a failure to idle with a described error", () => {
    const failed = reduceRequestEvent(requesting, {
      phase: "failed",
      code: 3,
      message: "App containing System Extension to be activated must be in /Applications folder",
    });
    expect(failed.phase).toBe("idle");
    expect(failed.completed).toBe(false);
    expect(failed.error).toContain("Applications folder");
  });

  it("clears a previous error on a later success", () => {
    const failed = reduceRequestEvent(requesting, { phase: "failed", code: 1 });
    const done = reduceRequestEvent(failed, { phase: "completed", result: "completed" });
    expect(done.error).toBeNull();
    expect(done.completed).toBe(true);
  });
});

describe("describeSysextError", () => {
  it("has bespoke copy for the user-fixable codes", () => {
    expect(describeSysextError(3)).toContain("Applications folder");
    expect(describeSysextError(2)).toContain("entitlement");
    expect(describeSysextError(4)).toContain("no embedded camera extension");
    expect(describeSysextError(10)).toContain("policy");
  });

  it("falls back to the OS message plus the code", () => {
    expect(describeSysextError(7, "category?")).toBe(
      "Camera install failed: category? (code 7)."
    );
    expect(describeSysextError(1)).toContain("unknown error");
  });
});

describe("sysextUiStatus", () => {
  const snap = (over: Partial<SysextSnapshot> = {}): SysextSnapshot => ({
    supported: true,
    enabled: false,
    awaitingApproval: false,
    phase: "idle",
    error: null,
    inApplications: true,
    ...over,
  });

  it("is unsupported before anything else (dev shell, unsigned build)", () => {
    expect(sysextUiStatus(snap({ supported: false, enabled: true }))).toBe("unsupported");
  });

  it("is installed the moment the machine says enabled, wherever the app runs from", () => {
    expect(sysextUiStatus(snap({ enabled: true, inApplications: false }))).toBe("installed");
    expect(
      sysextUiStatus(snap({ enabled: true, phase: "requesting", error: "stale" }))
    ).toBe("installed");
  });

  it("surfaces the System Settings approval from either source", () => {
    expect(sysextUiStatus(snap({ awaitingApproval: true }))).toBe("awaiting-approval");
    expect(sysextUiStatus(snap({ phase: "awaiting-approval" }))).toBe("awaiting-approval");
  });

  it("shows installing while a request is in flight", () => {
    expect(sysextUiStatus(snap({ phase: "requesting" }))).toBe("installing");
  });

  it("shows the error state after a failed request", () => {
    expect(sysextUiStatus(snap({ error: "nope" }))).toBe("error");
  });

  it("asks for the move before offering install outside /Applications", () => {
    expect(sysextUiStatus(snap({ inApplications: false }))).toBe("needs-move");
  });

  it("offers install on a clean supported machine", () => {
    expect(sysextUiStatus(snap())).toBe("not-installed");
  });
});
