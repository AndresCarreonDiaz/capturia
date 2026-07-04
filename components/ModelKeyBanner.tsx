"use client";
import { useState } from "react";

/**
 * Operator-facing error when the server has no usable model key (the route's
 * fail-fast). CopilotKit swallows agent-run errors into the console, so
 * without this the studio looks alive while every command dies silently.
 * Fed by the capturia-keycheck probe in app/studio/page.tsx; mounted in the
 * notice stack outside Program Output, so it never leaks into the OBS feed.
 */
export default function ModelKeyBanner({ message }: { message: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-red-400/30 bg-black/70 px-4 py-3 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.4)]">
      <span
        aria-hidden
        className="mt-0.5 h-2 w-2 flex-none rounded-full bg-red-400"
        style={{ boxShadow: "0 0 8px #f87171" }}
      />
      <div className="text-[13px] leading-snug text-white/80">
        <span className="font-semibold text-white">The agent is offline.</span> {message}
      </div>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="flex-none rounded-md px-2 py-0.5 text-xs font-medium text-white/50 hover:bg-white/10 hover:text-white/90"
      >
        Dismiss
      </button>
    </div>
  );
}
