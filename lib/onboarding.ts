// Pure model for the first-run onboarding flow. The component
// (components/OnboardingFlow.tsx) renders whatever this returns; keeping the
// step composition and advance rules here makes the flow unit-testable
// without React. The audience for the copy is people who talk, not code:
// every step is one action, no jargon.

export interface OnboardingContext {
  isDesktop: boolean;
  hasKeys: boolean;
  voiceSupported: boolean;
  overlayCount: number;
}

export type OnboardingStepId = "welcome" | "keys" | "voice" | "golive";

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  body: string;
  // Primary button label. "keys" opens Settings; everything else advances.
  cta: string;
  // True once the world-state this step asks for exists, letting the
  // component celebrate and advance without a click.
  isSatisfied: (ctx: OnboardingContext) => boolean;
}

const ALL_STEPS: OnboardingStep[] = [
  {
    id: "welcome",
    title: "Welcome to Capturia",
    body:
      "Talk normally on any call and Capturia renders visuals over your camera feed. " +
      "This dark stage is your live preview: everything on it is exactly what your audience sees.",
    cta: "Show me",
    isSatisfied: () => false,
  },
  {
    id: "keys",
    title: "Connect your AI key",
    body:
      "Capturia runs on your own key (free tier). It is stored encrypted in the macOS Keychain " +
      "and never sent to a Capturia server.",
    cta: "Add a key",
    isSatisfied: (ctx) => ctx.hasKeys,
  },
  {
    id: "voice",
    title: "Try your first command",
    body:
      'Press ⌘⌥Space and say: "show a live counter of 500 viewers". ' +
      "Pause, and watch it land on your feed. Capturia keeps listening " +
      "until you press it again.",
    cta: "Skip this",
    isSatisfied: (ctx) => ctx.overlayCount > 0,
  },
  {
    id: "golive",
    title: "Use it in a call",
    body:
      "In Zoom or Meet, share this window to broadcast the stage. " +
      "The native Capturia camera (pick it like any webcam) is on the way.",
    cta: "Finish",
    isSatisfied: () => false,
  },
];

// Steps applicable to this session. Key setup is skipped when a key already
// exists; the voice step is skipped when no speech engine is available (the
// CommandBar still works, but a voice-first tutorial would dead-end).
export function onboardingSteps(ctx: OnboardingContext): OnboardingStep[] {
  return ALL_STEPS.filter((step) => {
    if (step.id === "keys") return !ctx.hasKeys;
    if (step.id === "voice") return ctx.voiceSupported;
    return true;
  });
}

// Whether the flow should show at all: desktop only (the web studio is a
// self-serve demo; coaching a drive-by visitor is noise) and never once
// completed. `completed` is the persisted flag the component owns.
export function shouldShowOnboarding(ctx: OnboardingContext, completed: boolean): boolean {
  return ctx.isDesktop && !completed;
}
