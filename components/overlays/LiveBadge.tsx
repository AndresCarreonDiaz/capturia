"use client";

interface Props {
  label?: string;
  color?: string;
}

export default function LiveBadge({ label = "LIVE", color = "#ef4444" }: Props) {
  return (
    <div className="relative inline-flex">
      {/* Ripple ring radiating outward */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-md ring-ripple pointer-events-none"
        style={{ boxShadow: `0 0 0 2px ${color}` }}
      />
      {/* energy-glow: the badge brightens with --mic-energy (speaking energy).
          The white LIVE text clamps at white, so the effect lands on the
          colored background + glow with no text shimmer. Must stay on THIS
          element: a filter on an ancestor would disable backdrop-blur. */}
      <div
        className="relative flex items-center gap-2 px-3 py-1.5 rounded-md backdrop-blur-md energy-glow"
        style={{
          backgroundColor: `${color}f0`,
          boxShadow: `0 0 16px ${color}80`,
        }}
      >
        <span
          className="w-2 h-2 rounded-full bg-white live-dot-pulse"
          style={{ boxShadow: "0 0 6px white" }}
        />
        <span className="text-white text-xs font-bold tracking-[0.25em] uppercase">{label}</span>
      </div>
    </div>
  );
}
