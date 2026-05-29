"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useStudioVoice } from "@/hooks/useStudioVoice";
import { useRecorder } from "@/hooks/useRecorder";
import { useDesktopHotkey } from "@/hooks/useDesktopHotkey";
import { useKeyVault } from "@/hooks/useKeyVault";
import type { KeyProvider } from "@/hooks/useDesktopHotkey";
import SettingsModal from "@/components/SettingsModal";
import DeckDropzone from "@/components/DeckDropzone";
import CueDeck from "@/components/CueDeck";
import { normalizeProps } from "@/lib/normalize";
import { matchCue } from "@/lib/deck/cues";
import type { CueCard, DeckFacts } from "@/lib/deck/types";
import type { OverlaySpec, OverlayPosition } from "@/lib/types";

export default function Studio() {
  // Studio is fullscreen, so lock body scroll while mounted so the landing
  // page's scroll behavior doesn't bleed in.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // BYOK: which stored key drives the agent. The active provider is the user's
  // explicit pick, else the first provider with a saved key, else gemini.
  const vault = useKeyVault();
  const [pickedProvider, setPickedProvider] = useState<KeyProvider | null>(null);
  const firstWithKey = vault.keys.find((k) => k.has)?.provider;
  const activeProvider: KeyProvider = pickedProvider ?? firstWithKey ?? "gemini";

  // The plaintext key must live in STATE, not a ref. CopilotKit resolves the
  // `headers` prop during render and rebuilds its request config when the
  // headers object identity changes, so a ref (which never triggers a
  // re-render) would leave it stuck with the mount-time empty headers and the
  // key would never reach the route. State -> re-render -> new headers object.
  const [byokKey, setByokKey] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    if (typeof window === "undefined" || !window.capturia?.keys?.get) {
      setByokKey("");
      return;
    }
    window.capturia.keys
      .get(activeProvider)
      .then((k) => {
        if (!cancelled) setByokKey(k ?? "");
      })
      .catch(() => {
        if (!cancelled) setByokKey("");
      });
    return () => {
      cancelled = true;
    };
  }, [activeProvider, vault.keys]);

  // On desktop with a key, send provider + key as request headers; the route's
  // agents factory reads them per request. On web there is no bridge, so we
  // send nothing and the route falls back to the env key.
  const headers = useMemo<Record<string, string>>(() => {
    const h: Record<string, string> = {};
    if (typeof window !== "undefined" && window.capturia?.isDesktop && byokKey) {
      h["x-capturia-provider"] = activeProvider;
      h["x-capturia-key"] = byokKey;
    }
    return h;
  }, [activeProvider, byokKey]);

  // Remount the provider when the active key/provider becomes available or
  // changes, so CopilotKit always builds its request client with the current
  // headers (it caches the client at mount). This only changes at load or on a
  // deliberate provider switch, before any overlays are on screen.
  return (
    <CopilotKit
      key={`${activeProvider}:${byokKey ? "byok" : "env"}`}
      runtimeUrl="/api/copilotkit"
      headers={headers}
    >
      <Capturia
        vault={vault}
        activeProvider={activeProvider}
        setActiveProvider={setPickedProvider}
      />
    </CopilotKit>
  );
}

interface CapturiaProps {
  vault: ReturnType<typeof useKeyVault>;
  activeProvider: KeyProvider;
  setActiveProvider: (p: KeyProvider) => void;
}

