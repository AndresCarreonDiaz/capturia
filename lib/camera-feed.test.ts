import { describe, expect, it } from "vitest";
import {
  CAMERA_DEVICE_NAME,
  CRASH_WINDOW_MS,
  FROZEN_AFTER_SECONDS,
  MAX_CRASHES_PER_WINDOW,
  SINK_CONNECT_DELAYS_MS,
  SINK_STALL_SECONDS,
  cameraToggleAction,
  findCameraDevice,
  programOutputUrl,
  shouldRecreateAfterCrash,
  sinkStalledSecond,
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

describe("sinkStalledSecond", () => {
  it("flags a second where nothing enqueued and the queue is pinned full", () => {
    expect(sinkStalledSecond(0, 10, 10)).toBe(true);
  });

  it("is healthy while frames are still being delivered", () => {
    // Even a full queue snapshot is fine if enqueues succeeded this second
    // (the extension may simply be draining a burst).
    expect(sinkStalledSecond(30, 10, 10)).toBe(false);
  });

  it("is healthy while the queue has room", () => {
    // fps 0 with a non-full queue is a paused pump or an empty ring, not a
    // consumer that died.
    expect(sinkStalledSecond(0, 3, 10)).toBe(false);
  });

  it("never trips on a queue that reports zero capacity", () => {
    // Capacity 0 means the queue handle is not live telemetry; treating it
    // as a stall would disconnect a working feed.
    expect(sinkStalledSecond(0, 0, 0)).toBe(false);
  });
});

describe("cameraToggleAction", () => {
  it("stops a running feed", () => {
    expect(cameraToggleAction({ running: true, connecting: false })).toBe("stop");
  });

  it("stops (cancels) a feed that is still connecting", () => {
    // The whole point: the up-to-30s backoff must be cancellable before it
    // turns the camera on mid-call.
    expect(cameraToggleAction({ running: false, connecting: true })).toBe("stop");
  });

  it("starts an idle feed", () => {
    expect(cameraToggleAction({ running: false, connecting: false })).toBe("start");
  });
});

describe("health thresholds", () => {
  it("waits a few seconds before declaring frozen or stalled", () => {
    // 1 second would flap on GC pauses and window recreation; much longer
    // would hide a real freeze from the operator mid-call.
    expect(FROZEN_AFTER_SECONDS).toBeGreaterThanOrEqual(2);
    expect(FROZEN_AFTER_SECONDS).toBeLessThanOrEqual(10);
    expect(SINK_STALL_SECONDS).toBeGreaterThanOrEqual(2);
    expect(SINK_STALL_SECONDS).toBeLessThanOrEqual(10);
  });
});
