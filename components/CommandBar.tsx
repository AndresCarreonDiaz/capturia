"use client";
import { useState, useRef } from "react";
import { useIsDesktop } from "@/hooks/useDesktopHotkey";

interface Props {
  overlays: { id: string; type: string }[];
  onClear: () => void;
  isListening: boolean;
  onToggleVoice: () => void;
  isVoiceSupported: boolean;
  // The studio's shared agent driver (hooks/useAgentRun.ts, called ONCE up
  // there): resolves false when the turn was dropped because a run is already
  // in flight. Passed as props so this component never mints its own agent.
  sendMessage: (content: string) => Promise<boolean>;
  agentBusy: boolean;
}

const QUICK_ACTIONS: { emoji: string; label: string; prompt: string }[] = [
  { emoji: "👤", label: "Lower third",   prompt: "Add a lower third with my name as Alex, subtitle Founder of Acme" },
  { emoji: "📊", label: "Metrics",       prompt: "Add Q4 metrics: revenue $1.2M (+24%), users 18K (+12%), churn 2.1% (-0.4%)" },
  { emoji: "🎯", label: "Progress 73%",  prompt: "Add a progress bar at 73% with label Demo Loading" },
  { emoji: "✨", label: "Keywords",      prompt: "Highlight keywords AI, growth, demo with auto color" },
];

export default function CommandBar({
  overlays,
  onClear,
  isListening,
  onToggleVoice,
  isVoiceSupported,
  sendMessage,
  agentBusy,
}: Props) {
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isDesktop = useIsDesktop();

  const busy = isLoading || agentBusy;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = input.trim();
    if (!cmd || busy) return;
    setInput("");
    setIsLoading(true);
    try {
      // Dropped because a run slipped in between the busy check and the send
      // (sendMessage gates on the live agent state): give the text back
      // instead of losing the operator's command.
      const sent = await sendMessage(cmd);
      if (!sent) setInput(cmd);
    } finally {
      setIsLoading(false);
    }
    inputRef.current?.focus();
  };

  const fireQuickAction = async (prompt: string) => {
    if (busy) return;
    setIsLoading(true);
    try {
      await sendMessage(prompt);
    } finally {
      setIsLoading(false);
    }
  };

  const showQuickActions = overlays.length === 0 && !isListening;

  return (
    <div className="absolute bottom-0 left-0 right-0 z-30 px-4 pb-4 pt-2">
      {showQuickActions && (
        <div className="mb-2 flex flex-wrap items-center gap-2 justify-center">
          <span className="text-white/40 text-[10px] uppercase tracking-[0.2em] font-mono mr-1">
            Try
          </span>
          {QUICK_ACTIONS.map((qa, i) => (
            <button
              key={qa.label}
              type="button"
              onClick={() => fireQuickAction(qa.prompt)}
              disabled={busy}
              className="group flex items-center gap-1.5 bg-black/55 hover:bg-black/75 backdrop-blur-md border border-white/15 hover:border-white/30 text-white/80 hover:text-white text-xs font-mono px-3 py-1.5 rounded-full transition-all disabled:opacity-40 idle-bob"
              style={{
                animationDelay: `${600 + i * 220}ms`,
                boxShadow: "0 0 16px rgba(167, 139, 250, 0.12)",
              }}
            >
              <span className="text-sm">{qa.emoji}</span>
              <span>{qa.label}</span>
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 bg-black/75 backdrop-blur-xl border border-white/20 rounded-2xl px-4 py-2.5 shadow-[0_0_40px_rgba(0,0,0,0.6)]"
      >
        {/* Active overlays indicator */}
        {overlays.length > 0 && (
          <div className="flex gap-1.5 items-center shrink-0">
            {overlays.slice(0, 4).map((o) => (
              <span
                key={o.id}
                className="text-[10px] bg-white/10 text-white/60 px-2 py-0.5 rounded-full font-mono"
              >
                {o.type.replace(/([A-Z])/g, " $1").trim().split(" ")[0]}
              </span>
            ))}
            {overlays.length > 4 && (
              <span className="text-[10px] text-white/40 font-mono">
                +{overlays.length - 4}
              </span>
            )}
            <div className="w-px h-4 bg-white/20 mx-1" />
          </div>
        )}

        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            isListening
              ? "Listening to your voice…"
              : busy
              ? "Agent thinking..."
              : 'Try: "Add a lower third with my name" or "Remove all"'
          }
          disabled={busy}
          className="flex-1 bg-transparent text-white placeholder:text-white/30 text-sm outline-none font-mono"
          autoFocus
        />

        {overlays.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-white/30 hover:text-white/70 text-xs font-mono transition-colors shrink-0"
          >
            clear
          </button>
        )}

        {/* Voice toggle */}
        {isVoiceSupported && (
          <button
            type="button"
            onClick={onToggleVoice}
            title={isListening ? "Stop listening" : "Start voice mode"}
            className={`shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all ${
              isListening
                ? "bg-green-500/20 text-green-400 border border-green-500/40"
                : "bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70 border border-white/10"
            }`}
          >
            {isListening ? (
              // CSS-animated bars while listening (no AudioContext, avoids Speech API conflict)
              <div className="flex items-end justify-center gap-px w-full h-full py-1.5">
                {[14, 8, 18, 10].map((max, i) => (
                  <div
                    key={i}
                    className="w-[3px] bg-green-400 rounded-full"
                    style={{
                      height: `${max}px`,
                      animation: `voice-bar ${0.7 + i * 0.13}s ease-in-out infinite alternate`,
                      animationDelay: `${i * 0.08}s`,
                    }}
                  />
                ))}
              </div>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2H3v2a9 9 0 0 0 8 8.94V23h2v-2.06A9 9 0 0 0 21 12v-2h-2z" />
              </svg>
            )}
          </button>
        )}

        {/* Send */}
        <button
          type="submit"
          disabled={!input.trim() || busy}
          className="shrink-0 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-1.5 rounded-xl transition-colors"
        >
          {busy ? (
            <span className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          ) : (
            "→"
          )}
        </button>
      </form>
      {!isVoiceSupported && !isDesktop && (
        <p className="mt-2 text-center text-[10px] font-mono uppercase tracking-[0.2em] text-white/30">
          Voice mode needs Chrome or Edge. Brave Shields and Firefox block it.
        </p>
      )}
      {isDesktop && isVoiceSupported && (
        <p className="mt-2 text-center text-[10px] font-mono uppercase tracking-[0.2em] text-white/30">
          Press <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-white/70 font-mono text-[10px] mx-0.5">⌘⌥Space</kbd> to talk. Pause to end. Local Whisper, on-device.
        </p>
      )}
    </div>
  );
}
