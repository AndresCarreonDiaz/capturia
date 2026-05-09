"use client";
import { useLayoutEffect, useRef } from "react";
import { POSITION_CLASSES } from "@/lib/positions";
import { OverlayComponent } from "@/components/overlays";
import type { OverlaySpec } from "@/lib/types";

interface Props {
  overlays: OverlaySpec[];
}

export default function OverlayLayer({ overlays }: Props) {
  return (
    <div className="absolute inset-0 pointer-events-none">
      {overlays.map((overlay) => {
        if (overlay.type === "Letterbox") {
          return <OverlayComponent key={overlay.id} overlay={overlay} />;
        }
        const posClass = POSITION_CLASSES[overlay.position] ?? "top-4 left-4";
        return (
          <PositionedOverlay key={overlay.id} posClass={posClass}>
            <OverlayComponent overlay={overlay} />
          </PositionedOverlay>
        );
      })}
    </div>
  );
}

/**
 * FLIP-style position transition: when posClass changes, the outer wrapper
 * jumps to its new position, then the inner div animates from the previous
 * position via a transient `transform: translate(...)`. The outer's own
 * transform (e.g. `-translate-x-1/2`) is preserved on the outer wrapper.
 */
function PositionedOverlay({ posClass, children }: { posClass: string; children: React.ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const prevRectRef = useRef<DOMRect | null>(null);
  const prevPosRef = useRef<string>(posClass);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const newRect = el.getBoundingClientRect();
    if (prevPosRef.current !== posClass && prevRectRef.current) {
      const dx = prevRectRef.current.left - newRect.left;
      const dy = prevRectRef.current.top - newRect.top;
      if (dx !== 0 || dy !== 0) {
        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 500ms cubic-bezier(0.2, 0.8, 0.2, 1)";
          el.style.transform = "translate(0, 0)";
        });
      }
    }
    prevPosRef.current = posClass;
    prevRectRef.current = newRect;
  }, [posClass]);

  return (
    <div className={`absolute ${posClass}`}>
      <div ref={innerRef}>{children}</div>
    </div>
  );
}
