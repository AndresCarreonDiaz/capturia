"use client";
import { useEffect, useRef, useState } from "react";
import type { MetricRow } from "@/lib/types";
import { useNumberTween, parseNumeric, formatLikeOriginal } from "@/hooks/useNumberTween";

interface Props {
  title: string;
  metrics: MetricRow[];
}

export default function MetricsPanel({ title, metrics }: Props) {
  return (
    <div className="overlay-enter bg-black/70 backdrop-blur-md border border-white/20 rounded-xl p-4 min-w-[200px]">
      <p className="text-white/60 text-xs uppercase tracking-widest mb-3 font-mono">{title}</p>
      <div className="space-y-2">
        {metrics.map((m, i) => (
          <MetricLine key={`${m.label}-${i}`} metric={m} />
        ))}
      </div>
    </div>
  );
}

function MetricLine({ metric }: { metric: MetricRow }) {
  const flashClass = useFlashOnChange(metric.value, metric.delta);
  return (
    <div
      className={`flex items-center justify-between gap-6 rounded-md px-1 -mx-1 ${flashClass}`}
    >
      <span className="text-white/70 text-sm">{metric.label}</span>
      <div className="flex items-center gap-1.5">
        <AnimatedValue raw={metric.value} />
        {metric.delta && (
          <span
            className={`text-xs font-mono ${
              metric.delta.startsWith("+") ? "text-green-400" : "text-red-400"
            }`}
          >
            {metric.delta}
          </span>
        )}
      </div>
    </div>
  );
}

function AnimatedValue({ raw }: { raw: string }) {
  const parsed = parseNumeric(raw);
  if (!parsed) {
    return <span className="text-white font-semibold tabular-nums">{raw}</span>;
  }
  return <TweenedNumber raw={raw} />;
}

function TweenedNumber({ raw }: { raw: string }) {
  const parsed = parseNumeric(raw)!;
  const tweened = useNumberTween(parsed.num, 700);
  return (
    <span className="text-white font-semibold tabular-nums">
      {parsed.prefix}
      {formatLikeOriginal(tweened, raw.replace(parsed.prefix, "").replace(parsed.suffix, ""))}
      {parsed.suffix}
    </span>
  );
}

/**
 * Flash green if value increased or delta is positive, red if decreased or delta is negative.
 * Skips the initial mount render so the panel doesn't flash on first appear.
 */
function useFlashOnChange(value: string, delta?: string): string {
  const [flash, setFlash] = useState<"" | "delta-flash-up" | "delta-flash-down">("");
  const prevValueRef = useRef(value);
  const prevDeltaRef = useRef(delta);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevValueRef.current = value;
      prevDeltaRef.current = delta;
      return;
    }
    const valueChanged = prevValueRef.current !== value;
    const deltaChanged = prevDeltaRef.current !== delta;
    if (valueChanged || deltaChanged) {
      const direction = inferDirection(prevValueRef.current, value, delta);
      setFlash(direction === "up" ? "delta-flash-up" : direction === "down" ? "delta-flash-down" : "");
      prevValueRef.current = value;
      prevDeltaRef.current = delta;
      const timeout = setTimeout(() => setFlash(""), 750);
      return () => clearTimeout(timeout);
    }
  }, [value, delta]);

  return flash;
}

function inferDirection(prev: string, next: string, delta?: string): "up" | "down" | null {
  if (delta?.startsWith("+")) return "up";
  if (delta?.startsWith("-")) return "down";
  const prevNum = parseNumeric(prev)?.num;
  const nextNum = parseNumeric(next)?.num;
  if (prevNum != null && nextNum != null) {
    if (nextNum > prevNum) return "up";
    if (nextNum < prevNum) return "down";
  }
  return null;
}
