"use client";
import { useCallback, useEffect, useState } from "react";
import { normalizeCameraPreference, type CameraPreference } from "@/lib/camera-select";

// The chosen capture camera (issue #12): a persisted {deviceId, label} pair,
// resolved against the live device list at acquisition time
// (lib/camera-select.ts). null means automatic (the physical-input
// heuristic). Desktop persists it in main's settings.json through the
// cameraDevice bridge (the same store as the voice locale); web keeps it in
// localStorage. Writes are optimistic like the locale: the IPC reply
// reconciles, and a rejected invoke must never break the studio.

const STORAGE_KEY = "capturia:camera-device";

export function useCameraDevice(): {
  preference: CameraPreference | null;
  setPreference: (preference: CameraPreference | null) => void;
} {
  // Lazy initial read so web restores without a setState-in-effect cascade.
  // On desktop the bridge read below overwrites this once IPC answers.
  const [preference, setPreferenceState] = useState<CameraPreference | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? normalizeCameraPreference(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    const bridge = window.capturia?.cameraDevice;
    if (!bridge) return;
    let cancelled = false;
    bridge
      .get()
      .then((res) => {
        if (!cancelled && res) setPreferenceState(normalizeCameraPreference(res.preference));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const setPreference = useCallback((next: CameraPreference | null) => {
    const normalized = normalizeCameraPreference(next);
    setPreferenceState(normalized);
    const bridge = window.capturia?.cameraDevice;
    if (bridge) {
      bridge
        .set(normalized)
        .then((res) => {
          if (res) setPreferenceState(normalizeCameraPreference(res.preference));
        })
        .catch(() => {});
      return;
    }
    try {
      if (normalized) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage unavailable: the pick still applies for this session.
    }
  }, []);

  return { preference, setPreference };
}
