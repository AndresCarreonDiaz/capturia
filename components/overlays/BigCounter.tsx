"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useNumberTween } from "@/hooks/useNumberTween";

interface Props {
  value: number;
  label: string;
  prefix?: string;
  suffix?: string;
  color?: string;
}

export default function BigCounter({ value, label, prefix = "", suffix = "", color }: Props) {
  const tweened = useNumberTween(value, 900);
  const display = formatNumber(tweened);
  const bursting = useMilestoneBurst(value);

  const useGradient = !color;
  const textStyle: CSSProperties = useGradient
    ? ({ "--g-from": "#67e8f9", "--g-to": "#c084fc" } as CSSProperties)
    : { color, textShadow: `0 0 22px ${color}90` };

  return (
    <div
      className={`relative bg-black/70 backdrop-blur-md border border-white/20 rounded-xl px-6 py-4 border-breathe energy-scale ${
        bursting ? "milestone-burst" : ""
      }`}
    >
      <p className="text-white/50 text-[10px] uppercase tracking-[0.25em] font-mono mb-1">{label}</p>
      <div className="flex items-baseline gap-0.5 leading-none">
        {prefix && (
          <span className={`font-bold text-3xl ${useGradient ? "gradient-text" : ""}`} style={textStyle}>
            {prefix}
          </span>
        )}
        <DigitTrack text={display} className="text-5xl" useGradient={useGradient} style={textStyle} />
        {suffix && (
          <span className="font-bold text-2xl ml-1 text-white/60">{suffix}</span>
        )}
      </div>
    </div>
  );
}

function DigitTrack({
  text,
  className,
  useGradient,
  style,
}: {
  text: string;
  className: string;
  useGradient: boolean;
  style: CSSProperties;
}) {
  return (
    <span className={`flex font-bold tabular-nums ${className} ${useGradient ? "gradient-text" : ""}`} style={style}>
      {text.split("").map((ch, i) => (
        <span
          key={i}
          className="inline-block overflow-hidden align-top"
          style={{ height: "1em", lineHeight: "1em" }}
        >
          {/* Inner key by char so position remounts and animates on change */}
          <span key={ch} className="inline-block digit-roll">
            {ch}
          </span>
        </span>
      ))}
    </span>
  );
}

function formatNumber(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 10_000) return (n / 1_000).toFixed(1) + "K";
  if (Number.isInteger(n)) return Math.round(n).toLocaleString();
  return n.toFixed(0);
}

/** Fires a one-shot burst when the value crosses a milestone (1k / 10k / 100k / 1m). */
function useMilestoneBurst(value: number): boolean {
  const [bursting, setBursting] = useState(false);
  const prevRef = useRef(value);
  useEffect(() => {
    const milestones = [1000, 10_000, 100_000, 1_000_000];
    const crossed = milestones.some((m) => prevRef.current < m && value >= m);
    prevRef.current = value;
    if (crossed) {
      setBursting(true);
      const t = setTimeout(() => setBursting(false), 900);
      return () => clearTimeout(t);
    }
  }, [value]);
  return bursting;
}
