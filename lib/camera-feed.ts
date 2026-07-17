// Pure model for the desktop virtual-camera feed: every decision in
// electron/camera-feed.js that does not need Electron itself lives here, so it
// is unit-testable and shared through the electron/gen build like the other
// main-process libs (the tray-menu pattern).

// The CMIO device the Capturia camera extension publishes. The sink client in
// native/capturia-frames matches on this exact name (or the device UID).
export const CAMERA_DEVICE_NAME = "Capturia";

// The published camera format. Must match the extension's advertised
// 1920x1080@30 BGRA stream format; the offscreen window renders at exactly
// this size so no scaling happens anywhere in the pipeline.
export const CAMERA_WIDTH = 1920;
export const CAMERA_HEIGHT = 1080;
export const CAMERA_FPS = 30;

// Bounded backoff for the discovery + sink-connect loop. At cold login the
// extension can enumerate a few seconds late, and right after approval the
// sink stream may refuse the first connect; retrying through this schedule
// self-heals both without ever spinning forever (about 30s total).
export const SINK_CONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

// Page-load retries walk the same schedule, but a load failure is usually a
// dev server that is not up yet (or died), which CAN come back. After the
// schedule is exhausted the feed releases the sink (so the extension's splash
// resumes instead of a black or stale frozen frame) and keeps retrying at
// this cadence for as long as the camera stays wanted.
export const LOAD_RETRY_MAX_DELAY_MS = 15_000;

// Crash-loop guard for the offscreen renderer: recreate freely on an isolated
// crash, but stop the feed when the Program Output page is crash-looping.
export const CRASH_WINDOW_MS = 60_000;
export const MAX_CRASHES_PER_WINDOW = 5;

// Consecutive zero-paint seconds after which a running feed reports itself
// frozen: the pump keeps repeating the last ring frame, so viewers see a
// freeze, and the state must say so instead of a healthy-looking "On".
export const FROZEN_AFTER_SECONDS = 3;

// Consecutive stalled seconds (nothing enqueued while the queue sits pinned
// at capacity) after which the feed assumes another sink client stole the
// extension's consume loop and reconnects through the normal backoff.
export const SINK_STALL_SECONDS = 3;

// How long the offscreen Program Output page keeps its physical-webcam
// capture after the last call app stops consuming the Capturia camera
// (issue #38: a green camera LED with no visible app reads as spyware).
// Long enough to ride out a camera re-pick or a brief app switch, short
// enough that the LED goes dark soon after the call ends.
export const WEBCAM_IDLE_AFTER_SECONDS = 10;

// While the webcam capture is idled, the feed polls the consumer count this
// often, so a call app picking Capturia gets live video back well inside the
// 2s budget (poll latency + getUserMedia reacquisition).
export const WEBCAM_RESUME_POLL_MS = 250;

// The DOM contract through which Electron main drives a studio page's webcam
// capture (components/WebcamFeed.tsx implements the page side). Injected via
// webContents.executeJavaScript because the offscreen Program Output window
// deliberately has no preload (see electron/camera-feed.js): the window flag
// makes the desired state sticky across the injection/React-mount race, and
// the event flips a page that is already mounted.
export const WEBCAM_CONTROL_EVENT = "capturia:webcam";
export const WEBCAM_PAUSED_FLAG = "__capturiaWebcamPaused";

// Webcam acquisition retry: one failed getUserMedia on resume (a Continuity
// iPhone not reattached yet, the camera briefly held by another process)
// must never pin a terminal error card into a live call. The page retries
// every WEBCAM_ACQUIRE_RETRY_MS up to WEBCAM_ACQUIRE_MAX_ATTEMPTS (~30s of
// trying), then holds the error card until the next control transition (in
// practice: the next consumer attach) starts a fresh series.
export const WEBCAM_ACQUIRE_RETRY_MS = 2000;
export const WEBCAM_ACQUIRE_MAX_ATTEMPTS = 15;

// One CMIO device as reported by the native addon's listDevices().
export interface CameraDevice {
  id: number;
  name: string;
  uid: string;
  streams: number;
}

