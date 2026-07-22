// Pins the tokens -> hours translation the Settings meter renders
// (lib/hosted-hours.ts): the 275k-tokens-per-hour conversion from issue #49
// and the rounding rules (one decimal under an hour, whole hours otherwise,
// never negative).

import { describe, expect, it } from "vitest";
import {
  formatHours,
  hoursMeterFraction,
  hoursMeterLabel,
  TOKENS_PER_PRESENTATION_HOUR,
} from "./hosted-hours";

const HOUR = TOKENS_PER_PRESENTATION_HOUR;

describe("formatHours", () => {
  it("shows one decimal under an hour", () => {
    expect(formatHours(0)).toBe("0.0");
    expect(formatHours(HOUR / 2)).toBe("0.5");
    // A first short session must move the meter off dead zero eventually,
    // and tiny usage rounds down, not up into a scary jump.
    expect(formatHours(HOUR / 100)).toBe("0.0");
    expect(formatHours(HOUR / 10)).toBe("0.1");
  });

  it("shows whole hours from one hour up", () => {
    expect(formatHours(HOUR)).toBe("1");
    expect(formatHours(3.4 * HOUR)).toBe("3");
    expect(formatHours(3.6 * HOUR)).toBe("4");
    expect(formatHours(20 * HOUR)).toBe("20");
  });

  it("never goes negative", () => {
    expect(formatHours(-500)).toBe("0.0");
  });
});

describe("hoursMeterLabel", () => {
  it('reads "X of 20 hours used" on the default budget', () => {
    expect(hoursMeterLabel(0, 5_500_000)).toBe("0.0 of 20 hours used");
    expect(hoursMeterLabel(HOUR / 2, 5_500_000)).toBe("0.5 of 20 hours used");
    expect(hoursMeterLabel(7 * HOUR, 5_500_000)).toBe("7 of 20 hours used");
  });

  it("caps the used hours at the budget (a settlement race never shows 21 of 20)", () => {
    expect(hoursMeterLabel(5_600_000, 5_500_000)).toBe("20 of 20 hours used");
  });

  it("renders env-tuned budgets through the same rounding", () => {
    expect(hoursMeterLabel(0, 1_375_000)).toBe("0.0 of 5 hours used");
  });
});

describe("hoursMeterFraction", () => {
  it("clamps to [0, 1] and survives a zero budget", () => {
    expect(hoursMeterFraction(2_750_000, 5_500_000)).toBe(0.5);
    expect(hoursMeterFraction(6_000_000, 5_500_000)).toBe(1);
    expect(hoursMeterFraction(-5, 5_500_000)).toBe(0);
    expect(hoursMeterFraction(100, 0)).toBe(0);
  });
});
