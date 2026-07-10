"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  onboardingSteps,
  shouldShowOnboarding,
  type OnboardingContext,
} from "@/lib/onboarding";

const STORAGE_KEY = "capturia:onboarded";

// localStorage read as an external store: hydration-safe (the server
// snapshot says "completed" so nothing flashes during SSR) without a
// setState-in-effect. The value only changes via finish(), tracked in state.
const subscribeNoop = () => () => {};
const readCompleted = () => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return true; // storage unavailable: stay out of the way
  }
};

/**
 * First-run coach for the desktop Control Room. Deliberately NOT a modal:
 * the whole point of the welcome and voice steps is that the live stage
 * stays visible behind it ("this is what your audience sees"), and the
 * voice step needs the hotkey and feed interactive. Renders as a floating
 * card in the operator-chrome layer, so Program Output never captures it.
 *
 * Steps come from lib/onboarding.ts. A step whose isSatisfied() flips true
 * (key saved, first overlay landed) celebrates briefly and advances on its
 * own; everything else advances by click. Completion persists to
 * localStorage so the flow runs once per install.
 */
export default function OnboardingFlow({
  ctx,
  onOpenSettings,
  onInstallCamera,
}: {
  ctx: OnboardingContext;
  onOpenSettings: () => void;
  // Fires the camera-extension activation request in main (desktop only; the
  // camera step is filtered out wherever this could dead-end).
  onInstallCamera?: () => void;
}) {
  const initiallyCompleted = useSyncExternalStore(subscribeNoop, readCompleted, () => true);
  const [finished, setFinished] = useState(false);
  // Session-scoped progress: toggling Program Output unmounts all operator
  // chrome including this card, and losing the step would restart the tour
  // from the top. A fresh launch (new session) still starts clean.
  const [stepIndex, setStepIndexState] = useState(() => {
    if (typeof window === "undefined") return 0;
    try {
      return Number(window.sessionStorage.getItem(`${STORAGE_KEY}:step`)) || 0;
    } catch {
      return 0;
    }
  });
  const setStepIndex = (update: (i: number) => number) => {
    setStepIndexState((i) => {
      const next = update(i);
      try {
        window.sessionStorage.setItem(`${STORAGE_KEY}:step`, String(next));
      } catch {
        // Progress just will not survive an output-mode round trip.
      }
      return next;
    });
  };
  const completed = initiallyCompleted || finished;

  // Steps are fixed for the life of the flow; satisfaction drives
  // advancement, never membership (the keys step must not vanish mid-flow
  // the moment a key lands). The camera dependency is presence-shaped for
  // the same reason: the step joins once the bridge reports a usable status
  // and never drops out as that status moves through install/approval.
  const cameraStepShown =
    ctx.cameraExtension !== undefined && ctx.cameraExtension !== "unsupported";
  const steps = useMemo(
    () => onboardingSteps(ctx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx.isDesktop, ctx.voiceSupported, cameraStepShown]
  );

  const step = steps[Math.min(stepIndex, steps.length - 1)];
  // Derived, not state: while true the card shows its success copy, and the
  // effect below schedules the advance. The next step renders unsatisfied,
  // so the copy resets on its own.
  const satisfied = Boolean(step && step.isSatisfied(ctx));

  // Keyed on the step too, not just satisfaction: if the NEXT step is
  // already satisfied when this one advances (say a key exists and an
  // overlay already rendered), `satisfied` never flips false and an effect
  // keyed only on it would never arm the next timer, stranding the card on
  // its success copy with no button.
  useEffect(() => {
    if (!satisfied) return;
    const timer = setTimeout(() => setStepIndex((i) => i + 1), 1600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [satisfied, stepIndex]);

  if (completed || !shouldShowOnboarding(ctx, completed) || !step) return null;

  const finish = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // If storage fails the flow reappears next launch; harmless.
    }
    setFinished(true);
  };

  const primaryAction = () => {
    if (step.id === "keys") onOpenSettings();
    else if (step.id === "camera") onInstallCamera?.();
    else if (stepIndex >= steps.length - 1) finish();
    else setStepIndex((i) => i + 1);
  };

  // Live copy that replaces the static body while the world is mid-change
  // (extension installing, System Settings approval pending). While it shows,
  // the primary button hides: the step advances on its own, and re-firing the
  // install under a pending request would only confuse the OS flow.
  const liveBody = !satisfied && step.dynamicBody ? step.dynamicBody(ctx) : null;

  return (
    // bottom-28 clears the full-width CommandBar (bottom-0) and the caption
    // strip (bottom-20, centered, pointer-events-none); left side is free
    // (CueDeck is top-left, the vote QR is bottom-right).
    <div className="absolute bottom-28 left-8 z-40 w-[340px] pointer-events-auto">
      <div className="bg-black/85 border border-white/15 rounded-2xl shadow-[0_0_60px_rgba(0,0,0,0.7)] backdrop-blur-md overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-4">
          <span className="text-white/40 text-xs font-mono uppercase tracking-[0.2em]">
            Getting started
          </span>
          <div className="flex gap-1.5" aria-label={`Step ${stepIndex + 1} of ${steps.length}`}>
            {steps.map((s, i) => (
              <span
                key={s.id}
                className={`h-1.5 w-1.5 rounded-full transition-colors ${
                  i <= stepIndex ? "bg-cyan-400" : "bg-white/20"
                }`}
              />
            ))}
          </div>
        </div>

        <div className="px-5 py-4">
          <h3 className="text-white text-sm font-semibold mb-1.5">
            {satisfied ? "Nice." : step.title}
          </h3>
          <p className="text-white/60 text-xs leading-relaxed">
            {satisfied && step.id === "voice"
              ? "That is the whole loop: you talk, your feed answers."
              : satisfied && step.id === "camera"
              ? "Camera installed. Pick “Capturia” in any call app."
              : satisfied
              ? "Key saved. You are live on your own model."
              : liveBody ?? step.body}
          </p>
        </div>

        <div className="flex items-center justify-between px-5 pb-4">
          <button
            onClick={finish}
            className="text-white/35 hover:text-white/70 text-xs font-mono tracking-wider transition-colors"
          >
            Skip tour
          </button>
          {!satisfied && !liveBody && (
            <button
              onClick={primaryAction}
              className="px-4 py-1.5 rounded-lg bg-cyan-400/15 border border-cyan-400/40 text-cyan-200 hover:bg-cyan-400/25 text-xs font-medium transition-all"
            >
              {step.cta}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
