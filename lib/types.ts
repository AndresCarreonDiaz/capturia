export type OverlayPosition =
  | "top-left"
  | "top-right"
  | "top-center"
  | "center-left"
  | "center-right"
  | "bottom-left"
  | "bottom-right"
  | "bottom-center"
  | "full-bottom";

export interface MetricRow {
  label: string;
  value: string;
  delta?: string;
}

export interface TimelineStep {
  label: string;
}

export type OverlaySpec =
  | {
      id: string;
      type: "MetricsPanel";
      position: OverlayPosition;
      props: { title: string; metrics: MetricRow[] };
    }
  | {
      id: string;
      type: "Timeline";
      position: OverlayPosition;
      props: { steps: TimelineStep[]; currentStep: number };
    }
  | {
      id: string;
      type: "LowerThird";
      position: OverlayPosition;
      props: { name: string; subtitle: string };
    }
  | {
      id: string;
      type: "ProgressBar";
      position: OverlayPosition;
      props: { progress: number; label?: string };
    }
  | {
      id: string;
      type: "KeywordHighlight";
      position: OverlayPosition;
      props: { keywords: string[]; color: string };
    }
  | {
      id: string;
      type: "FloatingChart";
      position: OverlayPosition;
      props: { data: number[]; chartType: "line" | "bar"; label: string };
    }
  | {
      id: string;
      type: "ChatBubble";
      position: OverlayPosition;
      props: { text: string; author?: string };
    }
  | {
      id: string;
      type: "Letterbox";
      position?: never;
      props: { enabled: boolean };
    };
