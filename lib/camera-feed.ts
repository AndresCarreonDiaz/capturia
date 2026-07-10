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

// Crash-loop guard for the offscreen renderer: recreate freely on an isolated
// crash, but stop the feed when the Program Output page is crash-looping.
export const CRASH_WINDOW_MS = 60_000;
export const MAX_CRASHES_PER_WINDOW = 5;

// One CMIO device as reported by the native addon's listDevices().
export interface CameraDevice {
  id: number;
  name: string;
  uid: string;
  streams: number;
}

// The camera-feed state surfaced over IPC (camera:state) and mirrored to the
// tray. fps counts frames delivered to the extension sink in the last full
// second, so it reads 0 while stopped and ~30 while healthy.
export interface CameraFeedState {
  // The Capturia camera extension enumerates with both of its streams.
  available: boolean;
  // Sink connected and the pump timer is delivering frames.
  running: boolean;
  // Successful sink deliveries in the last full second.
  fps: number;
  // Total frames delivered to the extension sink since connect.
  pumped: number;
  // Pump ticks dropped because the sink queue was full.
  droppedQueueFull: number;
  // Why the feed is not running, when it is not (null while healthy).
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
