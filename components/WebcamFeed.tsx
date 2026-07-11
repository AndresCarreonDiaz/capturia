"use client";
import { useEffect, useRef, useState } from "react";
import {
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

// Read the sticky flag main injects alongside the control event; it covers
// pauses applied before this component mounted (page reloads while hidden).
function initiallyPaused(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as Record<string, unknown>)[WEBCAM_PAUSED_FLAG] === true
  );
}

const VIDEO_SIZE = { width: { ideal: 1920 }, height: { ideal: 1080 } };

// Capture a PHYSICAL camera, never the Capturia virtual camera. With the
// extension installed, "Capturia" can be the browser's default video device,
// and capturing it would feed the camera its own output while registering
// this page as a permanent consumer (lib/camera-feed.ts has the full story).
// The default acquisition happens first so device labels are populated for
// the re-pick (labels are empty before a capture permission is granted).
async function acquirePhysicalWebcam(): Promise<MediaStream> {
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
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState<boolean>(initiallyPaused);

  useEffect(() => {
    const onControl = (event: Event) => {
      const detail = (event as CustomEvent<{ paused?: unknown }>).detail;
      if (detail && typeof detail.paused === "boolean") setPaused(detail.paused);
    };
    window.addEventListener(WEBCAM_CONTROL_EVENT, onControl);
    return () => window.removeEventListener(WEBCAM_CONTROL_EVENT, onControl);
  }, []);

  useEffect(() => {
    if (paused) return; // hold nothing while paused: that IS the feature
    let cancelled = false;
    let stream: MediaStream | undefined;
    acquirePhysicalWebcam()
      .then((s) => {
        // A pause can land while getUserMedia is in flight; keeping that
        // stream would leave the LED lit with nothing rendering it.
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        setError(null);
        if (videoRef.current) {
          videoRef.current.srcObject = s;
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [paused]);

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
