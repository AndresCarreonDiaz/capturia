"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { extractPdf } from "@/lib/deck/extract";
import { buildCues, toDeckFacts } from "@/lib/deck/cues";
import { generateCuesViaLLM } from "@/lib/deck/llm";
import type { CueCard, DeckFacts } from "@/lib/deck/types";
import type { KeyProvider } from "@/hooks/useDesktopHotkey";

interface Props {
  onLoaded: (payload: { cards: CueCard[]; facts: DeckFacts; fileName: string }) => void;
  provider: KeyProvider;
}

// Drop a PDF anywhere on the studio (or click the chip to pick one). Parsing is
// fully client-side, so it costs nothing and works on web and desktop alike.
export default function DeckDropzone({ onLoaded, provider }: Props) {
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<"idle" | "parsing" | "generating" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (!/\.pdf$/i.test(file.name)) {
        setStatus("error");
        setError("Drop a PDF. PowerPoint import is coming to the desktop app.");
        return;
      }
      setStatus("parsing");
      setError(null);
      try {
        const extract = await extractPdf(file);
        let cards: CueCard[] | null = null;
        // Desktop: design overlays with the user's own LLM. Web or any failure:
        // fall back to the deterministic builder so it always works and never
        // costs us anything.
        if (typeof window !== "undefined" && window.capturia?.generateCues) {
          setStatus("generating");
          cards = await generateCuesViaLLM(extract, provider);
        }
        if (!cards || cards.length === 0) cards = buildCues(extract);
        const facts = toDeckFacts(extract);
        onLoaded({ cards, facts, fileName: file.name });
        setStatus("idle");
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Could not read that PDF.");
      }
    },
    [onLoaded, provider]
  );

  // Window-level drag tracking so the whole studio is a drop target.
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      dragDepth.current += 1;
      setDragging(true);
    };
    const onDragLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void handleFile(e.dataTransfer?.files?.[0]);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [handleFile]);

  return (
    <>
      {/* Persistent chip to open a file picker */}
      <button
        onClick={() => inputRef.current?.click()}
        className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-widest px-3 py-1.5 rounded-full bg-white/10 text-white/60 hover:bg-white/20 hover:text-white border border-white/10 transition-all"
        title="Load a pitch deck (PDF)"
      >
        <span className="text-[var(--phosphor,#52ff8b)]">+</span>
        {status === "parsing"
          ? "Reading deck…"
          : status === "generating"
          ? "Designing overlays…"
          : "Deck"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => void handleFile(e.target.files?.[0] ?? undefined)}
      />

      {error && status === "error" && (
        <span className="text-[10px] font-mono text-red-400/90 max-w-[200px] leading-tight">
          {error}
        </span>
      )}

      {/* Full-screen drag overlay */}
      {dragging && (
        <div className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="px-8 py-6 rounded-2xl border-2 border-dashed border-white/40 text-center">
            <div className="text-white text-lg font-medium">Drop your pitch deck</div>
            <div className="text-white/50 text-xs font-mono mt-1.5 uppercase tracking-widest">
              PDF · stays on your device
            </div>
          </div>
        </div>
      )}
    </>
  );
}
