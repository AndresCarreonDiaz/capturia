"use client";
import { useEffect, useState } from "react";
import { formatClock, timerPhase, type TimerPhase } from "@/lib/timer";

interface Props {
  seconds: number;
  label?: string;
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
export default function CountdownTimer({ seconds, label }: Props) {
  const total = Math.max(1, Math.floor(seconds));
  const [deadline, setDeadline] = useState(() => Date.now() + total * 1000);
  const [now, setNow] = useState(() => Date.now());
  // The deadline restarts whenever the agent supplies a new duration
  // ("make it ten minutes" re-issues the overlay with fresh seconds).
  // Render-phase adjustment, the sanctioned reset-on-prop-change form.
  const [prevTotal, setPrevTotal] = useState(total);
  if (prevTotal !== total) {
    setPrevTotal(total);
    setDeadline(Date.now() + total * 1000);
  }

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const remaining = (deadline - now) / 1000;
  const phase = timerPhase(remaining, total);
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
