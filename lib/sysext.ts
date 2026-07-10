// Pure model for in-app camera-extension activation (M8 slice 2): every
// decision electron/sysext.js makes that does not need Electron or the native
// addon lives here, so it is unit-testable and shared through the electron/gen
// build like tray-menu and camera-feed.
//
// The packaged Capturia.app embeds the CMIO camera extension at
// Contents/Library/SystemExtensions, and macOS only accepts an activation
// request (OSSystemExtensionRequest) from the app that embeds the extension,
// signed with the system-extension entitlement, running from /Applications.
// This module turns those machine facts (systemextensionsctl output, request
// delegate events, app location, build capabilities) into one UI status the
// tray and the onboarding step can render.

export const SYSEXT_BUNDLE_ID = "com.capturia.camera.extension";

// What `systemextensionsctl list` says about one bundle id on this machine.
// The command prints ONE ROW PER VERSION of the extension: a stale
// "[terminated waiting to uninstall]" row can sit next to the live one, so
// "enabled anywhere" wins over every other row state.
export interface SysextListState {
  // Any row exists for the bundle id (installed in some state).
  present: boolean;
  // Some row reads "activated enabled": the camera is live on this machine.
  enabled: boolean;
  // No row is enabled but one reads "activated waiting for user": macOS is
  // holding the extension until the System Settings approval.
  awaitingApproval: boolean;
  // The ENABLED row's version as systemextensionsctl prints it,
  // "shortVersion/bundleVersion" (e.g. "0.1.0/1"); null when nothing is
  // enabled or the row does not parse. Drives the upgrade check against the
  // version embedded in this build.
  enabledVersion: string | null;
}

export function parseSystemExtensionsList(
  output: string,
  bundleId: string = SYSEXT_BUNDLE_ID
): SysextListState {
  const rows = output.split("\n").filter((line) => line.includes(bundleId));
  const enabledRow = rows.find((line) => line.includes("activated enabled"));
  const enabled = enabledRow !== undefined;
  // Row shape: "...\tbundle.id (0.1.0/1)\tName\t[state]".
  const version = enabledRow
    ? new RegExp(`${bundleId.replace(/\./g, "\\.")}\\s*\\(([^)]+)\\)`).exec(enabledRow)?.[1] ??
      null
    : null;
  return {
    present: rows.length > 0,
    enabled,
    awaitingApproval:
      !enabled && rows.some((line) => line.includes("activated waiting for user")),
    enabledVersion: version,
  };
}

// The version string of an extension bundle in systemextensionsctl's
// "shortVersion/bundleVersion" format, composed from its Info.plist values.
export function formatExtensionVersion(
  shortVersion: string | null | undefined,
  bundleVersion: string | null | undefined
): string | null {
  if (!shortVersion || !bundleVersion) return null;
  return `${shortVersion}/${bundleVersion}`;
}

// Should a capable build request activation to REPLACE the already-enabled
// extension? Only when both versions are known and differ: a same-version
// request is a quiet no-op (verified live), but firing one on every launch
// would be noise, and an unknown version must never trigger a surprise
// replacement. This is the OBS pattern: the host app re-requests activation
// when it ships a different extension version than the one running.
export function sysextNeedsUpgrade(
  embeddedVersion: string | null,
  list: Pick<SysextListState, "enabled" | "enabledVersion">
): boolean {
  return (
    list.enabled &&
    embeddedVersion !== null &&
    list.enabledVersion !== null &&
    embeddedVersion !== list.enabledVersion
  );
}

// Delegate outcomes of one OSSystemExtensionRequest, as forwarded by the
// native addon (native/capturia-sysext). "replacing" is informational (the
// addon always answers the replacement question with "replace": the embedded
// copy IS the product's current build); the other three drive the phase.
export type SysextRequestEvent =
  | { phase: "replacing"; existingVersion?: string; newVersion?: string }
  | { phase: "needsApproval" }
  | { phase: "completed"; result: "completed" | "willCompleteAfterReboot" }
  | { phase: "failed"; code: number; domain?: string; message?: string };

