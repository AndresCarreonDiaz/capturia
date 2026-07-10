import { describe, expect, it } from "vitest";
import {
  CAMERA_DEVICE_NAME,
  CRASH_WINDOW_MS,
  MAX_CRASHES_PER_WINDOW,
  SINK_CONNECT_DELAYS_MS,
  findCameraDevice,
  programOutputUrl,
  shouldRecreateAfterCrash,
  type CameraDevice,
} from "./camera-feed";

const device = (over: Partial<CameraDevice> = {}): CameraDevice => ({
  id: 42,
  name: CAMERA_DEVICE_NAME,
  uid: "8C6C4A5E-0000-0000-0000-000000000000",
  streams: 2,
  ...over,
});

describe("findCameraDevice", () => {
  it("finds the Capturia device with both streams", () => {
    const capturia = device();
    const found = findCameraDevice([
      device({ id: 1, name: "FaceTime HD Camera", streams: 1 }),
      capturia,
    ]);
    expect(found).toBe(capturia);
  });

  it("ignores other cameras entirely", () => {
    expect(
      findCameraDevice([device({ name: "OBS Virtual Camera" })])
    ).toBeNull();
  });

  it("rejects a half-initialized Capturia with a single stream", () => {
    // One stream means no sink to feed; treat it as not available rather
    // than connecting to something that cannot accept frames.
    expect(findCameraDevice([device({ streams: 1 })])).toBeNull();
  });

  it("returns null for an empty device list", () => {
    expect(findCameraDevice([])).toBeNull();
  });
});

describe("programOutputUrl", () => {
  it("appends ?out=1 to the dev studio URL", () => {
    expect(programOutputUrl("http://localhost:3000/studio")).toBe(
      "http://localhost:3000/studio?out=1"
    );
  });

  it("appends &out=1 when a query already exists", () => {
    expect(programOutputUrl("http://localhost:3000/studio?fx=0")).toBe(
      "http://localhost:3000/studio?fx=0&out=1"
    );
  });

  it("works for the static file:// export", () => {
    expect(programOutputUrl("file:///Applications/Capturia.app/out/studio.html")).toBe(
      "file:///Applications/Capturia.app/out/studio.html?out=1"
    );
  });
});

describe("shouldRecreateAfterCrash", () => {
  it("recreates after an isolated crash", () => {
    expect(shouldRecreateAfterCrash([1000], 1000)).toBe(true);
  });

  it("stops a crash loop inside the window", () => {
    const now = 10_000;
    const times = Array.from({ length: MAX_CRASHES_PER_WINDOW }, (_, i) => now - i);
    expect(shouldRecreateAfterCrash(times, now)).toBe(false);
  });

  it("forgets crashes older than the window", () => {
    const now = CRASH_WINDOW_MS * 10;
    const old = Array.from(
      { length: MAX_CRASHES_PER_WINDOW },
      (_, i) => now - CRASH_WINDOW_MS - 1 - i
    );
    expect(shouldRecreateAfterCrash(old, now)).toBe(true);
  });
});

describe("SINK_CONNECT_DELAYS_MS", () => {
  it("is a bounded, non-decreasing backoff schedule", () => {
    expect(SINK_CONNECT_DELAYS_MS.length).toBeGreaterThan(0);
    for (let i = 1; i < SINK_CONNECT_DELAYS_MS.length; i++) {
      expect(SINK_CONNECT_DELAYS_MS[i]).toBeGreaterThanOrEqual(
        SINK_CONNECT_DELAYS_MS[i - 1]
      );
    }
  });
});
