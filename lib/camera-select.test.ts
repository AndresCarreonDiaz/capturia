import { describe, expect, it } from "vitest";
import {
  CAMERA_PICK_EVENT,
  CAMERA_PICK_FLAG,
  cameraPickControlScript,
  listSelectableCameras,
  normalizeCameraPreference,
  resolveCameraDevice,
  type CameraPreference,
} from "./camera-select";
import type { VideoInputInfo } from "./camera-feed";

const input = (label: string, deviceId = `id:${label}`, kind = "videoinput"): VideoInputInfo => ({
  kind,
  label,
  deviceId,
});

const pref = (over: Partial<CameraPreference> = {}): CameraPreference => ({
  deviceId: "id:Logitech BRIO",
  label: "Logitech BRIO",
  ...over,
});

describe("normalizeCameraPreference", () => {
  it("accepts a valid pick and strips anything extra", () => {
    expect(
      normalizeCameraPreference({ deviceId: "abc", label: "Logitech BRIO", stale: true })
    ).toEqual({ deviceId: "abc", label: "Logitech BRIO" });
  });

  it("rejects non-objects and malformed shapes", () => {
    expect(normalizeCameraPreference(null)).toBeNull();
    expect(normalizeCameraPreference(undefined)).toBeNull();
    expect(normalizeCameraPreference("Logitech BRIO")).toBeNull();
    expect(normalizeCameraPreference(42)).toBeNull();
    expect(normalizeCameraPreference({ deviceId: "abc" })).toBeNull();
    expect(normalizeCameraPreference({ label: "Logitech BRIO" })).toBeNull();
    expect(normalizeCameraPreference({ deviceId: "", label: "Logitech BRIO" })).toBeNull();
    expect(normalizeCameraPreference({ deviceId: "abc", label: "" })).toBeNull();
    expect(normalizeCameraPreference({ deviceId: 7, label: "Logitech BRIO" })).toBeNull();
  });

  it("rejects the Capturia camera itself", () => {
    // A hand-edited settings.json (or a corrupted localStorage entry) must
    // never be able to point the stage at its own output.
    expect(normalizeCameraPreference({ deviceId: "abc", label: "Capturia" })).toBeNull();
  });
});

describe("listSelectableCameras", () => {
  it("lists labeled video inputs and drops the Capturia camera", () => {
    const listed = listSelectableCameras([
      input("Capturia"),
      input("FaceTime HD Camera"),
      input("Logitech BRIO"),
    ]);
    expect(listed.map((d) => d.label)).toEqual(["FaceTime HD Camera", "Logitech BRIO"]);
  });

  it("keeps OTHER virtual cameras: the picker is the override the heuristic defers to", () => {
    // The automatic pick excludes OBS-style cameras, but feeding one through
    // Capturia on purpose is a valid setup; only the self-capture loop is
    // impossible to want.
    const listed = listSelectableCameras([input("OBS Virtual Camera"), input("Capturia")]);
    expect(listed.map((d) => d.label)).toEqual(["OBS Virtual Camera"]);
  });

  it("drops unlabeled devices and non-video kinds", () => {
    expect(
      listSelectableCameras([input(""), input("MacBook Pro Microphone", undefined, "audioinput")])
    ).toEqual([]);
  });
});