function Capturia({ vault, activeProvider, setActiveProvider }: CapturiaProps) {
  const [overlays, setOverlays] = useState<OverlaySpec[]>([]);
  const [lastSent, setLastSent] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const firstRunCheckedRef = useRef(false);
  const { appendMessage } = useCopilotChat();
  const { isRecording, startRecording, stopRecording } = useRecorder();

  // Deck state: cue cards to trigger, plus a compact view shared with the agent.
  const [cues, setCues] = useState<CueCard[]>([]);
  const [deckFacts, setDeckFacts] = useState<DeckFacts | null>(null);
  const [deckName, setDeckName] = useState<string | null>(null);
  const cuesRef = useRef<CueCard[]>([]);
  useEffect(() => {
    cuesRef.current = cues;
  }, [cues]);

  // Program Output: a chrome-free view (just webcam + overlays) that OBS (or a
  // future native camera extension) captures as the published feed.
  const [outputMode, setOutputMode] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("out") === "1") setOutputMode(true);
  }, []);

  // Cmd+, opens settings; Cmd/Ctrl+Shift+O toggles clean Program Output.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setOutputMode((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // First-run: if desktop and no BYOK keys saved yet, open Settings once.
  useEffect(() => {
    if (firstRunCheckedRef.current) return;
    if (!vault.isReady) return;
    firstRunCheckedRef.current = true;
    if (vault.isDesktop && !vault.keys.some((k) => k.has)) {
      setSettingsOpen(true);
    }
  }, [vault.isReady, vault.isDesktop, vault.keys]);

  // Apply a cue card's pre-built overlays (merge by id, like add_overlay).
  const applyCue = useCallback((card: CueCard) => {
    setOverlays((prev) => {
      const ids = new Set(card.specs.map((s) => s.id));
      const kept = prev.filter((o) => !ids.has(o.id));
      return [...kept, ...card.specs];
    });
  }, []);

  const { isListening, interimTranscript, speechStatus, lastError, isSupported, startListening, stopListening } =
    useStudioVoice((text) => {
      if (text.split(/\s+/).length < 2) return;
      setLastSent(text);
      // Deterministic, offline cue match first: "show my revenue slide" fires a
      // pre-built card without a model call. Falls through to the agent on miss.
      const card = matchCue(cuesRef.current, text);
      if (card) {
        applyCue(card);
        return;
      }
      appendMessage(
        new TextMessage({ content: `[VOICE] ${text}`, role: MessageRole.User })
      );
    });

  // Desktop push-to-talk: Cmd+Alt+Space toggles voice from anywhere on the OS.
  useDesktopHotkey("toggle-voice", () => {
    if (!isSupported) return;
    if (isListening) stopListening();
    else startListening();
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

  // Deck priming: the agent uses the speaker's real titles/numbers/names as the
  // source of truth, so spoken metrics render with deck values, not invented ones.
  useCopilotReadable({
    description:
      "Loaded pitch deck (if any). Slide titles, bullets, detected numbers (label/value), and names. When the speaker mentions something that appears here, render it using THESE exact values. Never invent numbers that contradict the deck.",
    value: deckFacts,
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
        isListening && !outputMode ? "mic-glow" : ""
      }`}
    >
      {/* Layer 0: webcam */}
      <WebcamFeed />

      {/* Layer 0.5: ambient floating particles when voice is active (hidden in clean output) */}
      {!outputMode && <AmbientParticles active={isListening} />}

      {/* Layer 1: A2UI overlay components (the published feed) */}
      <OverlayLayer overlays={overlays} />

      {/* Everything below is operator chrome, hidden in Program Output so OBS /
          the virtual camera capture only the webcam + overlays. */}
      {!outputMode && (
        <>
          {/* Layer 2: live voice captions */}
          <LiveCaptions
            text={interimTranscript}
            lastSent={lastSent}
            speechStatus={speechStatus}
            lastError={lastError}
            isListening={isListening}
          />

          {/* Layer 3: command bar */}
          <CommandBar
            overlays={overlays.map((o) => ({ id: o.id, type: o.type }))}
            onClear={() => setOverlays([])}
            isListening={isListening}
            onToggleVoice={() => (isListening ? stopListening() : startListening())}
            isVoiceSupported={isSupported}
          />

          {/* Left rail: deck cue cards */}
          <CueDeck
            cards={cues}
            fileName={deckName}
            onTrigger={applyCue}
            onClear={() => {
              setCues([]);
              setDeckFacts(null);
              setDeckName(null);
            }}
          />

          {/* Top-right HUD: deck + output + settings + LIVE pill + clock + record */}
          <div className="absolute top-3 right-4 z-30 flex items-center gap-3">
            {/* Load a pitch deck (PDF), client-side */}
            <DeckDropzone
              provider={activeProvider}
              onLoaded={({ cards, facts, fileName }) => {
                setCues(cards);
                setDeckFacts(facts);
                setDeckName(fileName);
              }}
            />

            {/* Enter clean Program Output (for OBS / virtual camera) */}
            <button
              onClick={() => setOutputMode(true)}
              title="Program Output for OBS / virtual camera (Cmd+Shift+O)"
              className="text-[11px] font-mono uppercase tracking-widest px-3 py-1.5 rounded-full bg-white/10 text-white/60 hover:bg-white/20 hover:text-white border border-white/10 transition-all"
            >
              Output
            </button>

            {/* Settings (desktop only) */}
            {vault.isDesktop && (
              <button
                onClick={() => setSettingsOpen(true)}
                title="Settings (Cmd+,)"
                aria-label="Settings"
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 text-white/50 hover:bg-white/20 hover:text-white/90 border border-white/10 transition-all"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            )}

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

          <SettingsModal
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            keys={vault.keys}
            isReady={vault.isReady}
            save={vault.save}
            clear={vault.clear}
            activeProvider={activeProvider}
            onSelectProvider={setActiveProvider}
          />
        </>
      )}

      {/* Program Output: a single hover-revealed control to exit, so the
          captured feed stays clean but the operator can leave the mode. */}
      {outputMode && (
        <button
          onClick={() => setOutputMode(false)}
          className="absolute top-3 right-3 z-30 text-[10px] font-mono uppercase tracking-widest px-2.5 py-1 rounded-full bg-black/50 text-white/40 border border-white/10 opacity-0 hover:opacity-100 transition-opacity"
          title="Exit Program Output (Cmd+Shift+O)"
        >
          Exit output
        </button>
      )}
    </div>
  );
}
