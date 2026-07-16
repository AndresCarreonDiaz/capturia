// Pure model for the first-run onboarding flow. The component
// (components/OnboardingFlow.tsx) renders whatever this returns; keeping the
// step composition and advance rules here makes the flow unit-testable
// without React. The audience for the copy is people who talk, not code:
// every step is one action, no jargon.

import type { SysextUiStatus } from "./sysext";

export interface OnboardingContext {
  isDesktop: boolean;
  hasKeys: boolean;
  voiceSupported: boolean;
  overlayCount: number;
  // In-app camera-extension activation state (lib/sysext.ts), undefined on
  // web and on a stale preload. "unsupported" (dev shell, unsigned build)
  // hides the camera step: that build cannot fire the install.
  cameraExtension?: SysextUiStatus;
  // The mapped failure message when cameraExtension is "error" (the
  // describeSysextError copy: MDM policy, move to /Applications, etc.).
  cameraExtensionError?: string | null;
}

export type OnboardingStepId = "welcome" | "keys" | "voice" | "camera" | "golive";

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  body: string;
  // Primary button label. "keys" opens Settings, "camera" fires the
  // extension install; everything else advances.
  cta: string;
  // True once the world-state this step asks for exists, letting the
  // component celebrate and advance without a click.
  isSatisfied: (ctx: OnboardingContext) => boolean;
  // Live copy override: when this returns a string it replaces `body`. Lets
  // the camera step walk the user through the System Settings approval and
  // surface install failures without the flow growing sub-steps.
  dynamicBody?: (ctx: OnboardingContext) => string | null;
  // True while the world, not a click, moves the step forward (install in
  // flight, OS approval pending): the component hides the primary button so
  // the user cannot double-fire the request underneath the pending one.
  // Failures are NOT waiting: the button stays and clicking it retries.
  waiting?: (ctx: OnboardingContext) => boolean;
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
      "Capturia runs on your own key (free tier): open aistudio.google.com, hit Get API key, " +
      "paste it here. About a minute, no card needed. The key is stored encrypted in the " +
      "macOS Keychain and never sent to a Capturia server.",
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
    id: "camera",
    title: "Install the Capturia camera",
    body:
      "One-time install: Capturia becomes a real camera you can pick in Zoom, " +
      "Meet, or Teams. macOS will ask you to approve it in System Settings.",
    cta: "Install camera",
    isSatisfied: (ctx) => ctx.cameraExtension === "installed",
    dynamicBody: (ctx) => {
      if (ctx.cameraExtension === "installing") {
        return "Installing… macOS may pop an approval dialog in a moment.";
      }
      if (ctx.cameraExtension === "awaiting-approval") {
        return (
          "macOS wants your OK: open System Settings, General, " +
          "Login Items & Extensions, Camera Extensions, and allow Capturia. " +
          "This step finishes on its own once you do."
        );
      }
      if (ctx.cameraExtension === "error") {
        // The mapped OS failure is the useful part (MDM policy, bad
        // signature, ...); the retry path is the same button.
        return `${ctx.cameraExtensionError || "The camera install failed."} You can try again.`;
      }
      if (ctx.cameraExtension === "needs-move") {
        return (
          "Capturia needs to live in your Applications folder before macOS " +
          "will install its camera. The install button starts the move."
        );
      }
      return null;
    },
    waiting: (ctx) =>
      ctx.cameraExtension === "installing" || ctx.cameraExtension === "awaiting-approval",
  },
  {
    id: "golive",
    title: "Use it in a call",
    body:
      "In Zoom or Meet, pick “Capturia” as your camera, or share this " +
      "window, to broadcast the stage. Closing this window keeps Capturia " +
      "running in the menu bar so the camera stays live; quit it fully from " +
      "the menu bar icon. And if your own Zoom preview shows text backwards, " +
      "that is only your self-view: the audience sees it correctly. Uncheck " +
      "“Mirror my video” in Zoom’s Video settings to fix your side too.",
    cta: "Finish",
    isSatisfied: () => false,
  },
];

// Steps applicable to this session. Key setup is skipped when a key already
// exists; the voice step is skipped when no speech engine is available (the
// CommandBar still works, but a voice-first tutorial would dead-end). The
// camera step only exists where the install can actually run or has already
// run: never on web (no bridge) and never in a build that cannot request
// activation (dev shell, unsigned pack), where it would dead-end too.
export function onboardingSteps(ctx: OnboardingContext): OnboardingStep[] {
  return ALL_STEPS.filter((step) => {
    if (step.id === "keys") return !ctx.hasKeys;
    if (step.id === "voice") return ctx.voiceSupported;
    if (step.id === "camera") {
      return ctx.cameraExtension !== undefined && ctx.cameraExtension !== "unsupported";
    }
    return true;
  });
}

// Whether the flow should show at all: desktop only (the web studio is a
// self-serve demo; coaching a drive-by visitor is noise) and never once
// completed. `completed` is the persisted flag the component owns.
export function shouldShowOnboarding(ctx: OnboardingContext, completed: boolean): boolean {
  return ctx.isDesktop && !completed;
}
