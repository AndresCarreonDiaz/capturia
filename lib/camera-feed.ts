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
