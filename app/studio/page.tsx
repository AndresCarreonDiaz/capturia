"use client";
import { useEffect, useState } from "react";
import { CopilotKit } from "@copilotkit/react-core";
import {
  useCopilotReadable,
  useCopilotAction,
  useCopilotChat,
} from "@copilotkit/react-core";
import { TextMessage, MessageRole } from "@copilotkit/runtime-client-gql";
import WebcamFeed from "@/components/WebcamFeed";
import OverlayLayer from "@/components/OverlayLayer";
import CommandBar from "@/components/CommandBar";
import LiveCaptions from "@/components/LiveCaptions";
import HudClock from "@/components/HudClock";
import AmbientParticles from "@/components/AmbientParticles";
// Real A2UI catalog object: createCatalog() is invoked at module load,
// registering all 12 component renderers against the typed Zod definitions.
// Currently exposed for future <A2UIRenderer/> use; runtime stays AG-UI.
import { capturiaCatalog } from "@/lib/a2ui-catalog";

if (typeof window !== "undefined") {
  // Surface the catalog for inspection / future A2UI surface hosting.
  (window as unknown as { capturiaCatalog?: unknown }).capturiaCatalog = capturiaCatalog;
}
import { useVoiceCapture } from "@/hooks/useVoiceCapture";
import { useRecorder } from "@/hooks/useRecorder";
import type { OverlaySpec, OverlayPosition } from "@/lib/types";

export default function Studio() {
  // Studio is fullscreen — lock body scroll while mounted so the landing
  // page's scroll behavior doesn't bleed in.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
      <Capturia />
    </CopilotKit>
  );
}

/**
 * Normalize agent-provided props for a given overlay type. Runs on both
 * add_overlay (full props) and modify_overlay (merged props), so a partial
 * update can't poison the existing overlay's shape.
 */
