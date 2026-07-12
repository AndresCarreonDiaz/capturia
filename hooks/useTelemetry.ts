"use client";
import { useEffect, useState } from "react";

// The desktop telemetry toggle (electron/telemetry.js via the preload
// bridge). `supported` is false on web, on a stale preload, and until the
// first read lands, so both surfaces that render the toggle (Settings,
// onboarding) can simply hide it when there is nothing to toggle. Writes are
// optimistic; the IPC reply reconciles, and a rejected invoke must never
// break the studio.
export function useTelemetry(): {
  supported: boolean;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
} {
  const [state, setState] = useState<boolean | null>(null);

  useEffect(() => {
    const bridge = window.capturia?.telemetry;
    if (!bridge) return;
    let cancelled = false;
    bridge
      .get()
      .then((s) => {
        if (!cancelled && s) setState(s.enabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = (enabled: boolean) => {
    setState(enabled);
    window.capturia?.telemetry
      ?.set(enabled)
      .then((s) => {
        if (s) setState(s.enabled);
      })
      .catch(() => {});
  };

  return { supported: state !== null, enabled: state ?? true, setEnabled };
}
