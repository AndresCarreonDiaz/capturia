"use client";
import { useEffect, useRef } from "react";
import QRCode from "qrcode";
import {
  MIN_QR_CSS_PX,
  QR_ERROR_CORRECTION,
  QR_QUIET_ZONE_MODULES,
  qrDisplaySize,
} from "@/lib/legibility";

/**
 * On-feed QR code for audience voting. Deliberately part of the BROADCAST
 * look (it must survive Program Output, since the audience scans it off the
 * published feed), so it renders whenever voting is enabled, independent of
 * operator chrome.
 *
 * Compression resilience (lib/legibility.ts): error correction H so the code
 * survives re-encoding, an in-canvas quiet zone, and a display size derived
 * from the module count so every module keeps a scannable on-feed footprint
 * even for longer vote URLs.
 *
 * Sizing is imperative on purpose: qrcode's canvas renderer stamps an inline
 * style equal to the backing size it draws, which beats any className or
 * React style prop (the previous h-24 class silently never applied). So the
 * canvas is drawn at 2x density and its inline style is overridden to the
 * intended CSS size right after each render.
 */
export default function VoteQRBadge({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let size = MIN_QR_CSS_PX;
    try {
      const modules = QRCode.create(url, { errorCorrectionLevel: QR_ERROR_CORRECTION })
        .modules.size;
      size = qrDisplaySize(modules);
    } catch {
      // Unencodable url: keep the floor size; toCanvas below fails too and
      // leaves the canvas blank at a sane footprint.
    }
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    QRCode.toCanvas(canvas, url, {
      errorCorrectionLevel: QR_ERROR_CORRECTION,
      margin: QR_QUIET_ZONE_MODULES,
      width: size * 2,
    })
      .then(() => {
        // Re-assert the CSS size over the renderer's own inline stamp.
        canvas.style.width = `${size}px`;
        canvas.style.height = `${size}px`;
      })
      .catch(() => {});
  }, [url]);

  return (
    <div className="absolute bottom-24 right-4 z-20 flex flex-col items-center gap-1.5">
      <div className="rounded-xl bg-white p-1.5 border border-cyan-400/40 shadow-[0_0_24px_rgba(34,211,238,0.25)]">
        <canvas
          ref={canvasRef}
          className="rounded-md"
          role="img"
          aria-label={`QR code to vote at ${url}`}
        />
      </div>
      <span className="font-mono text-xs tracking-wide text-white/80 bg-black/60 px-2 py-0.5 rounded-full backdrop-blur-sm">
        {url.replace(/^https?:\/\//, "")}
      </span>
    </div>
  );
}
