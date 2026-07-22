// User-facing camera selection (issue #12): the persisted {deviceId, label}
// pick and its resolution against the live enumerateDevices list. Pure so the
// resolution rules are unit-testable and shared with Electron main through
// the electron/gen build (main persists the pick in settings.json and injects
// it into the offscreen Program Output page, which has no preload).
//
// Resolution order, most to least specific:
//   1. exact deviceId match: same browser profile, nothing moved
//   2. label match: deviceIds rotate across permission scopes and browser
//      profiles, but a camera's label is stable on one machine
//   3. the physical-input heuristic (lib/camera-feed.ts): no pick was made,
//      or the picked camera is disconnected right now
// The Capturia virtual camera can never win any step: capturing it would feed
// the camera its own output (the feedback loop documented on
// isVirtualSelfCapture), so it is filtered from the candidates here and from
// the Settings picker alike.

import {
  isVirtualSelfCapture,
  pickPhysicalVideoInput,
  type VideoInputInfo,
} from "./camera-feed";

// The persisted pick. The label rides along so resolution survives a
// deviceId rotation, and so the Settings picker can name a disconnected
// pick honestly.
export interface CameraPreference {
  deviceId: string;
  label: string;
}

// Coerce anything (stored value, IPC payload, injected flag) to a valid
// preference or null. Rejects the Capturia camera outright so a hand-edited
// settings.json can never aim the stage at its own output.
export function normalizeCameraPreference(raw: unknown): CameraPreference | null {
  if (!raw || typeof raw !== "object") return null;
  const { deviceId, label } = raw as Record<string, unknown>;
  if (typeof deviceId !== "string" || deviceId === "") return null;
  if (typeof label !== "string" || label === "") return null;
  if (isVirtualSelfCapture(label)) return null;
  return { deviceId, label };
}

// The cameras the Settings picker offers: every LABELED video input except
// the Capturia virtual camera itself. Other virtual cameras (OBS, mmhmm)
// stay listed on purpose: the heuristic keeps them out of the AUTOMATIC pick,
// but routing one through Capturia deliberately is a valid setup, and this
// picker is exactly the override the heuristic defers to.
export function listSelectableCameras(devices: VideoInputInfo[]): VideoInputInfo[] {
  return devices.filter(
    (d) => d.kind === "videoinput" && d.label !== "" && !isVirtualSelfCapture(d.label)
  );
}

export interface CameraSelection {
  // What to open; null when nothing usable can be identified (the caller
  // falls back to its open-then-fix path).
  device: VideoInputInfo | null;
  // Whether the persisted pick resolved ("preference") or the heuristic
  // decided ("fallback": no pick, or the picked camera is disconnected).
  source: "preference" | "fallback";
  // Non-null when the pick resolved under a different identity than stored
  // (rotated deviceId, renamed label): persist it so the next resolution is
  // an exact hit. A fallback never rewrites the pick: an unplugged camera
  // must win again the moment it is replugged.
  updatedPreference: CameraPreference | null;
}

export function resolveCameraDevice(
  preference: CameraPreference | null,
  devices: VideoInputInfo[]
): CameraSelection {
  const candidates = listSelectableCameras(devices);
  const pick = normalizeCameraPreference(preference);
  if (pick) {
    const device =
      candidates.find((d) => d.deviceId === pick.deviceId) ??
      candidates.find((d) => d.label === pick.label) ??
      null;
    if (device) {
      const rotated = device.deviceId !== pick.deviceId || device.label !== pick.label;
      return {
        device,
        source: "preference",
        updatedPreference: rotated ? { deviceId: device.deviceId, label: device.label } : null,
      };
    }
  }
  return {
    device: pickPhysicalVideoInput(devices),
    source: "fallback",
    updatedPreference: null,
  };
}

// The DOM contract through which Electron main threads the pick into the
// offscreen Program Output page (no preload there by design): the same
// flag-then-event shape as the webcam pause control in lib/camera-feed.ts,
// so the mount-time flag read and the live event cover both sides of the
// injection race.
export const CAMERA_PICK_EVENT = "capturia:camera-pick";
export const CAMERA_PICK_FLAG = "__capturiaCameraPick";

// The statement main injects (webContents.executeJavaScript) to hand a studio
// page the persisted pick: sets the sticky flag, then dispatches the event
// for pages that are already mounted. Normalizes on the way in, so even a
// corrupted store injects null (automatic), never the virtual camera. Ends in
// `void 0` so the injection resolves to undefined.
export function cameraPickControlScript(preference: CameraPreference | null): string {
  const value = JSON.stringify(normalizeCameraPreference(preference));
  return (
    `window.${CAMERA_PICK_FLAG} = ${value};` +
    `window.dispatchEvent(new CustomEvent(${JSON.stringify(CAMERA_PICK_EVENT)}, ` +
    `{ detail: { preference: ${value} } }));` +
    `void 0;`
  );
}
