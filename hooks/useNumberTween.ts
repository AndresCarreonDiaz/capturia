"use client";
import { useEffect, useRef, useState } from "react";

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export function useNumberTween(target: number, durationMs = 600): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target === display) return;
    fromRef.current = display;
    const startTime = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / durationMs);
      const next = fromRef.current + (target - fromRef.current) * easeOutCubic(t);
      setDisplay(next);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs]);

  return display;
}

/**
 * Tweens an array of numbers element-wise. New entries (when target grows)
 * start at 0 and grow to target. Existing entries interpolate smoothly.
 */
export function useNumberArrayTween(target: number[], durationMs = 500): number[] {
  const [display, setDisplay] = useState<number[]>(target);
  const fromRef = useRef<number[]>(target);
  const rafRef = useRef<number | null>(null);
  const signature = target.join(",");

  useEffect(() => {
    const startArray = target.map((_, i) => fromRef.current[i] ?? 0);
    const startTime = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / durationMs);
      const eased = easeOutCubic(t);
      const current = target.map((tv, i) => startArray[i] + (tv - startArray[i]) * eased);
      setDisplay(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = current;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, durationMs]);

  return display;
}

/**
 * Parse a string like "1,234", "$1.2M", "47%", "+12.5" into
 * { num, prefix, suffix } so we can tween the number portion
 * and re-stitch it for display. Returns null if no number found.
 */
export function parseNumeric(value: string): { num: number; prefix: string; suffix: string } | null {
  const match = value.match(/^([^\d\-+.]*)([+-]?[\d,]*\.?\d+)(.*)$/);
  if (!match) return null;
  const [, prefix, raw, suffix] = match;
  const num = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;
  return { num, prefix, suffix };
}

/**
 * Format a tweened number back into the original style (commas, decimals).
 */
export function formatLikeOriginal(current: number, original: string): string {
  const hasComma = original.includes(",");
  const decimals = (original.split(".")[1] ?? "").replace(/\D.*$/, "").length;
  const fixed = current.toFixed(decimals);
  if (!hasComma) return fixed;
  const [int, dec] = fixed.split(".");
  const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dec ? `${withCommas}.${dec}` : withCommas;
}