// Where the in-flight request stands. "awaiting-approval" survives until the
// delegate finishes (approval in System Settings completes the request on its
// own, no re-submission needed).
export type SysextRequestPhase = "idle" | "requesting" | "awaiting-approval";

export interface SysextRequestState {
  phase: SysextRequestPhase;
  // Set on the completed event: the caller's cue to refresh the list state
  // and nudge the camera feed to connect.
  completed: boolean;
  // Human-readable failure, mapped from the OSSystemExtensionErrorDomain code.
  error: string | null;
}

export function reduceRequestEvent(
  prev: SysextRequestState,
  event: SysextRequestEvent
): SysextRequestState {
  switch (event.phase) {
    case "replacing":
      // Informational only; the request is still in flight.
      return { ...prev, completed: false };
    case "needsApproval":
      return { phase: "awaiting-approval", completed: false, error: null };
    case "completed":
      return { phase: "idle", completed: true, error: null };
    case "failed":
      return {
        phase: "idle",
        completed: false,
        error: describeSysextError(event.code, event.message),
      };
  }
}

// OSSystemExtensionErrorDomain codes (SystemExtensions.h, macOS SDK). Only
// the ones a user can plausibly hit get bespoke copy; the rest fall through
// to the OS message with the code attached.
export function describeSysextError(code: number, message?: string): string {
  switch (code) {
    case 2: // missingEntitlement
      return "This build of Capturia cannot install the camera (it was signed without the system-extension entitlement).";
    case 3: // unsupportedParentBundleLocation
      return "Move Capturia to the Applications folder, then try installing the camera again.";
    case 4: // extensionNotFound
      return "This build of Capturia has no embedded camera extension.";
    case 8: // codeSignatureInvalid
      return "The camera extension's code signature was rejected. Reinstall Capturia.";
    case 9: // validationFailed
      return "macOS rejected the camera extension (validation failed). Reinstall Capturia.";
    case 10: // forbiddenBySystemPolicy
      return "System policy blocks the camera extension (often an MDM restriction).";
    case 11: // requestCanceled
      return "The camera install was canceled.";
    case 12: // requestSuperseded (another request for the same id was pending)
      return "Another camera install request was already pending; try again in a moment.";
    default:
      return `Camera install failed: ${message || "unknown error"} (code ${code}).`;
  }
}

// Everything the UI status depends on, gathered by electron/sysext.js.
export interface SysextSnapshot {
  // This build can submit activation requests at all: packaged macOS app with
  // the extension embedded, the entitlement in its signature, and the native
  // addon loaded. The dev shell (npm run electron) is never supported; the
  // dev host app in native/CapturiaCamera covers that workflow.
  supported: boolean;
  // From parseSystemExtensionsList.
  enabled: boolean;
  awaitingApproval: boolean;
  // From the live request (reduceRequestEvent).
  phase: SysextRequestPhase;
  error: string | null;
  // macOS only activates extensions for apps running from /Applications.
  inApplications: boolean;
}

// One status the tray item and the onboarding step both render. Order is
// most-settled-first: an enabled extension is "installed" no matter where the
// app runs from or what a stale request said.
export type SysextUiStatus =
  | "unsupported"
  | "installed"
  | "awaiting-approval"
  | "installing"
  | "error"
  | "needs-move"
  | "not-installed";

export function sysextUiStatus(s: SysextSnapshot): SysextUiStatus {
  if (!s.supported) return "unsupported";
  if (s.enabled) return "installed";
  if (s.awaitingApproval || s.phase === "awaiting-approval") return "awaiting-approval";
  if (s.phase === "requesting") return "installing";
  if (s.error) return "error";
  if (!s.inApplications) return "needs-move";
  return "not-installed";
}

// The payload main pushes to the renderer (sysext channel / sysext:state).
export interface SysextStateReport {
  status: SysextUiStatus;
  error: string | null;
}
