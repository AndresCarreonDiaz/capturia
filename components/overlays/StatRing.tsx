"use client";
import { useEffect, useId, useState } from "react";
import { useNumberTween } from "@/hooks/useNumberTween";

interface Props {
  value: number;
  label: string;
  color?: string;
  size?: number;
}

export default function StatRing({ value, label, color, size = 84 }: Props) {
  const target = Math.max(0, Math.min(100, value));
  const tweened = useNumberTween(target, 800);
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (tweened / 100) * c;
  const gradId = useId();
  const useGradient = !color;
  const strokeRef = useGradient ? `url(#${CSS.escape(gradId)})` : color!;
  const glowColor = color ?? "#a78bfa";
  const showSparkles = target >= 85;

  // Pop the % on each new target
  const [popKey, setPopKey] = useState(0);
  useEffect(() => {
    setPopKey((k) => k + 1);
  }, [value]);

  return (
    <div className="bg-black/70 backdrop-blur-md border border-white/20 rounded-xl p-3 flex items-center gap-3 border-breathe">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          {useGradient && (
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#67e8f9" />
                <stop offset="50%" stopColor="#c084fc" />
                <stop offset="100%" stopColor="#f472b6" />
              </linearGradient>
            </defs>
          )}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={stroke}
            fill="none"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={strokeRef}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={offset}
            style={{
              filter: `drop-shadow(0 0 6px ${glowColor})`,
              transition: "stroke-dashoffset 80ms linear",
            }}
          />
        </svg>

        {/* Sparkles around the ring when ≥85% */}
        {showSparkles && (
          <div className="absolute inset-0 pointer-events-none">
            {[0, 1, 2, 3, 4].map((i) => {
              const angle = (i / 5) * Math.PI * 2 - Math.PI / 2;
              const radius = size / 2 - 2;
              const x = size / 2 + Math.cos(angle) * radius;
              const y = size / 2 + Math.sin(angle) * radius;
              return (
                <span
                  key={i}
                  className="sparkle absolute w-1 h-1 rounded-full bg-white"
                  style={{
                    left: x - 2,
                    top: y - 2,
                    boxShadow: `0 0 6px ${glowColor}, 0 0 2px white`,
                    animationDelay: `${i * 240}ms`,
                  }}
                />
              );
            })}
          </div>
        )}

        <div className="absolute inset-0 flex items-center justify-center">
          <span
            key={popKey}
            className="text-white font-bold text-lg tabular-nums step-pop"
            style={{ animationDuration: "300ms" }}
          >
            {Math.round(tweened)}%
          </span>
        </div>
      </div>
      <div className="flex flex-col">
        <span className="text-white/50 text-xs uppercase tracking-widest font-mono">Stat</span>
        <span className="text-white text-sm font-medium leading-tight">{label}</span>
      </div>
    </div>
  );
}
