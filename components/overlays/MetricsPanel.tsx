"use client";
import type { MetricRow } from "@/lib/types";

interface Props {
  title: string;
  metrics: MetricRow[];
}

export default function MetricsPanel({ title, metrics }: Props) {
  return (
    <div className="bg-black/70 backdrop-blur-md border border-white/20 rounded-xl p-4 min-w-[200px] animate-in fade-in duration-300">
      <p className="text-white/60 text-xs uppercase tracking-widest mb-3 font-mono">{title}</p>
      <div className="space-y-2">
        {metrics.map((m, i) => (
          <div key={i} className="flex items-center justify-between gap-6">
            <span className="text-white/70 text-sm">{m.label}</span>
            <div className="flex items-center gap-1.5">
              <span className="text-white font-semibold tabular-nums">{m.value}</span>
              {m.delta && (
                <span
                  className={`text-xs font-mono ${
                    m.delta.startsWith("+") ? "text-green-400" : "text-red-400"
                  }`}
                >
                  {m.delta}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
