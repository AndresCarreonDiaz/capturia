import { describe, expect, it } from "vitest";
import {
  CAMERA_DEVICE_NAME,
  CRASH_WINDOW_MS,
  FROZEN_AFTER_SECONDS,
  MAX_CRASHES_PER_WINDOW,
  SINK_CONNECT_DELAYS_MS,
  SINK_STALL_SECONDS,
  WEBCAM_ACQUIRE_MAX_ATTEMPTS,
  WEBCAM_ACQUIRE_RETRY_MS,
  WEBCAM_CONTROL_EVENT,
  WEBCAM_IDLE_AFTER_SECONDS,
  WEBCAM_IDLE_INITIAL,
  WEBCAM_PAUSED_FLAG,
  WEBCAM_RESUME_POLL_MS,
  cameraToggleAction,
  findCameraDevice,
  isVirtualCameraLabel,
  isVirtualSelfCapture,
  pickPhysicalVideoInput,
  programOutputUrl,
  reduceWebcamIdleSecond,
  shouldRecreateAfterCrash,
  sinkStalledSecond,
  webcamControlScript,
  type CameraDevice,
  type WebcamIdleState,
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

describe("physical camera selection", () => {
  const input = (label: string, kind = "videoinput") => ({
    kind,
    label,
    deviceId: `id-${label}`,
  });

  it("flags a track that captured the Capturia virtual camera", () => {
    expect(isVirtualSelfCapture("Capturia")).toBe(true);
    expect(isVirtualSelfCapture("FaceTime HD Camera")).toBe(false);
  });

  it("skips the virtual camera even when the browser prefers it", () => {
    // The feedback-loop case found live: Capturia enumerates as the default
    // video device, so a deviceId-less capture would feed the camera its own
    // output and register the page as a permanent consumer.
    const picked = pickPhysicalVideoInput([
      input("Capturia"),
      input("FaceTime HD Camera"),
      input("Logitech BRIO"),
    ]);
    expect(picked?.label).toBe("FaceTime HD Camera");
  });

  it("denies other virtual cameras, not just Capturia", () => {
    expect(isVirtualCameraLabel("OBS Virtual Camera")).toBe(true);
    expect(isVirtualCameraLabel("Snap Camera")).toBe(true);
    expect(isVirtualCameraLabel("mmhmm Camera")).toBe(true);
    expect(isVirtualCameraLabel("FaceTime HD Camera")).toBe(false);
    const picked = pickPhysicalVideoInput([
      input("OBS Virtual Camera"),
      input("Snap Camera"),
      input("Logitech BRIO"),
    ]);
    expect(picked?.label).toBe("Logitech BRIO");
  });

  it("prefers built-in/FaceTime/Continuity labels over unknown ones", () => {
    // An exotic capture device that wins enumeration order must not beat
    // the camera the user actually points at their face.
    const picked = pickPhysicalVideoInput([
      input("Elgato Cam Link 4K"),
      input("FaceTime HD Camera"),
    ]);
    expect(picked?.label).toBe("FaceTime HD Camera");
    const continuity = pickPhysicalVideoInput([
      input("Weird Capture Thing"),
      input("Andres iPhone Camera"),
    ]);
    expect(continuity?.label).toBe("Andres iPhone Camera");
  });

  it("never picks an unlabeled device", () => {
    // Labels are empty before a capture permission exists, and an unlabeled
    // device cannot be certified non-virtual; callers fall back to the
    // open-then-fix path instead.
    expect(pickPhysicalVideoInput([input("")])).toBeNull();
  });

  it("ignores non-video devices", () => {
    const picked = pickPhysicalVideoInput([
      input("MacBook Pro Microphone", "audioinput"),
      input("FaceTime HD Camera"),
    ]);
    expect(picked?.label).toBe("FaceTime HD Camera");
  });

  it("returns null when the virtual camera is the only camera", () => {
    expect(pickPhysicalVideoInput([input("Capturia")])).toBeNull();
    expect(pickPhysicalVideoInput([])).toBeNull();
  });
});

// Run the 1Hz reducer n times against a constant consumer reading.
const tick = (state: WebcamIdleState, consumers: number, n = 1): WebcamIdleState => {
  for (let i = 0; i < n; i++) state = reduceWebcamIdleSecond(state, consumers);
  return state;
};

describe("reduceWebcamIdleSecond", () => {
  it("stays live while a call app consumes the camera", () => {
    expect(tick(WEBCAM_IDLE_INITIAL, 1, 60)).toEqual(WEBCAM_IDLE_INITIAL);
  });

  it("pauses the webcam after WEBCAM_IDLE_AFTER_SECONDS without a consumer", () => {
    const atThreshold = tick(WEBCAM_IDLE_INITIAL, 0, WEBCAM_IDLE_AFTER_SECONDS);
    expect(atThreshold.paused).toBe(true);
  });

  it("does not pause one second early", () => {
    const justBefore = tick(WEBCAM_IDLE_INITIAL, 0, WEBCAM_IDLE_AFTER_SECONDS - 1);
    expect(justBefore.paused).toBe(false);
  });

  it("resets the countdown when a consumer returns mid-count", () => {
    const counting = tick(WEBCAM_IDLE_INITIAL, 0, WEBCAM_IDLE_AFTER_SECONDS - 2);
    expect(tick(counting, 1)).toEqual(WEBCAM_IDLE_INITIAL);
  });

  it("resumes immediately when a consumer attaches while paused", () => {
    // This is the fast-poll resume path: one non-zero reading unpauses.
    const paused = tick(WEBCAM_IDLE_INITIAL, 0, WEBCAM_IDLE_AFTER_SECONDS + 30);
    expect(paused.paused).toBe(true);
    expect(tick(paused, 2)).toEqual(WEBCAM_IDLE_INITIAL);
  });

  it("stays paused while nobody consumes", () => {
    const paused = tick(WEBCAM_IDLE_INITIAL, 0, WEBCAM_IDLE_AFTER_SECONDS);
    expect(tick(paused, 0, 300).paused).toBe(true);
  });

  it("fails safe on an unknown consumer count (old extension, read failure)", () => {
    // A webcam that never idles is the pre-fix behavior; one that wrongly
    // idles would blank the presenter out of a live call.
    expect(tick(WEBCAM_IDLE_INITIAL, -1, 60)).toEqual(WEBCAM_IDLE_INITIAL);
    const paused = tick(WEBCAM_IDLE_INITIAL, 0, WEBCAM_IDLE_AFTER_SECONDS);
    expect(tick(paused, -1).paused).toBe(false);
  });

  it("keeps the idle window long enough to ride out a camera re-pick", () => {
    expect(WEBCAM_IDLE_AFTER_SECONDS).toBeGreaterThanOrEqual(5);
    expect(WEBCAM_IDLE_AFTER_SECONDS).toBeLessThanOrEqual(30);
    // The resume poll must land a consumer well inside the 2s live target.
    expect(WEBCAM_RESUME_POLL_MS).toBeLessThanOrEqual(1000);
  });

  it("bounds the acquisition retry to roughly half a minute of trying", () => {
    // Retries exist so one failed getUserMedia (a Continuity iPhone not
    // reattached yet) never pins a terminal error card into a live call;
    // the bound exists so an unplugged camera does not poll forever.
    const totalMs = WEBCAM_ACQUIRE_RETRY_MS * (WEBCAM_ACQUIRE_MAX_ATTEMPTS - 1);
    expect(WEBCAM_ACQUIRE_RETRY_MS).toBeGreaterThanOrEqual(1000);
    expect(totalMs).toBeGreaterThanOrEqual(10_000);
    expect(totalMs).toBeLessThanOrEqual(60_000);
  });
});

describe("webcamControlScript", () => {
  it("sets the sticky flag and dispatches the control event", () => {
    const script = webcamControlScript(true);
    expect(script).toContain(`window.${WEBCAM_PAUSED_FLAG} = true`);
    expect(script).toContain(JSON.stringify(WEBCAM_CONTROL_EVENT));
    expect(script).toContain("paused: true");
  });

  it("writes the flag BEFORE dispatching the event", () => {
    // WebcamFeed's mount-time reconciliation depends on this order: an
    // injection landing between the initial render's flag read and the
    // listener attaching loses the EVENT, and re-reading the flag after
    // addEventListener only closes that race if the flag was already
    // written when the event fired.
    for (const paused of [true, false]) {
      const script = webcamControlScript(paused);
      expect(script.indexOf(WEBCAM_PAUSED_FLAG)).toBeGreaterThanOrEqual(0);
      expect(script.indexOf(WEBCAM_PAUSED_FLAG)).toBeLessThan(script.indexOf("dispatchEvent"));
    }
  });

  it("drives both directions", () => {
    const script = webcamControlScript(false);
    expect(script).toContain(`window.${WEBCAM_PAUSED_FLAG} = false`);
    expect(script).toContain("paused: false");
  });

  it("evaluates cleanly and reaches a page-world listener", () => {
    // Simulate the executeJavaScript environment: a window global with
    // addEventListener/dispatchEvent and the DOM CustomEvent constructor.
    const seen: Array<{ paused?: boolean }> = [];
    const listeners: Array<(e: { detail?: { paused?: boolean } }) => void> = [];
    const fakeWindow: Record<string, unknown> = {
      dispatchEvent: (e: { detail?: { paused?: boolean } }) => {
        listeners.forEach((fn) => fn(e));
        return true;
      },
    };
    listeners.push((e) => seen.push(e.detail ?? {}));
    class FakeCustomEvent {
      detail?: { paused?: boolean };
      constructor(_type: string, init?: { detail?: { paused?: boolean } }) {
        this.detail = init?.detail;
      }
    }
    const run = new Function("window", "CustomEvent", webcamControlScript(true));
    expect(run(fakeWindow, FakeCustomEvent)).toBeUndefined();
    expect(fakeWindow[WEBCAM_PAUSED_FLAG]).toBe(true);
    expect(seen).toEqual([{ paused: true }]);
  });
});
