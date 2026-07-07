import { z } from "zod";

// A2UI catalog: Zod schemas define the contract between the agent and the UI.
// These schemas are injected into the agent's system prompt via the frontend tools.

export const overlayPositionSchema = z.enum([
  "top-left",
  "top-right",
  "top-center",
  "center-left",
  "center-right",
  "bottom-left",
  "bottom-right",
  "bottom-center",
  "full-bottom",
]);

export const catalogDefinitions = {
  MetricsPanel: {
    description:
      "A dark card with a title and 2-4 metric rows (label, value, optional delta). Good for KPIs, stats.",
    props: z.object({
      title: z.string().describe("Panel heading"),
      metrics: z.array(
        z.object({
          label: z.string(),
          value: z.string(),
          delta: z.string().optional().describe("e.g. '+12%' or '-3'"),
        })
      ).describe("2 to 4 metric rows"),
    }),
  },
  Timeline: {
    description:
      "Horizontal stepper with N labeled steps, current step highlighted. Good for tutorials, processes.",
    props: z.object({
      steps: z.array(z.object({ label: z.string() })),
      currentStep: z.number().describe("0-indexed active step"),
    }),
  },
  LowerThird: {
    description:
      "Broadcast-style name + subtitle bar. Classic TV lower-third. Use position bottom-left or full-bottom.",
    props: z.object({
      name: z.string().describe("Primary name / title"),
      subtitle: z.string().describe("Role, company, or context"),
    }),
  },
  ProgressBar: {
    description:
      "Full-width progress bar with optional label. Good for loading, completion status. Set `indeterminate: true` for an animated stripe (e.g. 'thinking', 'loading…') without a known percentage.",
    props: z.object({
      progress: z.number().min(0).max(100).describe("0-100"),
      label: z.string().optional(),
      indeterminate: z.boolean().optional(),
    }),
  },
  CountdownTimer: {
    description:
      "Big on-feed countdown clock. Walks green, amber, red on its own and counts overtime upward past zero. Ticks client-side: render it ONCE and never update it; to extend or restart, re-issue with new seconds.",
    props: z.object({
      seconds: z.number().min(1).max(14400).describe("Duration in seconds, e.g. 300 for five minutes"),
      label: z.string().optional().describe("Tiny caption above the digits, e.g. 'Q&A'"),
      startedAt: z.number().optional().describe("Set automatically on issue; always omit"),
    }),
  },
  KeywordHighlight: {
    description:
      "Floating glowing word chips. Good for emphasizing terms, hashtags, buzzwords.",
    props: z.object({
      keywords: z.array(z.string()).describe("Words to highlight"),
      color: z.string().describe("CSS color, e.g. '#22c55e' or 'cyan'"),
    }),
  },
  FloatingChart: {
    description: "Compact sparkline or bar chart in a small card. Good for trends, time series.",
    props: z.object({
      data: z.array(z.number()).describe("Array of numeric values"),
      chartType: z.enum(["line", "bar"]),
      label: z.string(),
    }),
  },
  ChatBubble: {
    description: "A speech bubble with text and optional author name.",
    props: z.object({
      text: z.string(),
      author: z.string().optional(),
    }),
  },
  Letterbox: {
    description:
      "Full-screen black bars top and bottom for cinematic 2.35:1 feel. No position needed.",
    props: z.object({
      enabled: z.boolean(),
    }),
  },
  Ticker: {
    description:
      "Horizontal scrolling text band, classic cable-news lower-third look. Best at full-bottom or top-center across the full width. Items loop seamlessly.",
    props: z.object({
      items: z.array(z.string()).describe("Short headlines or messages"),
      accent: z.string().optional().describe("CSS color for bullet dots, e.g. '#ef4444'"),
    }),
  },
  LiveBadge: {
    description:
      "Pulsing colored 'LIVE' pill. Use to mark a stream as live or call attention to anything happening right now. Tiny, sits in a corner.",
    props: z.object({
      label: z.string().optional().describe("Defaults to 'LIVE'. Keep ≤6 chars."),
      color: z.string().optional().describe("CSS color, defaults to red"),
    }),
  },
  StatRing: {
    description:
      "Radial donut progress ring with center percentage and a side label. Great for completion, capacity, score-out-of-100.",
    props: z.object({
      value: z.number().min(0).max(100).describe("0-100"),
      label: z.string(),
      color: z.string().optional().describe("CSS color, defaults to cyan"),
      size: z.number().optional().describe("Pixel size, defaults to 84"),
    }),
  },
  BigCounter: {
    description:
      "Huge animated number with a small label above. Counts up smoothly. Great for live viewers, sales, score, anything dramatic.",
    props: z.object({
      value: z.number(),
      label: z.string().describe("Tiny label above, e.g. 'VIEWERS'"),
      prefix: z.string().optional().describe("e.g. '$'"),
      suffix: z.string().optional().describe("e.g. ' watching'"),
      color: z.string().optional(),
    }),
  },
  ActionButton: {
    description:
      "The ONLY interactive component: a tappable Capturia button. Use it INSIDE render_surface (e.g. a poll, a reveal button, step navigation). When the viewer taps it, you receive a '[ACTION] <actionName>' turn and respond by changing the scene.",
    props: z.object({
      label: z.string().describe("Button caption shown to the viewer"),
      // min(1): an empty actionName would pass the sanitizer and render a
      // fully styled button whose taps are silently swallowed downstream
      // (A2uiOverlayLayer drops empty names). Reject the dead button at
      // authoring time instead.
      actionName: z
        .string()
        .min(1)
        .describe("Literal action id you receive back as '[ACTION] <actionName>' on tap"),
      color: z.string().optional().describe("CSS accent color, defaults to cyan"),
    }),
  },
} as const;

export type CatalogKey = keyof typeof catalogDefinitions;

// Types that only function inside render_surface trees. ActionButton's tap
// loop needs the interactive A2UI host (dispatch -> onSurfaceAction); placed
// as a standalone overlay it would render a dead button in Surface Mode and
// nothing at all in the direct React path. The placement tools (add_overlay,
// compose_scene) and the deck path validate against isPlaceableOverlayType so
// these can never leak out of authored surfaces.
export const SURFACE_ONLY_TYPES: ReadonlySet<string> = new Set(["ActionButton"]);

export function isPlaceableOverlayType(type: string): boolean {
  return type in catalogDefinitions && !SURFACE_ONLY_TYPES.has(type);
}
