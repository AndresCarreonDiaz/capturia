"use client";
import { useEffect, useState } from "react";
import { formatClock, timerPhase, type TimerPhase } from "@/lib/timer";

interface Props {
  seconds: number;
  label?: string;
  // Issuance stamp from normalizeProps: a re-issue (even with the same
  // duration) carries a new stamp, which restarts the clock.
  startedAt?: number;
}

// Phase styling: flat fills and huge digits on purpose. The timer must read
// at thumbnail size while someone else screen-shares (the whole reason
// people want it on the camera instead of a timer app).
const PHASE_STYLES: Record<TimerPhase, { digits: string; ring: string }> = {
  fresh: { digits: "text-emerald-300", ring: "border-emerald-400/40" },
  warning: { digits: "text-amber-300", ring: "border-amber-400/50" },
  critical: { digits: "text-rose-300", ring: "border-rose-400/60" },
  overtime: { digits: "text-rose-200", ring: "border-rose-400/80" },
};

/**
 * Voice-set countdown for the feed: "give me five minutes on the clock".
 * Ticks entirely client-side from a deadline captured at mount (or when the
 * agent re-issues a new duration), so a running timer costs zero agent
 * turns and works with no API key. Walks green, amber, red (lib/timer.ts),
 * then counts overtime upward with a plus, which is the practice speakers
 * expect from a Toastmasters-style clock.
 */
export default function CountdownTimer({ seconds, label, startedAt }: Props) {
  // Belt and braces: the tool paths do not run the Zod schema, so garbage
  // durations can reach us. A clock reading "NaN:NaN" on the live feed is
  // worse than no clock.
  const valid = Number.isFinite(seconds) && seconds > 0;
  const total = valid ? Math.max(1, Math.floor(seconds)) : 1;
  // The deadline derives from the issuance stamp normalizeProps sets, so a
  // re-issue (even with the SAME duration: "restart the clock") moves the
  // anchor and the clock restarts with no reset logic at all. Specs without
  // a stamp (deck cues) anchor at mount.
  const [mountAt] = useState(() => Date.now());
  const anchor = startedAt ?? mountAt;
  const deadline = anchor + total * 1000;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const remaining = (deadline - now) / 1000;
  const phase = timerPhase(remaining, total);

  if (!valid) return null;
  const style = PHASE_STYLES[phase];

  return (
    <div
      className={`bg-black/75 backdrop-blur-md border ${style.ring} rounded-2xl px-6 py-4 flex flex-col items-center transition-colors duration-500 ${
        phase === "critical" ? "timer-critical" : ""
      }`}
    >
      <span className="text-white/50 text-xs font-mono uppercase tracking-[0.2em]">
        {phase === "overtime" ? "over time" : label || "on the clock"}
      </span>
      <span
        className={`tabular-nums font-mono font-bold leading-none text-6xl mt-1 ${style.digits} ${
          phase === "overtime" ? "timer-overtime" : ""
        }`}
      >
        {formatClock(remaining)}
      </span>
    </div>
  );
}
