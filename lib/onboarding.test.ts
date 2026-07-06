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
