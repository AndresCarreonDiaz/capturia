"use client";
/**
 * SlotPreview renders a miniature live instance of each catalog component
 * inside a 16:9 monitor card on the landing page's catalog grid. The
 * component is rendered at its native size and scaled into the slot via
 * CSS transform, so the visual fidelity is the same as the studio.
 *
 * Letterbox is the one exception: the real Letterbox uses 11vh bars that
 * are page-relative, not slot-relative. We render a faked equivalent.
 *
 * Mount guard: some overlay components call `CSS.escape()` (StatRing,
 * FloatingChart) which is undefined under Node prerender. We defer the
 * preview until after hydration so SSR sees only the empty monitor.
 */
import { useEffect, useState } from "react";
import MetricsPanel from "@/components/overlays/MetricsPanel";
import BigCounter from "@/components/overlays/BigCounter";
import StatRing from "@/components/overlays/StatRing";
import ProgressBar from "@/components/overlays/ProgressBar";
import FloatingChart from "@/components/overlays/FloatingChart";
import Timeline from "@/components/overlays/Timeline";
import LowerThird from "@/components/overlays/LowerThird";
import KeywordHighlight from "@/components/overlays/KeywordHighlight";
import LiveBadge from "@/components/overlays/LiveBadge";
import Ticker from "@/components/overlays/Ticker";
import ChatBubble from "@/components/overlays/ChatBubble";

export type SlotCode =
  | "MTR" | "BCT" | "RNG" | "PRG" | "CHT" | "TLN"
  | "LTH" | "KWD" | "BDG" | "TKR" | "BUB" | "LBX";

/** Render an appropriate live preview for each catalog code. */
function PreviewBody({ code }: { code: SlotCode }) {
  switch (code) {
    case "MTR":
      return (
        <Scaled scale={0.6}>
          <MetricsPanel
            title="Q4 · 2026"
            metrics={[
              { label: "Revenue", value: "$1.8M", delta: "+24%" },
              { label: "Users", value: "18.2K", delta: "+12%" },
            ]}
          />
        </Scaled>
      );

    case "BCT":
      return (
        <Scaled scale={0.5}>
          <BigCounter value={12480} label="viewers" />
        </Scaled>
      );

    case "RNG":
      return (
        <Scaled scale={0.92}>
          <StatRing value={87} label="engage" size={68} />
        </Scaled>
      );

    case "PRG":
      return (
        <Scaled scale={0.7}>
          <div style={{ width: 220 }}>
            <ProgressBar progress={73} label="launch" />
          </div>
        </Scaled>
      );

    case "CHT":
      return (
        <Scaled scale={0.78}>
          <FloatingChart
            data={[3, 7, 5, 9, 12, 18, 14, 21, 17, 25]}
            chartType="line"
            label="growth"
          />
        </Scaled>
      );

    case "TLN":
      return (
        <Scaled scale={0.78}>
          <Timeline
            steps={[{ label: "plan" }, { label: "build" }, { label: "ship" }]}
            currentStep={1}
          />
        </Scaled>
      );

    case "LTH":
      return (
        <Scaled scale={0.62}>
          <LowerThird name="Andres" subtitle="Founder · Bubblio" />
        </Scaled>
      );

    case "KWD":
      return (
        <Scaled scale={0.7}>
          <div className="flex justify-center" style={{ width: 240 }}>
            <KeywordHighlight keywords={["ai", "live", "ship"]} color="auto" />
          </div>
        </Scaled>
      );

    case "BDG":
      return (
        <Scaled scale={1.0}>
          <LiveBadge label="On Air" color="#ef4444" />
        </Scaled>
      );

    case "TKR":
      return (
        <Scaled scale={0.55}>
          <div style={{ width: 460 }}>
            <Ticker items={["voice → screen", "agentic UI", "broadcast-grade"]} accent="#22d3ee" />
          </div>
        </Scaled>
      );

    case "BUB":
      return (
        <Scaled scale={0.62}>
          <ChatBubble text="Hello, studio." author="A" />
        </Scaled>
      );

    case "LBX":
      return <FakeLetterbox />;
  }
}

/** Wrap a child in a transform: scale() box, sized to its content. */
function Scaled({ scale, children }: { scale: number; children: React.ReactNode }) {
  return (
    <div
      style={{
        transform: `scale(${scale})`,
        transformOrigin: "center center",
      }}
    >
      {children}
    </div>
  );
}

/** A faux Letterbox preview. The real component uses 11vh bars that would
 *  blow the slot card; here we draw proportional bars to convey the look. */
function FakeLetterbox() {
  return (
    <div className="absolute inset-0">
      <div
        className="absolute top-0 inset-x-0 bg-black border-b border-white/[0.04]"
        style={{ height: "22%" }}
      />
      <div
        className="absolute bottom-0 inset-x-0 bg-black border-t border-white/[0.04]"
        style={{ height: "22%" }}
      />
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center">
        <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-white/35">
          Cinematic
        </span>
      </div>
    </div>
  );
}

/**
 * Outer monitor frame. Renders the placeholder camera-card surface (scanlines,
 * vignette) and centers the preview inside.
 */
export default function SlotPreview({ code }: { code: SlotCode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="relative w-full aspect-[16/9] overflow-hidden border-b border-white/[0.06] bg-gradient-to-br from-[#0c0e12] via-[#0a0b0e] to-[#15181d]">
      {/* Atmosphere */}
      <div aria-hidden className="absolute inset-0 crt-grid opacity-80" />
      <div aria-hidden className="absolute inset-0 crt-scanlines opacity-60" />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.6) 100%)",
        }}
      />
      {/* Centered live component (client-only, see comment above) */}
      {mounted && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <PreviewBody code={code} />
        </div>
      )}
    </div>
  );
}
