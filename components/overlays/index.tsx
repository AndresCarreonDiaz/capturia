"use client";
import type { OverlaySpec } from "@/lib/types";
import MetricsPanel from "./MetricsPanel";
import Timeline from "./Timeline";
import LowerThird from "./LowerThird";
import ProgressBar from "./ProgressBar";
import KeywordHighlight from "./KeywordHighlight";
import FloatingChart from "./FloatingChart";
import ChatBubble from "./ChatBubble";
import Letterbox from "./Letterbox";
import Ticker from "./Ticker";
import LiveBadge from "./LiveBadge";
import StatRing from "./StatRing";
import BigCounter from "./BigCounter";

export const STAGGER_MS = 60;

export const ENTER_CLASS: Record<OverlaySpec["type"], string> = {
  MetricsPanel: "overlay-enter",
  Timeline: "overlay-enter",
  LowerThird: "overlay-enter-left",
  ProgressBar: "overlay-enter",
  KeywordHighlight: "overlay-enter",
  FloatingChart: "overlay-enter",
  ChatBubble: "overlay-enter-bottom",
  Letterbox: "",
  Ticker: "overlay-enter-bottom",
  LiveBadge: "overlay-enter-scale",
  StatRing: "overlay-enter-scale",
  BigCounter: "overlay-enter",
  // Authored surfaces (render_surface) only render through the A2UI host
  // (A2uiOverlay), never the direct switch below; the whole composed tree fades
  // in as one unit via this wrapper class.
  Surface: "overlay-enter",
};

// The enter/exit animation wrapper props for an overlay. Shared so the direct
// React path (OverlayComponent) and the A2UI Surface Mode host (A2uiOverlay)
// animate identically; the keyframes live on this wrapper, not inside the
// components, so they compose with either inner renderer.
export function overlayAnimProps(
  type: OverlaySpec["type"],
  exiting: boolean,
  enterIndex: number
): { className: string; style?: React.CSSProperties } {
  const className = exiting ? "overlay-exit" : ENTER_CLASS[type];
  const style =
    !exiting && enterIndex > 0
      ? { animationDelay: `${enterIndex * STAGGER_MS}ms` }
      : undefined;
  return { className, style };
}

interface Props {
  overlay: OverlaySpec;
  exiting?: boolean;
  enterIndex?: number;
}

export function OverlayComponent({ overlay, exiting = false, enterIndex = 0 }: Props) {
  if (overlay.type === "Letterbox") {
    return <Letterbox {...overlay.props} exiting={exiting} />;
  }
  const { className, style } = overlayAnimProps(overlay.type, exiting, enterIndex);
  return (
    <div className={className} style={style}>
      <Inner overlay={overlay} />
    </div>
  );
}

function Inner({ overlay }: { overlay: Exclude<OverlaySpec, { type: "Letterbox" }> }) {
  switch (overlay.type) {
    case "MetricsPanel":
      return <MetricsPanel {...overlay.props} />;
    case "Timeline":
      return <Timeline {...overlay.props} />;
    case "LowerThird":
      return <LowerThird {...overlay.props} />;
    case "ProgressBar":
      return <ProgressBar {...overlay.props} />;
    case "KeywordHighlight":
      return <KeywordHighlight {...overlay.props} />;
    case "FloatingChart":
      return <FloatingChart {...overlay.props} />;
    case "ChatBubble":
      return <ChatBubble {...overlay.props} />;
    case "Ticker":
      return <Ticker {...overlay.props} />;
    case "LiveBadge":
      return <LiveBadge {...overlay.props} />;
    case "StatRing":
      return <StatRing {...overlay.props} />;
    case "BigCounter":
      return <BigCounter {...overlay.props} />;
    case "Surface":
      // Agent-authored surfaces require the A2UI renderer; the direct React path
      // never renders them (the studio routes them to a dedicated A2uiOverlayLayer).
      return null;
  }
}
