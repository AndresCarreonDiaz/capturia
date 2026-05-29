"use client";
/**
 * LiveDemo: the signature hero composition. A 16:9 broadcast viewfinder
 * that uses the actual production overlay components (same code as the studio)
 * driven by a deterministic scene loop. The visitor sees the product working
 * before they read a single word.
 *
 * The "camera" is a placeholder gradient: we never ask for getUserMedia on
 * a marketing page. The atmosphere comes from CRT scanlines, the slow
 * scanline sweep, and a soft vignette.
 */
import { useEffect, useRef, useState } from "react";
import OverlayLayer from "@/components/OverlayLayer";
import type { OverlaySpec } from "@/lib/types";

interface SceneCue {
  at: number;
  text: string;
}

type SceneAction =
  | { at: number; kind: "set"; overlay: OverlaySpec }
  | { at: number; kind: "remove"; id: string }
  | { at: number; kind: "patch"; id: string; patch: (o: OverlaySpec) => OverlaySpec };

interface Scene {
  name: string;
  duration: number;
  cues: SceneCue[];
  actions: SceneAction[];
}

const SCENES: Scene[] = [
  {
    name: "Intro",
    duration: 6800,
    cues: [
      { at: 200, text: "I'm Andres, founder of Bubblio" },
      { at: 3600, text: "Drop a live badge top right" },
    ],
    actions: [
      {
        at: 700,
        kind: "set",
        overlay: {
          id: "lt-1",
          type: "LowerThird",
          position: "bottom-center",
          props: { name: "Andres Carreon", subtitle: "Founder · Bubblio" },
        },
      },
      {
        at: 3900,
        kind: "set",
        overlay: {
          id: "lb-1",
          type: "LiveBadge",
          position: "top-right",
          props: { label: "On Air", color: "red" },
        },
      },
    ],
  },
  {
    name: "Numbers",
    duration: 9500,
    cues: [
      { at: 200, text: "Q4 stats: revenue 1.8M, users 18K, churn 2.1%" },
      { at: 4800, text: "Bump revenue to 2.1M" },
      { at: 7200, text: "Launch readiness at 73%" },
    ],
    actions: [
      { at: 0, kind: "remove", id: "lb-1" },
      { at: 250, kind: "remove", id: "lt-1" },
      {
        at: 900,
        kind: "set",
        overlay: {
          id: "mp-1",
          type: "MetricsPanel",
          position: "top-left",
          props: {
            title: "Q4 · 2026",
            metrics: [
              { label: "Revenue", value: "$1.8M", delta: "+24%" },
              { label: "Users", value: "18.2K", delta: "+12%" },
              { label: "Churn", value: "2.1%", delta: "-0.4%" },
            ],
          },
        },
      },
      {
        at: 5100,
        kind: "patch",
        id: "mp-1",
        patch: (o) => {
          if (o.type !== "MetricsPanel") return o;
          return {
            ...o,
            props: {
              ...o.props,
              metrics: o.props.metrics.map((m) =>
                m.label === "Revenue" ? { ...m, value: "$2.1M", delta: "+33%" } : m
              ),
            },
          };
        },
      },
      {
        at: 7500,
        kind: "set",
        overlay: {
          id: "pb-1",
          type: "ProgressBar",
          position: "top-center",
          props: { progress: 73, label: "Launch readiness" },
        },
      },
    ],
  },
  {
    name: "Audience",
    duration: 8000,
    cues: [
      { at: 200, text: "Big counter, twelve thousand viewers" },
      { at: 3600, text: "Bump to twenty-four thousand eight hundred" },
      { at: 5800, text: "Engagement ring at 87%" },
    ],
    actions: [
      { at: 0, kind: "remove", id: "mp-1" },
      { at: 250, kind: "remove", id: "pb-1" },
      {
        at: 900,
        kind: "set",
        overlay: {
          id: "bc-1",
          type: "BigCounter",
          position: "top-right",
          props: { value: 12000, label: "viewers" },
        },
      },
      {
        at: 3900,
        kind: "patch",
        id: "bc-1",
        patch: (o) =>
          o.type === "BigCounter" ? { ...o, props: { ...o.props, value: 24800 } } : o,
      },
      {
        at: 6100,
        kind: "set",
        overlay: {
          id: "sr-1",
          type: "StatRing",
          position: "top-left",
          props: { value: 87, label: "engagement", size: 110 },
        },
      },
    ],
  },
  {
    name: "Highlight",
    duration: 7000,
    cues: [
      { at: 200, text: "Highlight: ai · agentic · live · ship" },
      { at: 3500, text: "Add a ticker: voice to screen, broadcast-grade" },
    ],
    actions: [
      { at: 0, kind: "remove", id: "bc-1" },
      { at: 250, kind: "remove", id: "sr-1" },
      {
        at: 900,
        kind: "set",
        overlay: {
          id: "kh-1",
          type: "KeywordHighlight",
          position: "top-left",
          props: { keywords: ["ai", "agentic", "live", "ship"], color: "auto" },
        },
      },
      {
        at: 3800,
        kind: "set",
        overlay: {
          id: "tk-1",
          type: "Ticker",
          position: "full-bottom",
          props: {
            items: [
              "voice → screen",
              "agentic UI",
              "broadcast-grade",
              "shipped solo",
              "under 1s latency",
            ],
            accent: "cyan",
          },
        },
      },
    ],
  },
  {
    name: "Clear",
    duration: 3500,
    cues: [{ at: 200, text: "Clear everything, fade them out" }],
    actions: [
      { at: 500, kind: "remove", id: "kh-1" },
      { at: 600, kind: "remove", id: "tk-1" },
    ],
  },
];