// The camera-feed state surfaced over IPC (camera:state), pushed on the
// "camera" channel, and mirrored to the tray. fps counts frames delivered to
// the extension sink in the last full second (0 while stopped, ~30 while
// healthy); paintFps counts offscreen paints the same way, so running with
// paintFps 0 means the camera is repeating a frozen frame.
export interface CameraFeedState {
  // The Capturia camera extension enumerates with both of its streams.
  available: boolean;
  // Sink connected and the pump timer is delivering frames.
  running: boolean;
  // The feed is wanted but not running yet: loading the Program Output page,
  // walking the connect backoff, or between load retries.
  connecting: boolean;
  // Running, but the page has painted nothing for FROZEN_AFTER_SECONDS.
  frozen: boolean;
  // Successful sink deliveries in the last full second.
  fps: number;
  // Offscreen page paints in the last full second.
  paintFps: number;
  // Epoch ms of the most recent offscreen paint; null before the first one.
  lastPaintAt: number | null;
  // Total frames delivered to the extension sink since connect.
  pumped: number;
  // Pump ticks dropped because the sink queue was full.
  droppedQueueFull: number;
  // The offscreen page was told to release the physical webcam because no
  // call app consumed the Capturia camera for WEBCAM_IDLE_AFTER_SECONDS; the
  // pump keeps delivering the page's "standing by" card.
  webcamIdle: boolean;
  // Why the feed is degraded or stopped (null while healthy).
  error: string | null;
}

// Find the Capturia device among the enumerated CMIO devices. It needs both
// streams (source + sink): a single-stream match is a half-initialized
// extension the host cannot feed yet.
export function findCameraDevice(devices: CameraDevice[]): CameraDevice | null {
  return (
    devices.find((d) => d.name === CAMERA_DEVICE_NAME && d.streams >= 2) ?? null
  );
}

// Program Output URL for the offscreen window: the exact studio URL the main
// window loads plus the ?out=1 flag (the chrome-free view). Tolerates a URL
// that already carries a query string.
export function programOutputUrl(studioUrl: string): string {
  return studioUrl + (studioUrl.includes("?") ? "&" : "?") + "out=1";
}

// Should the feed recreate the offscreen window after a renderer crash, given
// the timestamps of the crashes seen so far this run?
export function shouldRecreateAfterCrash(
  crashTimesMs: number[],
  nowMs: number
): boolean {
  const recent = crashTimesMs.filter((t) => nowMs - t < CRASH_WINDOW_MS);
  return recent.length < MAX_CRASHES_PER_WINDOW;
}

// One second of pump telemetry reads as stalled when nothing could be
// enqueued while the queue sat pinned at capacity: the extension (which
// normally drains within a frame) has stopped consuming, i.e. another sink
// client stole the consume loop or the extension restarted underneath us.
export function sinkStalledSecond(
  fps: number,
  queueCount: number,
  queueCapacity: number
): boolean {
  return fps === 0 && queueCapacity > 0 && queueCount >= queueCapacity;
}

// Route a camera toggle click on INTENT, not on `running` alone: a feed that
// is still connecting (the up-to-30s backoff, or background load retries)
// must be cancellable before it turns the camera on mid-call.
export function cameraToggleAction(
  state: Pick<CameraFeedState, "running" | "connecting">
): "stop" | "start" {
  return state.running || state.connecting ? "stop" : "start";
}

// The studio page must NEVER capture the Capturia camera itself: with the
// extension installed, the virtual camera can become the browser's DEFAULT
// video device, and a deviceId-less getUserMedia then feeds the camera its
// own output (a feedback loop) while holding the source stream open, which
// reads as a permanent consumer and defeats the webcam idle machine below
// (found live while verifying issue #38 on this machine).
export function isVirtualSelfCapture(trackLabel: string): boolean {
  return trackLabel.includes(CAMERA_DEVICE_NAME);
}

// Label patterns of virtual cameras other apps publish. Excluding only
// Capturia would let OBS/Snap/mmhmm win the enumeration order and put a
// second synthetic feed on the published camera. Heuristic by nature; the
// real fix is a user-facing camera selector (deferred, tracked on the
// hardening list in issue #12).
const VIRTUAL_CAMERA_LABEL_PATTERNS = [
  CAMERA_DEVICE_NAME.toLowerCase(),
  "virtual", // "OBS Virtual Camera", "Snap Virtual...", e2eSoft-style names
  "snap camera",
  "manycam",
  "mmhmm",
  "camtwist",
  "wirecast",
  "xsplit",
  "streamlabs",
];

