"use client";
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
          <div key={overlay.id} className={`absolute ${posClass}`}>
            <OverlayComponent overlay={overlay} />
          </div>
        );
      })}
    </div>
  );
}
