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

interface Props {
  overlay: OverlaySpec;
}

export function OverlayComponent({ overlay }: Props) {
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
    case "Letterbox":
      return <Letterbox {...overlay.props} />;
    default:
      return null;
  }
}
