// Pure countdown logic for the CountdownTimer overlay. The component ticks
// client-side from a deadline (zero agent turns while running); these
// functions decide what a given remaining time looks like, so the
// green/yellow/red practice (Toastmasters-style) is testable without React.

export type TimerPhase = "fresh" | "warning" | "critical" | "overtime";

// Phase thresholds scale with the total but never collapse on short timers:
// warning at 25% left (at least 30s), critical at 10% left (at least 15s).
// A timer too short for a threshold simply skips that phase.
export function timerPhase(remainingSeconds: number, totalSeconds: number): TimerPhase {
  if (remainingSeconds < 0) return "overtime";
  if (remainingSeconds <= 0) return "critical";
  const warnAt = Math.max(30, totalSeconds * 0.25);
  const criticalAt = Math.max(15, totalSeconds * 0.1);
  // A threshold only exists when it is strictly inside the duration;
  // otherwise a short timer would be born amber or red instead of green.
  if (criticalAt < totalSeconds && remainingSeconds <= criticalAt) return "critical";
  if (warnAt < totalSeconds && remainingSeconds <= warnAt) return "warning";
  return "fresh";
}

// M:SS for under an hour, H:MM:SS above; overtime renders as +M:SS counting
// up. Always whole seconds, floored toward the direction time is moving so
// the display never shows a state that has not happened yet.
export function formatClock(remainingSeconds: number): string {
  const overtime = remainingSeconds < 0;
  const total = Math.floor(Math.abs(remainingSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const core =
    h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  return overtime ? `+${core}` : core;
}
