"use client";
import { useState } from "react";
import { CopilotKit } from "@copilotkit/react-core";
import {
  useCopilotReadable,
  useCopilotAction,
} from "@copilotkit/react-core";
import WebcamFeed from "@/components/WebcamFeed";
import OverlayLayer from "@/components/OverlayLayer";
import CommandBar from "@/components/CommandBar";
import type { OverlaySpec, OverlayPosition } from "@/lib/types";

export default function Home() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
      <LiveStage />
    </CopilotKit>
  );
}

function LiveStage() {
  const [overlays, setOverlays] = useState<OverlaySpec[]>([]);

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
          "Component type: MetricsPanel | Timeline | LowerThird | ProgressBar | KeywordHighlight | FloatingChart | ChatBubble | Letterbox",
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
      // Normalize KeywordHighlight: keywords may arrive as [{text:"..."}, ...] or "word1, word2"
      if (type === "KeywordHighlight") {
        const kws = props.keywords;
        if (typeof kws === "string") {
          props.keywords = kws.split(",").map((s: string) => s.trim());
        } else if (Array.isArray(kws)) {
          props.keywords = kws.map((k: unknown) =>
            typeof k === "string" ? k : (k as Record<string, string>)?.text ?? String(k)
          );
        }
      }
      // Normalize FloatingChart: data may arrive as [{value:n}, ...]
      if (type === "FloatingChart" && Array.isArray(props.data)) {
        props.data = (props.data as unknown[]).map((d) =>
          typeof d === "number" ? d : Number((d as Record<string, unknown>)?.value ?? d)
        );
      }
      setOverlays((prev) => {
        const filtered = prev.filter((o) => o.id !== id);
        return [
          ...filtered,
          { id, type, position: position as OverlayPosition, props } as OverlaySpec,
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
        prev.map((o) =>
          o.id === id ? ({ ...o, props: { ...o.props, ...newProps } } as OverlaySpec) : o
        )
      );
    },
  });

  // A2UI Action: remove an overlay
  useCopilotAction({
    name: "remove_overlay",
    description: "Remove an overlay from the video by id. Use 'all' to clear everything.",
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

  return (
    <div className="relative w-screen h-screen bg-black overflow-hidden">
      {/* Layer 0: webcam */}
      <WebcamFeed />

      {/* Layer 1: A2UI overlay components */}
      <OverlayLayer overlays={overlays} />

      {/* Layer 2: command bar */}
      <CommandBar
        overlays={overlays.map((o) => ({ id: o.id, type: o.type }))}
        onClear={() => setOverlays([])}
      />

      {/* Branding */}
      <div className="absolute top-3 right-4 z-10 flex items-center gap-2 pointer-events-none">
        <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse shadow-[0_0_8px_#ef4444]" />
        <span className="text-white/60 text-xs font-mono tracking-widest uppercase">LiveStage</span>
      </div>
    </div>
  );
}