function normalizeProps(type: string, props: Record<string, unknown>): Record<string, unknown> {
  const out = { ...props };

  if (type === "KeywordHighlight") {
    const kws = out.keywords;
    if (typeof kws === "string") {
      out.keywords = kws.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (Array.isArray(kws)) {
      out.keywords = kws.map((k: unknown) =>
        typeof k === "string" ? k : (k as Record<string, string>)?.text ?? String(k)
      );
    }
  }

  if (type === "FloatingChart" && Array.isArray(out.data)) {
    out.data = (out.data as unknown[])
      .map((d) => (typeof d === "number" ? d : Number((d as Record<string, unknown>)?.value ?? d)))
      .filter((n) => Number.isFinite(n));
  }

  if (type === "MetricsPanel") {
    const raw = out.metrics;
    out.metrics = Array.isArray(raw)
      ? (raw as unknown[])
          .map((m) => {
            if (!m || typeof m !== "object") return null;
            const r = m as Record<string, unknown>;
            if (typeof r.label !== "string") return null;
            return {
              label: r.label,
              value: typeof r.value === "string" ? r.value : String(r.value ?? ""),
              delta:
                r.delta == null
                  ? undefined
                  : typeof r.delta === "string"
                  ? r.delta
                  : String(r.delta),
            };
          })
          .filter(Boolean)
      : [];
  }

  if (type === "Timeline") {
    const raw = out.steps;
    out.steps = Array.isArray(raw)
      ? (raw as unknown[])
          .map((s) => {
            if (typeof s === "string") return { label: s };
            if (s && typeof s === "object") {
              const label = (s as Record<string, unknown>).label;
              if (typeof label === "string") return { label };
            }
            return null;
          })
          .filter(Boolean)
      : [];
    const cs = out.currentStep;
    out.currentStep = typeof cs === "number" ? cs : Number(cs ?? 0) || 0;
  }

  if (type === "Ticker") {
    const raw = out.items;
    if (typeof raw === "string") {
      out.items = raw.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (Array.isArray(raw)) {
      out.items = (raw as unknown[]).map((it) =>
        typeof it === "string" ? it : (it as Record<string, string>)?.text ?? String(it)
      );
    } else {
      out.items = [];
    }
  }

  return out;
}

function Capturia() {
  const [overlays, setOverlays] = useState<OverlaySpec[]>([]);
  const [lastSent, setLastSent] = useState("");
  const { appendMessage } = useCopilotChat();
  const { isRecording, startRecording, stopRecording } = useRecorder();

  const { isListening, interimTranscript, speechStatus, lastError, isSupported, startListening, stopListening } =
    useVoiceCapture((text) => {
      if (text.split(/\s+/).length < 2) return;
      setLastSent(text);
      appendMessage(
        new TextMessage({ content: `[VOICE] ${text}`, role: MessageRole.User })
      );
    });

  // AG-UI Shared State: agent always knows what's currently on screen
  useCopilotReadable({
    description:
      "Current overlay components on the live video feed. Each has an id, type, position, and props.",
    value: overlays.map((o) => ({
      id: o.id,
      type: o.type,
      position: o.type !== "Letterbox" ? o.position : "full-screen",
      props: o.props,
    })),
  });

  // A2UI Action: add a new spatial overlay component
  useCopilotAction({
    name: "add_overlay",
    description:
      "Add a new overlay component to the live video feed. Use the A2UI catalog component types and positions.",
    parameters: [
      {
        name: "id",
        type: "string",
        description: "Unique id like 'metrics-1' or 'lower-third-main'",
        required: true,
      },
      {
        name: "type",
        type: "string",
        description:
          "Component type: MetricsPanel | Timeline | LowerThird | ProgressBar | KeywordHighlight | FloatingChart | ChatBubble | Letterbox | Ticker | LiveBadge | StatRing | BigCounter",
        required: true,
      },
      {
        name: "position",
        type: "string",
        description:
          "Anchor: top-left | top-right | top-center | center-left | center-right | bottom-left | bottom-right | bottom-center | full-bottom (omit for Letterbox)",
        required: false,
      },
      {
        name: "props",
        type: "string",
        description: "JSON string of component-specific props matching the catalog schema",
        required: true,
      },
    ],
    handler: ({ id, type, position, props: propsStr }) => {
      let props: Record<string, unknown>;
      try {
        props = JSON.parse(propsStr);
      } catch {
        console.error("Invalid props JSON:", propsStr);
        return;
      }
      const normalized = normalizeProps(type, props);
      setOverlays((prev) => {
        const filtered = prev.filter((o) => o.id !== id);
        return [
          ...filtered,
          { id, type, position: position as OverlayPosition, props: normalized } as OverlaySpec,
        ];
      });
    },
  });

  // A2UI Action: modify an existing overlay's props
  useCopilotAction({
    name: "modify_overlay",
    description: "Update props of an existing overlay without changing its type or position.",
    parameters: [
      {
        name: "id",
        type: "string",
        description: "The id of the overlay to modify",
        required: true,
      },
      {
        name: "props",
        type: "string",
        description: "New props as JSON string (merged with existing props)",
        required: true,
      },
    ],
    handler: ({ id, props: propsStr }) => {
      let newProps: Record<string, unknown>;
      try {
        newProps = JSON.parse(propsStr);
      } catch {
        return;
      }
      setOverlays((prev) =>
        prev.map((o) => {
          if (o.id !== id) return o;
          const merged = { ...(o.props as Record<string, unknown>), ...newProps };
          const normalized = normalizeProps(o.type, merged);
          return { ...o, props: normalized } as OverlaySpec;
        })
      );
    },
  });

  // A2UI Action: remove an overlay
  useCopilotAction({
    name: "remove_overlay",
    description: "Remove an overlay from the video by id. Use 'all' to remove every overlay.",
    parameters: [
      {
        name: "id",
        type: "string",
        description: "The overlay id to remove, or 'all' to remove every overlay",
        required: true,
      },
    ],
    handler: ({ id }) => {
      if (id === "all") {
        setOverlays([]);
      } else {
        setOverlays((prev) => prev.filter((o) => o.id !== id));
      }
    },
  });

  // A2UI Action: smoothly relocate an overlay to a new anchor position
  useCopilotAction({
    name: "move_overlay",
    description:
      "Move an existing overlay to a new anchor position. The overlay slides smoothly between positions. Cannot be used on Letterbox.",
    parameters: [
      { name: "id", type: "string", description: "The overlay id to move", required: true },
      {
        name: "position",
        type: "string",
        description:
          "New anchor: top-left | top-right | top-center | center-left | center-right | bottom-left | bottom-right | bottom-center | full-bottom",
        required: true,
      },
    ],
    handler: ({ id, position }) => {
      setOverlays((prev) =>
        prev.map((o) => {
          if (o.id !== id || o.type === "Letterbox") return o;
          return { ...o, position: position as OverlayPosition } as OverlaySpec;
        })
      );
    },
  });

  // A2UI Action: append values to a FloatingChart's data array (live-growing chart)
  useCopilotAction({
    name: "append_chart_data",
    description:
      "Append one or more numeric values to a FloatingChart's data series. Use to grow charts over time as new data points come in. Pass values as a JSON array of numbers, e.g. '[42, 47, 51]'.",
    parameters: [
      { name: "id", type: "string", description: "The FloatingChart id", required: true },
      {
        name: "values",
        type: "string",
        description: "JSON array of numbers to append, e.g. '[42, 47]'",
        required: true,
      },
    ],
    handler: ({ id, values: valuesStr }) => {
      let values: number[] = [];
      try {
        const parsed = JSON.parse(valuesStr);
        if (Array.isArray(parsed)) {
          values = parsed
            .map((v) => (typeof v === "number" ? v : Number(v)))
            .filter((v) => Number.isFinite(v));
        }
      } catch {
        return;
      }
      if (values.length === 0) return;
      setOverlays((prev) =>
        prev.map((o) => {
          if (o.id !== id || o.type !== "FloatingChart") return o;
          const next = [...o.props.data, ...values].slice(-30);
          return { ...o, props: { ...o.props, data: next } };
        })
      );
    },
  });

  // A2UI Action: update a single metric row in a MetricsPanel
  useCopilotAction({
    name: "bump_metric",
    description:
      "Update a single metric row in an existing MetricsPanel by label. The new value count-ups smoothly and the row flashes green/red based on direction. Use this to show live KPI changes.",
    parameters: [
      { name: "id", type: "string", description: "The MetricsPanel id", required: true },
      { name: "label", type: "string", description: "The metric row label to update", required: true },
      { name: "value", type: "string", description: "New value, e.g. '$1.2M' or '47%'", required: true },
      {
        name: "delta",
        type: "string",
        description: "Optional new delta, e.g. '+12%' or '-3'. Pass empty string to clear.",
        required: false,
      },
    ],
    handler: ({ id, label, value, delta }) => {
      setOverlays((prev) =>
        prev.map((o) => {
          if (o.id !== id || o.type !== "MetricsPanel") return o;
          const metrics = o.props.metrics.map((m) =>
            m.label === label
              ? { ...m, value, ...(delta !== undefined ? { delta: delta || undefined } : {}) }
              : m
          );
          return { ...o, props: { ...o.props, metrics } };
        })
      );
    },
  });

  return (
    <div
      className={`relative w-screen h-screen bg-black overflow-hidden ${
        isListening ? "mic-glow" : ""
      }`}
    >
      {/* Layer 0: webcam */}
      <WebcamFeed />

      {/* Layer 0.5: ambient floating particles when voice is active */}
      <AmbientParticles active={isListening} />

      {/* Layer 1: A2UI overlay components */}
      <OverlayLayer overlays={overlays} />

      {/* Layer 2: live voice captions (above overlays, below command bar) */}
      <LiveCaptions text={interimTranscript} lastSent={lastSent} speechStatus={speechStatus} lastError={lastError} isListening={isListening} />

      {/* Layer 3: command bar */}
      <CommandBar
        overlays={overlays.map((o) => ({ id: o.id, type: o.type }))}
        onClear={() => setOverlays([])}
        isListening={isListening}
        onToggleVoice={() => (isListening ? stopListening() : startListening())}
        isVoiceSupported={isSupported}
      />

      {/* Top-right HUD: LIVE pill + clock + record */}
      <div className="absolute top-3 right-4 z-30 flex items-center gap-3">
        {/* Record toggle */}
        <button
          onClick={() => (isRecording ? stopRecording() : startRecording())}
          className={`flex items-center gap-1.5 text-xs font-mono uppercase tracking-widest px-3 py-1.5 rounded-full transition-all ${
            isRecording
              ? "bg-red-600 text-white"
              : "bg-white/10 text-white/50 hover:bg-white/20 hover:text-white/80 border border-white/10"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              isRecording ? "bg-white live-dot-pulse" : "bg-red-500"
            }`}
          />
          {isRecording ? "Stop" : "Rec"}
        </button>

        {/* Live clock */}
        <div className="px-2.5 py-1 rounded-md bg-black/40 border border-white/10 backdrop-blur-md pointer-events-none">
          <HudClock />
        </div>

        {/* LIVE pill */}
        <div className="flex items-center gap-1.5 bg-red-600/95 px-2.5 py-1 rounded-md shadow-[0_0_12px_rgba(239,68,68,0.4)] pointer-events-none">
          <span className="w-1.5 h-1.5 rounded-full bg-white live-dot-pulse" />
          <span className="text-white text-[10px] font-bold tracking-[0.2em] uppercase">
            Live
          </span>
        </div>
      </div>
    </div>
  );
}
