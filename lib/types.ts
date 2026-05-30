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

// A single node in an agent-authored A2UI v0.9 surface tree (the `render_surface`
// tool). Flat format: every node has an id + a `component` type string, props ride
// as sibling keys, and children are referenced by id (array for Row/Column/List,
// single `child` for container slots). Deliberately loose: the wire shape is
// validated and sanitized by sanitizeSurfaceTree() in lib/a2ui-validate.ts before
// it ever reaches state, so this type is a structural hint, not a guarantee.
export interface A2uiNode {
  id: string;
  component: string;
  child?: string;
  // Child ids only. The wire format also permits a data-bound list object, but
  // sanitizeSurfaceTree (lib/a2ui-validate.ts) rejects that form (no data model
  // in v1), so the type matches what actually survives validation.
  children?: string[];
  [key: string]: unknown;
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
      props: { progress: number; label?: string; indeterminate?: boolean };
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
    }
  | {
      id: string;
      type: "Ticker";
      position: OverlayPosition;
      props: { items: string[]; accent?: string };
    }
  | {
      id: string;
      type: "LiveBadge";
      position: OverlayPosition;
      props: { label?: string; color?: string };
    }
  | {
      id: string;
      type: "StatRing";
      position: OverlayPosition;
      props: { value: number; label: string; color?: string; size?: number };
    }
  | {
      id: string;
      type: "BigCounter";
      position: OverlayPosition;
      props: { value: number; label: string; prefix?: string; suffix?: string; color?: string };
    }
  | {
      // Agent-authored A2UI surface: the model composes a whole component tree
      // (layout primitives wrapping branded Capturia overlays) rather than
      // placing one fixed leaf. Rendered through the real A2UI v0.9 runtime by a
      // dedicated A2uiOverlayLayer. `components` is the sanitized flat node list
      // (root id "root"); the client owns the surface envelope + lifecycle.
      id: string;
      type: "Surface";
      position: OverlayPosition;
      props: { components: A2uiNode[] };
    };
