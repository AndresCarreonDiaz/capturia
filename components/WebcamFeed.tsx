"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  WEBCAM_ACQUIRE_MAX_ATTEMPTS,
  WEBCAM_ACQUIRE_RETRY_MS,
  WEBCAM_CONTROL_EVENT,
  WEBCAM_PAUSED_FLAG,
  isVirtualSelfCapture,
} from "@/lib/camera-feed";
import {
  CAMERA_PICK_EVENT,
  CAMERA_PICK_FLAG,
  normalizeCameraPreference,
  resolveCameraDevice,
  type CameraPreference,
} from "@/lib/camera-select";

// The physical-webcam layer of the stage. On web it simply captures and
// plays; inside the desktop app, Electron main can pause/resume the capture
// through the WEBCAM_CONTROL_EVENT contract (lib/camera-feed.ts): the
// offscreen camera window is paused when no call app consumes the Capturia
// camera, and the hidden-to-tray Control Room is paused while invisible, so
// the green camera LED never stays lit for an app nobody can see (issue
// #38). While paused, a branded standing-by card takes the video's place;
// overlays keep rendering above it, so the mirror and the frame pump are
// unaffected. The card's pulse is deliberate: it keeps the offscreen
// renderer painting a live (if quiet) frame instead of a stale one.

// The desired-pause state is an external store: the sticky window flag holds
// the value (set by main's injected script BEFORE it dispatches the change
// event; asserted in lib/camera-feed.test.ts), and the control event is the
// change notification. Reading it through useSyncExternalStore makes the
// injection race unlosable by construction: React re-reads the snapshot
// after subscribing, so a control injection landing between the first
// render and the subscription can change the flag but never strand the
// component on a stale value (main also re-asserts a standing pause once a
// second; electron/camera-feed.js).
function readPausedFlag(): boolean {
  if (typeof window === "undefined") return false;
  return (window as unknown as Record<string, unknown>)[WEBCAM_PAUSED_FLAG] === true;
}

function subscribeWebcamControl(onStoreChange: () => void): () => void {
  window.addEventListener(WEBCAM_CONTROL_EVENT, onStoreChange);
  return () => window.removeEventListener(WEBCAM_CONTROL_EVENT, onStoreChange);
}

function serverPausedSnapshot(): boolean {
  return false;
}

// The injected camera pick (issue #12) is a second external store on the
// same contract as the pause flag: main writes the sticky flag, then
// dispatches the event (lib/camera-select.ts). The snapshot returns the RAW
// flag value, whose identity only changes per injection; normalizing here
// would mint a fresh object every read, which useSyncExternalStore treats as
// a change and re-renders on forever.
function readCameraPickFlag(): unknown {
  if (typeof window === "undefined") return null;
  return (window as unknown as Record<string, unknown>)[CAMERA_PICK_FLAG] ?? null;
}

function subscribeCameraPick(onStoreChange: () => void): () => void {
  window.addEventListener(CAMERA_PICK_EVENT, onStoreChange);
  return () => window.removeEventListener(CAMERA_PICK_EVENT, onStoreChange);
}

function serverCameraPickSnapshot(): null {
  return null;
}

const VIDEO_SIZE = { width: { ideal: 1920 }, height: { ideal: 1080 } };

// Capture the operator's picked camera, else a PHYSICAL one, never the
// Capturia virtual camera. With the extension installed, "Capturia" can be
// the browser's default video device, and capturing it would feed the camera
// its own output while registering this page as a permanent consumer
// (lib/camera-feed.ts has the full story). Resolution order lives in
// lib/camera-select.ts: exact deviceId, then label, then the heuristic.
//
// Order matters: the pick happens BEFORE anything is opened, because even a
// brief deviceId-less open of the virtual camera registers this page as a
// consumer and blips the idle machine awake for a full cycle. On the desktop
// app labels are already populated (media permission is granted to the
// studio origin); only when enumeration cannot identify a usable camera
// (web before the first permission grant leaves labels empty) does the
// open-then-fix fallback run.
//
// onResolved fires when the pick resolved under a rotated identity, so the
// caller can persist the fresh {deviceId, label} back to its store.
async function acquirePhysicalWebcam(
  preference: CameraPreference | null,
  onResolved: (updated: CameraPreference) => void
): Promise<MediaStream> {
  const known = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const preferred = resolveCameraDevice(preference, known);
  if (preferred.device) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { ...VIDEO_SIZE, deviceId: { exact: preferred.device.deviceId } },
        audio: false,
      });
      if (preferred.updatedPreference) onResolved(preferred.updatedPreference);
      return stream;
    } catch {
      // The picked device vanished between enumeration and open (unplugged,
      // a Continuity camera dropping off); fall through to the default path.
    }
  }
  const fallback = await navigator.mediaDevices.getUserMedia({
    video: VIDEO_SIZE,
    audio: false,
  });
  const label = fallback.getVideoTracks()[0]?.label ?? "";
  if (!isVirtualSelfCapture(label)) return fallback;
  // Opening the default granted the permission, so labels are populated now
  // and this re-resolve can honor the pick, not just certify a physical one.
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fixed = resolveCameraDevice(preference, devices);
  fallback.getTracks().forEach((t) => t.stop());
  if (!fixed.device) {
    // Showing the loop would masquerade as a working webcam; be honest.
    throw new Error("only the Capturia virtual camera is available");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { ...VIDEO_SIZE, deviceId: { exact: fixed.device.deviceId } },
    audio: false,
  });
  if (fixed.updatedPreference) onResolved(fixed.updatedPreference);
  return stream;
}

