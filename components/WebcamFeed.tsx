"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  WEBCAM_ACQUIRE_MAX_ATTEMPTS,
  WEBCAM_ACQUIRE_RETRY_MS,
  WEBCAM_CONTROL_EVENT,
  WEBCAM_PAUSED_FLAG,
  isVirtualSelfCapture,
  pickPhysicalVideoInput,
} from "@/lib/camera-feed";

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

const VIDEO_SIZE = { width: { ideal: 1920 }, height: { ideal: 1080 } };

// Capture a PHYSICAL camera, never the Capturia virtual camera. With the
// extension installed, "Capturia" can be the browser's default video device,
// and capturing it would feed the camera its own output while registering
// this page as a permanent consumer (lib/camera-feed.ts has the full story).
//
// Order matters: the pick happens BEFORE anything is opened, because even a
// brief deviceId-less open of the virtual camera registers this page as a
// consumer and blips the idle machine awake for a full cycle. On the desktop
// app labels are already populated (media permission is granted to the
// studio origin); only when enumeration cannot identify a physical camera
// (web before the first permission grant leaves labels empty) does the
// open-then-fix fallback run.
async function acquirePhysicalWebcam(): Promise<MediaStream> {
  const known = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const preferred = pickPhysicalVideoInput(known);
  if (preferred) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { ...VIDEO_SIZE, deviceId: { exact: preferred.deviceId } },
        audio: false,
      });
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
  const devices = await navigator.mediaDevices.enumerateDevices();
  const physical = pickPhysicalVideoInput(devices);
  fallback.getTracks().forEach((t) => t.stop());
  if (!physical) {
    // Showing the loop would masquerade as a working webcam; be honest.
    throw new Error("only the Capturia virtual camera is available");
  }
  return navigator.mediaDevices.getUserMedia({
    video: { ...VIDEO_SIZE, deviceId: { exact: physical.deviceId } },
    audio: false,
  });
}

export default function WebcamFeed() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paused = useSyncExternalStore(
    subscribeWebcamControl,
    readPausedFlag,
    serverPausedSnapshot
  );
  // Bumped on every resume control event: after the retry series below is
  // exhausted, the next consumer attach (a pause/resume transition from
  // main) starts a fresh series instead of leaving a terminal error card.
  const [acquireRequest, setAcquireRequest] = useState(0);

  useEffect(() => {
    const onControl = (event: Event) => {
      const detail = (event as CustomEvent<{ paused?: unknown }>).detail;
      if (detail && detail.paused === false) setAcquireRequest((n) => n + 1);
    };
    window.addEventListener(WEBCAM_CONTROL_EVENT, onControl);
    return () => window.removeEventListener(WEBCAM_CONTROL_EVENT, onControl);
  }, []);

  useEffect(() => {
    if (paused) return; // hold nothing while paused: that IS the feature
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const attempt = (attemptsMade: number) => {
      acquirePhysicalWebcam()
        .then((s) => {
          // A pause can land while getUserMedia is in flight; keeping that
          // stream would leave the LED lit with nothing rendering it.
          if (cancelled) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = s;
          setError(null);
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
  }, [paused, acquireRequest]);

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

  if (error) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-neutral-900">
        <p className="text-red-400 text-sm font-mono">Camera error: {error}</p>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      className="absolute inset-0 w-full h-full object-cover"
    />
  );
}
