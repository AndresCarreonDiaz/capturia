"use client";
import { useEffect, useRef } from "react";
import QRCode from "qrcode";

/**
 * On-feed QR code for audience voting. Deliberately part of the BROADCAST
 * look (it must survive Program Output, since the audience scans it off the
 * published feed), so it renders whenever voting is enabled, independent of
 * operator chrome. Canvas drawn at 2x for crisp capture after OBS scaling.
 */
export default function VoteQRBadge({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, url, { margin: 1, width: 192 }).catch(() => {});
  }, [url]);

  return (
    <div className="absolute bottom-24 right-4 z-20 flex flex-col items-center gap-1.5">
      <div className="rounded-xl bg-white p-1.5 border border-cyan-400/40 shadow-[0_0_24px_rgba(34,211,238,0.25)]">
        <canvas
          ref={canvasRef}
          className="h-24 w-24 rounded-md"
          role="img"
          aria-label={`QR code to vote at ${url}`}
        />
      </div>
      <span className="font-mono text-[10px] tracking-wide text-white/80 bg-black/60 px-2 py-0.5 rounded-full backdrop-blur-sm">
        {url.replace(/^https?:\/\//, "")}
      </span>
    </div>
  );
}