describe("resolveCameraDevice", () => {
  it("resolves an exact deviceId match with no rewrite", () => {
    const brio = input("Logitech BRIO");
    const result = resolveCameraDevice(pref(), [input("FaceTime HD Camera"), brio]);
    expect(result.device).toBe(brio);
    expect(result.source).toBe("preference");
    expect(result.updatedPreference).toBeNull();
  });

  it("prefers the exact deviceId over a label match on another device", () => {
    const renamed = input("Logitech BRIO 4K", "id:Logitech BRIO");
    const impostor = input("Logitech BRIO", "id:other");
    const result = resolveCameraDevice(pref(), [impostor, renamed]);
    expect(result.device).toBe(renamed);
    // The label moved under the same id; persist the fresh identity.
    expect(result.updatedPreference).toEqual({
      deviceId: "id:Logitech BRIO",
      label: "Logitech BRIO 4K",
    });
  });

  it("falls back to the label when the deviceId rotated, and persists the new id", () => {
    // deviceIds rotate across permission scopes and browser profiles; the
    // label is what identifies the same camera on the same machine.
    const brio = input("Logitech BRIO", "id:rotated");
    const result = resolveCameraDevice(pref(), [input("FaceTime HD Camera"), brio]);
    expect(result.device).toBe(brio);
    expect(result.source).toBe("preference");
    expect(result.updatedPreference).toEqual({ deviceId: "id:rotated", label: "Logitech BRIO" });
  });

  it("falls back to the heuristic when the pick is disconnected, WITHOUT rewriting it", () => {
    // The pick must win again the moment the camera is replugged, so an
    // unplug never overwrites the stored preference.
    const result = resolveCameraDevice(pref(), [
      input("Elgato Cam Link 4K"),
      input("FaceTime HD Camera"),
    ]);
    expect(result.device?.label).toBe("FaceTime HD Camera");
    expect(result.source).toBe("fallback");
    expect(result.updatedPreference).toBeNull();
  });

  it("never resolves the Capturia camera, even when the store says so", () => {
    const result = resolveCameraDevice(
      { deviceId: "id:Capturia", label: "Capturia" },
      [input("Capturia"), input("FaceTime HD Camera")]
    );
    expect(result.device?.label).toBe("FaceTime HD Camera");
    expect(result.source).toBe("fallback");
  });

  it("ignores a deviceId match on an unlabeled device", () => {
    // Labels are only empty before a capture permission exists, and an
    // unlabeled device cannot be certified non-virtual; the caller's
    // open-then-fix path handles that world.
    const result = resolveCameraDevice(pref(), [input("", "id:Logitech BRIO")]);
    expect(result.device).toBeNull();
    expect(result.source).toBe("fallback");
  });

  it("uses the heuristic when no pick was ever made", () => {
    const result = resolveCameraDevice(null, [
      input("Elgato Cam Link 4K"),
      input("FaceTime HD Camera"),
    ]);
    expect(result.device?.label).toBe("FaceTime HD Camera");
    expect(result.source).toBe("fallback");
    expect(result.updatedPreference).toBeNull();
  });

  it("returns no device for an empty list", () => {
    expect(resolveCameraDevice(pref(), []).device).toBeNull();
    expect(resolveCameraDevice(null, []).device).toBeNull();
  });
});

describe("cameraPickControlScript", () => {
  it("writes the sticky flag BEFORE dispatching the event", () => {
    // WebcamFeed reconciles from the flag on mount and from the event while
    // mounted, same contract as the webcam pause control: the flag must
    // already hold the value when the event fires or the mount-side read
    // loses the race.
    for (const preference of [pref(), null]) {
      const script = cameraPickControlScript(preference);
      expect(script.indexOf(CAMERA_PICK_FLAG)).toBeGreaterThanOrEqual(0);
      expect(script.indexOf(CAMERA_PICK_FLAG)).toBeLessThan(script.indexOf("dispatchEvent"));
      expect(script).toContain(JSON.stringify(CAMERA_PICK_EVENT));
    }
  });

  it("evaluates cleanly and reaches a page-world listener", () => {
    const seen: Array<{ preference?: CameraPreference | null }> = [];
    const listeners: Array<(e: { detail?: { preference?: CameraPreference | null } }) => void> =
      [];
    const fakeWindow: Record<string, unknown> = {
      dispatchEvent: (e: { detail?: { preference?: CameraPreference | null } }) => {
        listeners.forEach((fn) => fn(e));
        return true;
      },
    };
    listeners.push((e) => seen.push(e.detail ?? {}));
    class FakeCustomEvent {
      detail?: { preference?: CameraPreference | null };
      constructor(_type: string, init?: { detail?: { preference?: CameraPreference | null } }) {
        this.detail = init?.detail;
      }
    }
    const run = new Function("window", "CustomEvent", cameraPickControlScript(pref()));
    expect(run(fakeWindow, FakeCustomEvent)).toBeUndefined();
    expect(fakeWindow[CAMERA_PICK_FLAG]).toEqual(pref());
    expect(seen).toEqual([{ preference: pref() }]);
  });

  it("injects null for a cleared or corrupted pick", () => {
    const fakeWindow: Record<string, unknown> = { dispatchEvent: () => true };
    // The dispatched detail is not asserted here, so the stub keeps nothing.
    class FakeCustomEvent {}
    for (const preference of [null, { deviceId: "abc", label: "Capturia" }]) {
      new Function("window", "CustomEvent", cameraPickControlScript(preference))(
        fakeWindow,
        FakeCustomEvent
      );
      expect(fakeWindow[CAMERA_PICK_FLAG]).toBeNull();
    }
  });

  it("survives labels with quotes and backslashes", () => {
    // Labels are OS-controlled strings; the script is built with
    // JSON.stringify so any of them must evaluate, not break the injection.
    const hostile = pref({ label: 'My "weird" \\ camera' });
    const fakeWindow: Record<string, unknown> = { dispatchEvent: () => true };
    class FakeCustomEvent {}
    new Function("window", "CustomEvent", cameraPickControlScript(hostile))(
      fakeWindow,
      FakeCustomEvent
    );
    expect(fakeWindow[CAMERA_PICK_FLAG]).toEqual(hostile);
  });
});
