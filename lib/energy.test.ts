import { describe, it, expect } from "vitest";
import {
  stepEnergy,
  ATTACK_TAU_MS,
  DECAY_PER_SEC,
  MAX_STEP_MS,
  SPEAK_WINDOW_MS,
} from "@/lib/energy";

// The envelope is part of the broadcast look, so these tests PIN it: exact
// single-step values from the exported constants, frame-rate independence
// (n small steps == one big step), and the release length that bridges
// Chrome's interim-result gaps. Loosening a constant should fail here.

describe("stepEnergy: attack", () => {
  it("one speaking step closes exactly 1 - e^(-dt/tau) of the gap", () => {
    expect(stepEnergy(0, true, 40)).toBeCloseTo(1 - Math.exp(-40 / ATTACK_TAU_MS), 10);
    expect(stepEnergy(0.5, true, 20)).toBeCloseTo(
      0.5 + 0.5 * (1 - Math.exp(-20 / ATTACK_TAU_MS)),
      10
    );
  });

  it("reaches 0.9 within ~100ms of sustained speech", () => {
    let e = 0;
    for (let t = 0; t < 100; t += 16.7) e = stepEnergy(e, true, 16.7);
    expect(e).toBeGreaterThan(0.9);
    expect(e).toBeLessThanOrEqual(1);
  });

  it("rises strictly monotonically while below 1 and never overshoots", () => {
    let prev = 0;
    for (let i = 0; i < 60; i++) {
      const next = stepEnergy(prev, true, 16.7);
      expect(next).toBeGreaterThan(prev);
      expect(next).toBeLessThanOrEqual(1);
      prev = next;
    }
  });
});

describe("stepEnergy: decay", () => {
  it("one quiet step falls exactly dt * DECAY_PER_SEC", () => {
    expect(stepEnergy(1, false, 16.7)).toBeCloseTo(1 - (16.7 / 1000) * DECAY_PER_SEC, 10);
  });

  it("full release from 1 takes ~830ms (bridges 600ms interim gaps)", () => {
    const releaseMs = 1000 / DECAY_PER_SEC;
    expect(releaseMs).toBeGreaterThan(700);
    expect(releaseMs).toBeLessThan(1000);
    // After a worst-case interim gap (600ms total, minus the speaking window),
    // energy must still be visibly up so the feed doesn't pump word by word.
    let e = 1;
    for (let t = 0; t < 600 - SPEAK_WINDOW_MS; t += 16.7) e = stepEnergy(e, false, 16.7);
    expect(e).toBeGreaterThan(0.5);
  });

  it("decays to exactly 0 and never goes negative", () => {
    let e = 1;
    for (let i = 0; i < 200; i++) e = stepEnergy(e, false, 16.7);
    expect(e).toBe(0);
    expect(stepEnergy(0, false, 16.7)).toBe(0);
  });
});

describe("stepEnergy: frame-rate independence", () => {
  it("two 8.35ms speaking steps equal one 16.7ms step", () => {
    const twice = stepEnergy(stepEnergy(0.2, true, 8.35), true, 8.35);
    expect(twice).toBeCloseTo(stepEnergy(0.2, true, 16.7), 10);
  });

  it("four 4ms quiet steps equal one 16ms step", () => {
    let e = 0.8;
    for (let i = 0; i < 4; i++) e = stepEnergy(e, false, 4);
    expect(e).toBeCloseTo(stepEnergy(0.8, false, 16), 10);
  });

  it("defaults dt to one 60Hz frame", () => {
    expect(stepEnergy(0.3, true)).toBeCloseTo(stepEnergy(0.3, true, 16.7), 10);
  });
});

describe("stepEnergy: clamping", () => {
  it("clamps a tab-resume jump to MAX_STEP_MS", () => {
    expect(stepEnergy(1, false, 5000)).toBeCloseTo(stepEnergy(1, false, MAX_STEP_MS), 10);
    expect(stepEnergy(0, true, 5000)).toBeCloseTo(stepEnergy(0, true, MAX_STEP_MS), 10);
  });

  it("treats a negative dt as zero (no movement)", () => {
    expect(stepEnergy(0.5, true, -50)).toBe(0.5);
    expect(stepEnergy(0.5, false, -50)).toBe(0.5);
  });

  it("stays within [0,1] at the extremes", () => {
    expect(stepEnergy(1, true, 100)).toBeLessThanOrEqual(1);
    expect(stepEnergy(0, false, 100)).toBe(0);
  });
});
