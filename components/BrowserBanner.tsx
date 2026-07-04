"use client";
import { useEffect, useState } from "react";

// Survives reloads and the CopilotKit provider-key remount (switching provider
// remounts the whole studio subtree, which would otherwise resurrect a
// dismissed banner mid-session). sessionStorage, not localStorage: a new visit
// deserves the heads-up again.
const DISMISS_KEY = "capturia-voice-banner-dismissed";

/**
 * Honest heads-up when the browser can't do voice (Firefox has no Web Speech
 * API, Brave Shields blocks the endpoint, and the desktop build hides it until
 * local whisper is wired). The landing promises "just by talking", so rather
 * than failing silently we explain the limitation and point to typed commands /
 * the desktop app. Dismissable; the studio only mounts it outside Program Output
 * so it never leaks into the captured OBS feed.
 */
export default function BrowserBanner() {
  const [dismissed, setDismissed] = useState(false);
  // Read persisted dismissal in an effect, NOT a lazy initializer: this
  // component is in the prerendered HTML (isSupported starts false), so a
  // sessionStorage read during the first render would mismatch hydration.
  // The one-shot post-hydration setState is the point, hence the disable.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (sessionStorage.getItem(DISMISS_KEY) === "1") setDismissed(true);
    } catch {
      /* storage blocked: banner just reappears per load */
    }
  }, []);
  if (dismissed) return null;
  // Positioning comes from the studio's notice stack, so this banner and
  // ModelKeyBanner can show together without overlapping.
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-400/30 bg-black/70 px-4 py-3 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.4)]">
      <span
        aria-hidden
        className="mt-0.5 h-2 w-2 flex-none rounded-full bg-amber-400"
        style={{ boxShadow: "0 0 8px #fbbf24" }}
      />
      <div className="text-[13px] leading-snug text-white/80">
        <span className="font-semibold text-white">Voice isn&apos;t available in this browser.</span>{" "}
        Web Speech runs in Chrome or Edge (Firefox lacks it; Brave blocks it).
        Typed commands work everywhere, or run the desktop app for on-device voice.
      </div>
      <button
        onClick={() => {
          try {
            sessionStorage.setItem(DISMISS_KEY, "1");
          } catch {
            /* storage blocked: dismissal lasts this mount only */
          }
          setDismissed(true);
        }}
        aria-label="Dismiss"
        className="flex-none rounded-md px-2 py-0.5 text-xs font-medium text-white/50 hover:bg-white/10 hover:text-white/90"
      >
        Dismiss
      </button>
    </div>
  );
}
