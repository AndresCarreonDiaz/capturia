"use client";
import { useNumberTween } from "@/hooks/useNumberTween";

interface Props {
  progress: number;
  label?: string;
}

export default function ProgressBar({ progress, label }: Props) {
  const target = Math.max(0, Math.min(100, progress));
  const tweened = useNumberTween(target, 700);
  const displayPct = Math.round(tweened);
  const isComplete = target >= 100;
  return (
    <div className="overlay-enter bg-black/70 backdrop-blur-md border border-white/20 rounded-xl px-5 py-3 w-full">
      {label && (
        <div className="flex justify-between items-center mb-2">
          <span className="text-white/70 text-sm font-mono">{label}</span>
          <span className="text-white font-bold tabular-nums">{displayPct}%</span>
        </div>
      )}
      <div className="h-2 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-[width] duration-700 ease-out shadow-[0_0_8px_#38bdf8] ${
            isComplete ? "progress-pulse" : ""
          }`}
          style={{ width: `${tweened}%` }}
        />
      </div>
    </div>
  );
}
