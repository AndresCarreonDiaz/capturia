"use client";

interface Props {
  progress: number;
  label?: string;
}

export default function ProgressBar({ progress, label }: Props) {
  const clamped = Math.max(0, Math.min(100, progress));
  return (
    <div className="bg-black/70 backdrop-blur-md border border-white/20 rounded-xl px-5 py-3 w-full animate-in fade-in duration-300">
      {label && (
        <div className="flex justify-between items-center mb-2">
          <span className="text-white/70 text-sm font-mono">{label}</span>
          <span className="text-white font-bold tabular-nums">{clamped}%</span>
        </div>
      )}
      <div className="h-2 bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-700 shadow-[0_0_8px_#38bdf8]"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
