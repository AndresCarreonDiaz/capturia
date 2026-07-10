import { describe, expect, it } from "vitest";
import {
  onboardingSteps,
  shouldShowOnboarding,
  type OnboardingContext,
} from "./onboarding";

const ctx = (over: Partial<OnboardingContext> = {}): OnboardingContext => ({
  isDesktop: true,
  hasKeys: false,
  voiceSupported: true,
  overlayCount: 0,
  ...over,
});

describe("onboardingSteps", () => {
  it("gives a fresh desktop install the full flow in order", () => {
    expect(onboardingSteps(ctx()).map((s) => s.id)).toEqual([
      "welcome",
      "keys",
      "voice",
      "golive",
    ]);
  });

  it("skips key setup when a key already exists", () => {
    const ids = onboardingSteps(ctx({ hasKeys: true })).map((s) => s.id);
    expect(ids).not.toContain("keys");
    expect(ids[0]).toBe("welcome");
  });

  it("skips the voice tutorial when no speech engine exists", () => {
    const ids = onboardingSteps(ctx({ voiceSupported: false })).map((s) => s.id);
    expect(ids).not.toContain("voice");
    expect(ids).toContain("golive");
  });

  it("marks the keys step satisfied once a key lands", () => {
    const keys = onboardingSteps(ctx()).find((s) => s.id === "keys")!;
    expect(keys.isSatisfied(ctx())).toBe(false);
    expect(keys.isSatisfied(ctx({ hasKeys: true }))).toBe(true);
  });

  it("marks the voice step satisfied once an overlay renders", () => {
    const voice = onboardingSteps(ctx()).find((s) => s.id === "voice")!;
    expect(voice.isSatisfied(ctx())).toBe(false);
    expect(voice.isSatisfied(ctx({ overlayCount: 2 }))).toBe(true);
  });

  it("never auto-satisfies welcome or golive", () => {
    for (const step of onboardingSteps(ctx({ hasKeys: true, overlayCount: 5 }))) {
      if (step.id === "welcome" || step.id === "golive") {
        expect(step.isSatisfied(ctx({ hasKeys: true, overlayCount: 5 }))).toBe(false);
      }
    }
  });

  it("every step has copy and a cta", () => {
    for (const step of onboardingSteps(ctx())) {
      expect(step.title).toBeTruthy();
      expect(step.body).toBeTruthy();
      expect(step.cta).toBeTruthy();
    }
  });
});

describe("shouldShowOnboarding", () => {
  it("shows on a fresh desktop session", () => {
    expect(shouldShowOnboarding(ctx(), false)).toBe(true);
  });

  it("never shows on web", () => {
    expect(shouldShowOnboarding(ctx({ isDesktop: false }), false)).toBe(false);
  });

  it("never shows again once completed", () => {
    expect(shouldShowOnboarding(ctx(), true)).toBe(false);
  });
});

describe("the camera step", () => {
  it("exists only when this build can install (or has installed) the extension", () => {
    expect(onboardingSteps(ctx()).map((s) => s.id)).not.toContain("camera");
    expect(
      onboardingSteps(ctx({ cameraExtension: "unsupported" })).map((s) => s.id)
    ).not.toContain("camera");
    expect(
      onboardingSteps(ctx({ cameraExtension: "not-installed" })).map((s) => s.id)
    ).toEqual(["welcome", "keys", "voice", "camera", "golive"]);
  });

  it("stays in the flow once installed (so it can celebrate and advance)", () => {
    expect(
      onboardingSteps(ctx({ cameraExtension: "installed" })).map((s) => s.id)
    ).toContain("camera");
  });

  it("is satisfied exactly when the extension is installed", () => {
    const step = onboardingSteps(ctx({ cameraExtension: "not-installed" })).find(
      (s) => s.id === "camera"
    )!;
    expect(step.isSatisfied(ctx({ cameraExtension: "not-installed" }))).toBe(false);
    expect(step.isSatisfied(ctx({ cameraExtension: "awaiting-approval" }))).toBe(false);
    expect(step.isSatisfied(ctx({ cameraExtension: "installed" }))).toBe(true);
  });

  it("swaps its copy while installing and while macOS waits for approval", () => {
    const step = onboardingSteps(ctx({ cameraExtension: "not-installed" })).find(
      (s) => s.id === "camera"
    )!;
    expect(step.dynamicBody?.(ctx({ cameraExtension: "not-installed" }))).toBeNull();
    expect(step.dynamicBody?.(ctx({ cameraExtension: "installing" }))).toContain(
      "Installing"
    );
    expect(step.dynamicBody?.(ctx({ cameraExtension: "awaiting-approval" }))).toContain(
      "System Settings"
    );
  });
});
