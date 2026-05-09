"use client";
import { useNumberArrayTween } from "@/hooks/useNumberTween";

interface Props {
  data: number[];
  chartType: "line" | "bar";
  label: string;
}

export default function FloatingChart({ data, chartType, label }: Props) {
  const tweened = useNumberArrayTween(data, 600);
  const max = Math.max(...data, 1);
  const W = 140;
  const H = 48;

  const points = tweened
    .map((v, i) => {
      const x = tweened.length === 1 ? W / 2 : (i / (tweened.length - 1)) * W;
      const y = H - (v / max) * H;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div className="overlay-enter bg-black/70 backdrop-blur-md border border-white/20 rounded-xl p-3 min-w-[180px]">
      <p className="text-white/50 text-xs font-mono mb-2 uppercase tracking-wider">{label}</p>
      {chartType === "bar" ? (
        <div className="flex items-end gap-1 h-12">
          {tweened.map((v, i) => (
            <div
              key={i}
              className="flex-1 bg-blue-400 rounded-sm opacity-80 origin-bottom transition-transform duration-500 ease-out"
              style={{
                height: "100%",
                transform: `scaleY(${Math.max(0.001, v / max)})`,
              }}
            />
          ))}
        </div>
      ) : (
        <svg width={W} height={H} className="overflow-visible">
          <defs>
            <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
            </linearGradient>
          </defs>
          <polyline
            points={points}
            fill="none"
            stroke="#38bdf8"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ filter: "drop-shadow(0 0 4px #38bdf8)" }}
          />
        </svg>
      )}
    </div>
  );
}
