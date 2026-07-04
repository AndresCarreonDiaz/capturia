"use client";

interface Props {
  label: string;
  actionName?: string;
  color?: string;
  // Wired by the A2UI catalog renderer (lib/a2ui-catalog.tsx): on tap it
  // dispatches an A2UI action whose name is `actionName`. The A2UIProvider's
  // onAction (components/A2uiOverlayLayer.tsx) re-injects that as an
  // "[ACTION] <actionName>" user turn, closing the agent<->surface loop.
  onTap?: () => void;
}

/**
 * The one interactive Capturia leaf. Lives only inside agent-authored A2UI
 * surfaces (the render_surface tool); never placed as a standalone overlay.
 * pointer-events is re-enabled here because the overlay layer is
 * pointer-events-none (so decorative overlays don't eat clicks).
 */
export default function ActionButton({ label, color = "#22d3ee", onTap }: Props) {
  return (
    <button
      type="button"
      onClick={onTap}
      className="action-button pointer-events-auto inline-flex items-center gap-2 px-4 py-2 rounded-full backdrop-blur-md border text-white text-sm font-semibold tracking-wide transition-all duration-150 hover:brightness-125 active:scale-95 cursor-pointer"
      style={{
        backgroundColor: `${color}26`,
        borderColor: `${color}66`,
        boxShadow: `0 0 16px ${color}33`,
      }}
    >
      <span
        aria-hidden
        className="w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
      />
      {label}
    </button>
  );
}
