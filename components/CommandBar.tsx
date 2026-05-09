"use client";
import { useState, useRef } from "react";
import { useCopilotChat } from "@copilotkit/react-core";
import { TextMessage, MessageRole } from "@copilotkit/runtime-client-gql";

interface Props {
  overlays: { id: string; type: string }[];
  onClear: () => void;
}

export default function CommandBar({ overlays, onClear }: Props) {
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { appendMessage, isLoading: chatLoading } = useCopilotChat();

  const busy = isLoading || chatLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = input.trim();
    if (!cmd || busy) return;
    setInput("");
    setIsLoading(true);
    try {
      await appendMessage(
        new TextMessage({ content: cmd, role: MessageRole.User })
      );
    } finally {
      setIsLoading(false);
    }
    inputRef.current?.focus();
  };

  return (
    <div className="absolute bottom-0 left-0 right-0 z-30 px-4 pb-4 pt-2">
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 bg-black/75 backdrop-blur-xl border border-white/20 rounded-2xl px-4 py-2.5 shadow-[0_0_40px_rgba(0,0,0,0.6)]"
      >
        {/* active overlays indicator */}
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
              <span className="text-[10px] text-white/40 font-mono">+{overlays.length - 4}</span>
            )}
            <div className="w-px h-4 bg-white/20 mx-1" />
          </div>
        )}

        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            busy
              ? "Agent thinking..."
              : 'Try: "Add a lower third with my name" or "Remove all overlays"'
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
    </div>
  );
}
