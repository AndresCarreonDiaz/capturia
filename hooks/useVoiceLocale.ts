"use client";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_VOICE_LOCALE, normalizeVoiceLocale } from "@/lib/voice-locale";

// The chosen speech-recognition language (issue #53): one canonical BCP-47
// tag from the curated list in lib/voice-locale.ts. Desktop persists it in
// main's settings.json through the voiceLocale bridge (the same store as the
// telemetry consent); web keeps it in localStorage. Writes are optimistic
// like the telemetry toggle: the IPC reply reconciles, and a rejected invoke
// must never break the studio.

const STORAGE_KEY = "capturia:voice-locale";

export function useVoiceLocale(): {
  locale: string;
  setLocale: (tag: string) => void;
} {
  // Lazy initial read so web restores without a setState-in-effect cascade.
  // Nothing renders the locale before the modal opens, so the SSR default
  // hydrating into the stored value cannot produce a visible mismatch. On
  // desktop the bridge read below overwrites this once IPC answers.
  const [locale, setLocaleState] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_VOICE_LOCALE;
    try {
      return normalizeVoiceLocale(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      return DEFAULT_VOICE_LOCALE;
    }
  });

  useEffect(() => {
    const bridge = window.capturia?.voiceLocale;
    if (!bridge) return;
    let cancelled = false;
    bridge
      .get()
      .then((res) => {
        if (!cancelled && res) setLocaleState(normalizeVoiceLocale(res.locale));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocale = useCallback((tag: string) => {
    const next = normalizeVoiceLocale(tag);
    setLocaleState(next);
    const bridge = window.capturia?.voiceLocale;
    if (bridge) {
      bridge
        .set(next)
        .then((res) => {
          if (res) setLocaleState(normalizeVoiceLocale(res.locale));
        })
        .catch(() => {});
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the pick still applies for this session.
    }
  }, []);

  return { locale, setLocale };
}