export function isVirtualCameraLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return VIRTUAL_CAMERA_LABEL_PATTERNS.some((pattern) => lower.includes(pattern));
}

// Labels that strongly suggest a real, user-facing camera; preferred over
// unknown labels so an exotic capture device never beats the built-in one.
const PHYSICAL_CAMERA_LABEL_HINTS = ["facetime", "built-in", "integrated", "iphone", "ipad"];

// The subset of MediaDeviceInfo the picker needs (pure for tests).
export interface VideoInputInfo {
  kind: string;
  label: string;
  deviceId: string;
}

// The camera the studio should capture: a LABELED video input that is not a
// known virtual camera, preferring built-in/FaceTime/Continuity labels over
// unknown ones, browser order breaking ties. Unlabeled devices are excluded
// on purpose: labels are only empty before a capture permission exists, and
// an unlabeled device cannot be certified non-virtual (the caller falls back
// to open-then-fix in that case). Returns null when no physical camera can
// be identified.
export function pickPhysicalVideoInput(devices: VideoInputInfo[]): VideoInputInfo | null {
  const cameras = devices.filter(
    (d) => d.kind === "videoinput" && d.label !== "" && !isVirtualCameraLabel(d.label)
  );
  return (
    cameras.find((d) =>
      PHYSICAL_CAMERA_LABEL_HINTS.some((hint) => d.label.toLowerCase().includes(hint))
    ) ??
    cameras[0] ??
    null
  );
}

// The webcam idle machine: whether the offscreen page should be holding its
// physical-webcam capture, driven by the extension's consumer count.
export interface WebcamIdleState {
  // Consecutive whole seconds with zero consumers.
  idleSeconds: number;
  // The page has been told to release the webcam (LED off).
  paused: boolean;
}

export const WEBCAM_IDLE_INITIAL: WebcamIdleState = { idleSeconds: 0, paused: false };

// Boot and teardown state: PAUSED, so a mere app launch never lights the
// camera LED. The webcam engages only when something real happens: a call
// app attaches to the virtual camera (the resume poll sees consumers > 0,
// or an unknown count from an old extension, and flips live within
// WEBCAM_RESUME_POLL_MS). idleSeconds sits pre-saturated because this state
// IS the idle steady-state, just reached without the 10s grace.
export const WEBCAM_IDLE_BOOT: WebcamIdleState = {
  idleSeconds: WEBCAM_IDLE_AFTER_SECONDS,
  paused: true,
};

// One 1Hz step of the webcam idle machine. `consumers` is the extension's
// source-client count (the addon's sinkConsumers()): 0 means no call app is
// consuming the virtual camera right now; NEGATIVE means unknown (the enabled
// extension predates the 'ccon' property, the read failed, or the sink is not
// connected). Unknown fails SAFE to "assume watched": a webcam that never
// idles is merely the old behavior, while one that wrongly idles would blank
// the presenter out of a live call. Any non-zero reading also RESUMES a
// paused capture immediately, which is the fast-poll resume path.
export function reduceWebcamIdleSecond(
  prev: WebcamIdleState,
  consumers: number
): WebcamIdleState {
  if (consumers !== 0) return WEBCAM_IDLE_INITIAL;
  const idleSeconds = prev.idleSeconds + 1;
  return {
    idleSeconds,
    paused: prev.paused || idleSeconds >= WEBCAM_IDLE_AFTER_SECONDS,
  };
}

// The statement main injects (webContents.executeJavaScript) to drive a
// studio page's webcam capture: sets the sticky flag, then dispatches the
// control event for pages that are already mounted. Ends in `void 0` so the
// injection resolves to undefined (nothing structured-clones back).
export function webcamControlScript(paused: boolean): string {
  const flag = paused ? "true" : "false";
  return (
    `window.${WEBCAM_PAUSED_FLAG} = ${flag};` +
    `window.dispatchEvent(new CustomEvent(${JSON.stringify(WEBCAM_CONTROL_EVENT)}, ` +
    `{ detail: { paused: ${flag} } }));` +
    `void 0;`
  );
}
