import { describe, expect, it } from "vitest";
import { formatClock, timerPhase } from "./timer";

describe("timerPhase", () => {
  it("walks green, yellow, red, overtime on a five minute timer", () => {
    expect(timerPhase(300, 300)).toBe("fresh");
    expect(timerPhase(120, 300)).toBe("fresh");
    expect(timerPhase(75, 300)).toBe("warning"); // 25% of 300 = 75
    expect(timerPhase(30, 300)).toBe("critical"); // 10% floor is 30 here
    expect(timerPhase(0, 300)).toBe("critical");
    expect(timerPhase(-1, 300)).toBe("overtime");
  });

  it("keeps humane floors on long timers", () => {
    // 1 hour: warning at 15 min, critical at 6 min.
    expect(timerPhase(901, 3600)).toBe("fresh");
    expect(timerPhase(900, 3600)).toBe("warning");
    expect(timerPhase(360, 3600)).toBe("critical");
  });

  it("short timers skip phases instead of being born critical", () => {
    // A 20s timer is at or under the 15s critical floor almost instantly,
    // but at start it must still read as running.
    expect(timerPhase(20, 20)).toBe("fresh");
    expect(timerPhase(15, 20)).toBe("critical");
  });

  it("minimum thresholds apply on mid-size timers", () => {
    // 60s timer: warning floor 30s beats 25% (15s).
    expect(timerPhase(31, 60)).toBe("fresh");
    expect(timerPhase(30, 60)).toBe("warning");
    expect(timerPhase(15, 60)).toBe("critical");
  });
});

describe("formatClock", () => {
  it("formats minutes and seconds", () => {
    expect(formatClock(300)).toBe("5:00");
    expect(formatClock(61)).toBe("1:01");
    expect(formatClock(9)).toBe("0:09");
    expect(formatClock(0)).toBe("0:00");
  });

  it("formats hours when needed", () => {
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3725)).toBe("1:02:05");
  });

  it("counts overtime upward with a plus", () => {
    expect(formatClock(-1)).toBe("+0:01");
    expect(formatClock(-75)).toBe("+1:15");
  });

  it("rounds up while counting down, floors overtime like a stopwatch", () => {
    // 0:00 must mean zero; 0.4s left still reads 0:01.
    expect(formatClock(59.9)).toBe("1:00");
    expect(formatClock(0.4)).toBe("0:01");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(-0.5)).toBe("+0:00");
    expect(formatClock(-1.9)).toBe("+0:01");
  });
});