/** Single source of truth for the timecode shown in chrome.
 *  We tick once a second on the client; resets to 0 on mount. */
function useTimecode() {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const hh = String(Math.floor(t / 3600)).padStart(2, "0");
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Character-by-character reveal of the current cue. Re-keyed on text change. */
function CueText({ text }: { text: string }) {
  const [shown, setShown] = useState("");
  useEffect(() => {
    setShown("");
    if (!text) return;
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, 26);
    return () => clearInterval(id);
  }, [text]);
  return <span>{shown}</span>;
}

export default function LiveDemo() {
  const [overlays, setOverlays] = useState<OverlaySpec[]>([]);
  const [sceneIdx, setSceneIdx] = useState(0);
  const [cue, setCue] = useState("");
  const tc = useTimecode();

  // We only want the scene loop to start once: never restart from state changes.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const runScene = (idx: number) => {
      if (cancelled) return;
      const scene = SCENES[idx];
      setSceneIdx(idx);
      setCue("");

      scene.cues.forEach((c) => {
        timers.push(
          setTimeout(() => {
            if (!cancelled) setCue(c.text);
          }, c.at)
        );
      });

      scene.actions.forEach((a) => {
        timers.push(
          setTimeout(() => {
            if (cancelled) return;
            if (a.kind === "set") {
              const next = a.overlay;
              setOverlays((prev) => [...prev.filter((o) => o.id !== next.id), next]);
            } else if (a.kind === "remove") {
              const rid = a.id;
              setOverlays((prev) => prev.filter((o) => o.id !== rid));
            } else if (a.kind === "patch") {
              const pid = a.id;
              const fn = a.patch;
              setOverlays((prev) => prev.map((o) => (o.id === pid ? fn(o) : o)));
            }
          }, a.at)
        );
      });

      timers.push(
        setTimeout(() => {
          if (!cancelled) runScene((idx + 1) % SCENES.length);
        }, scene.duration)
      );
    };

    runScene(0);

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <div className="relative w-full max-w-[1200px] mx-auto">
      {/* Camera card */}
      <div className="relative aspect-video border border-[var(--studio-line)] overflow-hidden bg-gradient-to-br from-[#0c0e12] via-[#0a0b0e] to-[#15181d]">
        {/* Top chrome: camera ID + take + timecode + ON AIR */}
        <div className="absolute top-0 inset-x-0 h-10 z-30 flex items-center justify-between px-3 sm:px-4 border-b border-white/[0.04] bg-black/40 backdrop-blur-md">
          <div className="flex items-center gap-2 sm:gap-3 font-mono text-[9px] sm:text-[10px] tracking-[0.18em] uppercase text-[var(--studio-graphite)]">
            <span>Your&nbsp;camera</span>
            <span className="hidden sm:inline text-[var(--studio-fade)]">·</span>
            <span className="hidden sm:inline">Zoom · Teams · Meet</span>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="font-mono text-[9px] sm:text-[10px] tracking-[0.18em] uppercase text-[var(--studio-graphite)] tabular-nums">
              {tc}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--tally)] tally-pulse" />
              <span className="font-mono text-[9px] sm:text-[10px] tracking-[0.22em] uppercase text-[var(--tally)]">
                On&nbsp;Air
              </span>
            </span>
          </div>
        </div>

        {/* Video surface: the relative parent for OverlayLayer */}
        <div className="absolute top-10 bottom-12 inset-x-0">
          {/* Soft chromatic ambient */}
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              backgroundImage:
                "radial-gradient(ellipse at 28% 38%, rgba(82,255,139,0.05), transparent 60%), radial-gradient(ellipse at 72% 68%, rgba(34,211,238,0.05), transparent 60%), radial-gradient(ellipse at 50% 100%, rgba(255,79,193,0.04), transparent 55%)",
            }}
          />
          <div aria-hidden className="absolute inset-0 crt-grid" />
          <div aria-hidden className="absolute inset-0 crt-scanlines" />
          <div aria-hidden className="scanline-sweep" />
          {/* Vignette */}
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse at center, transparent 48%, rgba(0,0,0,0.55) 100%)",
            }}
          />
          {/* Title-safe markers (broadcast frame guides) */}
          <div aria-hidden className="safe-marker top-2 left-2 right-2 h-px" />
          <div aria-hidden className="safe-marker bottom-2 left-2 right-2 h-px" />
          <div aria-hidden className="safe-marker top-2 bottom-2 left-2 w-px" />
          <div aria-hidden className="safe-marker top-2 bottom-2 right-2 w-px" />
          {/* Corner ticks */}
          <CornerTick className="top-2 left-2" />
          <CornerTick className="top-2 right-2" rotate={90} />
          <CornerTick className="bottom-2 left-2" rotate={-90} />
          <CornerTick className="bottom-2 right-2" rotate={180} />

          {/* The actual overlay components: same code as production */}
          <OverlayLayer overlays={overlays} />
        </div>

        {/* Bottom chrome: voice command rail + scene indicator */}
        <div className="absolute bottom-0 inset-x-0 h-12 z-30 flex items-center px-3 sm:px-4 border-t border-white/[0.04] bg-black/60 backdrop-blur-md">
          <span className="font-mono text-[var(--phosphor)] mr-2 sm:mr-3 text-base">›</span>
          <span className="font-mono text-[9px] sm:text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)] mr-2 sm:mr-3">
            voice
          </span>
          <span className="font-mono text-[11px] sm:text-[13px] text-[var(--studio-ink)] truncate min-w-0">
            <CueText text={cue} />
            <span
              aria-hidden
              className="inline-block w-[7px] h-[14px] bg-[var(--phosphor)] caret-blink translate-y-[2px] ml-[2px]"
            />
          </span>

          {/* Progress indicator */}
          <div className="ml-auto pl-3 flex items-center gap-2 sm:gap-3 shrink-0">
            <span className="flex gap-1">
              {SCENES.map((_, i) => (
                <span
                  key={i}
                  className={`w-1 h-1 rounded-full transition-colors ${
                    i === sceneIdx ? "bg-[var(--phosphor)]" : "bg-white/15"
                  }`}
                />
              ))}
            </span>
          </div>
        </div>
      </div>

      {/* External caption strip below card: gives context without crowding it */}
      <div className="mt-3 flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1.5 px-1">
        <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
          A real session, on a loop · every graphic here lands from a spoken line
        </span>
        <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
          You speak · it appears
        </span>
      </div>
    </div>
  );
}

/** Hairline L-shaped corner mark: broadcast viewfinder feel. */
function CornerTick({ className = "", rotate = 0 }: { className?: string; rotate?: number }) {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 14 14"
      className={`absolute ${className}`}
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <path d="M0 0 L0 7 M0 0 L7 0" stroke="rgba(255,255,255,0.22)" strokeWidth="1" fill="none" />
    </svg>
  );
}