interface WebcamFeedProps {
  /**
   * Program-output surfaces (the desktop app's offscreen camera window, a
   * ?out=1 mirror tab) capture as soon as main un-pauses them; the VISIBLE
   * stage instead starts with the camera off and waits for the user. Opening
   * the app to buy Pro or prep a deck must not light the camera LED or fire
   * the OS permission prompt: capture is intent, launch is not.
   */
  autoStart?: boolean;
  /**
   * The operator's persisted camera pick (Settings, issue #12); null means
   * automatic. Resolution happens at acquisition time (lib/camera-select.ts).
   * On pages Electron main drives, the pick arrives through the injected
   * sticky flag instead and outranks this prop: the offscreen Program Output
   * window has no preload, so its prop is at best a stale localStorage read.
   */
  preferredDevice?: CameraPreference | null;
  /**
   * Persist a pick that resolved under a rotated identity (deviceIds rotate
   * across permission scopes) back to whatever store owns the preference.
   */
  onPreferredDeviceResolved?: (preference: CameraPreference) => void;
}

export default function WebcamFeed({
  autoStart = false,
  preferredDevice = null,
  onPreferredDeviceResolved,
}: WebcamFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wanted, setWanted] = useState(autoStart);
  const paused = useSyncExternalStore(
    subscribeWebcamControl,
    readPausedFlag,
    serverPausedSnapshot
  );
  // Bumped on every resume control event: after the retry series below is
  // exhausted, the next consumer attach (a pause/resume transition from
  // main) starts a fresh series instead of leaving a terminal error card.
  const [acquireRequest, setAcquireRequest] = useState(0);
  // Render fence for acquisition success. The stream lands in a REF, and
  // setError(null) while error is ALREADY null is a same-value update React
  // bails out of: no render, so the per-render attach effect below never
  // runs, and a first-try success on an otherwise quiet page (the packaged
  // app's studio) leaves the stage black with the camera LED lit. Dev never
  // showed it because surrounding re-renders always arrived in time.
  const [, setStreamVersion] = useState(0);

  // The effective camera pick: main's injection when it has spoken (the
  // offscreen window, driven through executeJavaScript), else the prop from
  // the settings store. Normalization is memoized on the raw flag's identity.
  const injectedPickRaw = useSyncExternalStore(
    subscribeCameraPick,
    readCameraPickFlag,
    serverCameraPickSnapshot
  );
  const injectedPick = useMemo(() => normalizeCameraPreference(injectedPickRaw), [injectedPickRaw]);
  const preference = injectedPick ?? preferredDevice;
  // Refs so the acquisition series and the devicechange listener read the
  // freshest values without re-running (and re-opening the camera) on
  // every render.
  const preferenceRef = useRef(preference);
  const onResolvedRef = useRef(onPreferredDeviceResolved);
  useEffect(() => {
    preferenceRef.current = preference;
    onResolvedRef.current = onPreferredDeviceResolved;
  }, [preference, onPreferredDeviceResolved]);

  // Re-resolve against the live device list and restart the acquisition
  // series ONLY when the outcome would differ from what is open right now:
  // the current track died (its camera unplugged), or the resolution now
  // lands on the PICKED device and it differs (the pick changed, or the
  // picked camera came back after an unplug fallback). A fallback resolution
  // never re-aims a healthy stream: in Automatic mode a hotplug can change
  // the heuristic winner (a Continuity iPhone appearing mid-call), and
  // yanking the stage to it would blink a camera nobody asked to switch.
  // The same guard keeps an unrelated devicechange (headphones) and the
  // persist-back write (same camera, rotated id) no-ops.
  const reacquireIfChanged = useCallback(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;
    media
      .enumerateDevices()
      .then((devices) => {
        const resolved = resolveCameraDevice(preferenceRef.current, devices);
        const track = streamRef.current?.getVideoTracks()[0];
        const live = track ? track.readyState === "live" : false;
        const currentId = track?.getSettings?.().deviceId;
        const wantsDifferent =
          resolved.source === "preference" &&
          resolved.device !== null &&
          resolved.device.deviceId !== currentId;
        if (live && !wantsDifferent) return;
        if (!streamRef.current && !resolved.device) return;
        setAcquireRequest((n) => n + 1);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onControl = (event: Event) => {
      const detail = (event as CustomEvent<{ paused?: unknown }>).detail;
      if (detail && detail.paused === false) setAcquireRequest((n) => n + 1);
    };
    window.addEventListener(WEBCAM_CONTROL_EVENT, onControl);
    return () => window.removeEventListener(WEBCAM_CONTROL_EVENT, onControl);
  }, []);

  useEffect(() => {
    if (paused || !wanted) return; // hold nothing while paused or off: that IS the feature
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const attempt = (attemptsMade: number) => {
      acquirePhysicalWebcam(preferenceRef.current, (updated) => onResolvedRef.current?.(updated))
        .then((s) => {
          // A pause can land while getUserMedia is in flight; keeping that
          // stream would leave the LED lit with nothing rendering it.
          if (cancelled) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = s;
          setError(null);
          setStreamVersion((n) => n + 1);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(e.message);
          // Bounded retry (never terminal mid-call): the camera often comes
          // back on its own (a Continuity iPhone reattaching, another app
          // releasing the device).
          if (attemptsMade + 1 < WEBCAM_ACQUIRE_MAX_ATTEMPTS) {
            retryTimer = setTimeout(() => attempt(attemptsMade + 1), WEBCAM_ACQUIRE_RETRY_MS);
          }
        });
    };
    attempt(0);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [paused, acquireRequest, wanted]);

  // Unplug/replug resilience (issue #12): re-check the resolution whenever
  // the OS device list changes while capturing. A vanished pick falls back
  // to the heuristic (or, with nothing left, the error card and its bounded
  // retries); a replugged pick takes the stage back.
  useEffect(() => {
    if (paused || !wanted) return;
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return;
    media.addEventListener("devicechange", reacquireIfChanged);
    return () => media.removeEventListener("devicechange", reacquireIfChanged);
  }, [paused, wanted, reacquireIfChanged]);

  // A Settings pick applies live: same guarded re-check, so switching
  // cameras re-aims the active stream while the persist-back write (same
  // camera under a fresh id) stays a no-op. Keyed on the VALUE, and skipped
  // on mount: the acquisition effect owns the first open, and restarting its
  // in-flight series here would double-open the camera.
  const preferenceKey = preference ? `${preference.deviceId}\u0000${preference.label}` : "";
  const lastPreferenceKeyRef = useRef(preferenceKey);
  useEffect(() => {
    if (lastPreferenceKeyRef.current === preferenceKey) return;
    lastPreferenceKeyRef.current = preferenceKey;
    if (paused || !wanted) return;
    reacquireIfChanged();
  }, [preferenceKey, paused, wanted, reacquireIfChanged]);

  // Attach the live stream whenever the <video> is in the tree. Runs on
  // every render on purpose: a retry can succeed while the error card is up
  // (no video element mounted), and the element must pick the stream up as
  // soon as it returns. The assignment is guarded, so this is idempotent.
  useEffect(() => {
    if (videoRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  });

  if (paused) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-neutral-950">
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/90 animate-pulse" aria-hidden />
        <p className="text-neutral-100 text-3xl font-semibold uppercase tracking-[0.4em] pl-[0.4em]">
          Capturia
        </p>
        <p className="text-neutral-500 text-sm font-mono">standing by</p>
      </div>
    );
  }

  if (!wanted) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-neutral-950 px-8 text-center">
        <p className="text-neutral-100 text-2xl font-semibold">Your camera is off</p>
        <p className="max-w-sm text-neutral-500 text-sm leading-relaxed">
          Nothing is captured until you turn it on. Decks, Settings, and
          Capturia Pro all work without it.
        </p>
        <button
          onClick={() => setWanted(true)}
          className="rounded-full border border-white/20 bg-white/10 px-7 py-3 text-[15px] font-medium text-white hover:bg-white/20"
        >
          Go on camera
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-neutral-900">
        <p className="text-red-400 text-sm font-mono">Camera error: {error}</p>
      </div>
    );
  }

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />
      {/* A camera product owes the user an always-visible way OFF the air.
          Flipping wanted unmounts the video and the acquisition cleanup
          stops the tracks, so the LED dies with it. Hidden on program-output
          surfaces (autoStart), which must stay chrome-free. */}
      {!autoStart && (
        <button
          onClick={() => setWanted(false)}
          className="absolute top-4 left-4 z-20 rounded-full bg-black/50 px-3 py-1.5 font-mono text-[12px] tracking-wide text-neutral-300 hover:bg-black/75 hover:text-white"
        >
          camera off
        </button>
      )}
    </>
  );
}
