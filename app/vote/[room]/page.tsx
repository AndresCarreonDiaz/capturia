"use client";
import { use, useEffect, useRef, useState } from "react";
import type { VoteEvent } from "@/lib/vote-store";
import { randomToken } from "@/lib/random-id";

// The audience side of audience voting: the phone page behind the QR code on
// the feed. Subscribes to the room over SSE (EventSource's native reconnect
// doubles as the "wait for the host to start a poll" loop, since the server
// closes streams for rooms that don't exist yet), shows the live poll, and
// casts one switchable vote per viewer. The studio mirrors these counts onto
// the broadcast tally, so the moment of voting is visible on screen.

const VIEWER_ID_KEY = "capturia-viewer-id";

function voteMemoryKey(room: string) {
  return `capturia-vote-${room}`;
}

export default function VotePage({ params }: { params: Promise<{ room: string }> }) {
  const { room } = use(params);
  const [state, setState] = useState<VoteEvent | null>(null);
  const [votedAction, setVotedAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const viewerIdRef = useRef<string>("");
  // The last seen round IDENTITY: the round number plus the room instance
  // nonce. The nonce matters because rounds restart at 1 whenever the room
  // is recreated (server restart, host toggled voting off and on), so the
  // round alone would make a remembered vote from the previous instance look
  // current and lock this phone out of a fresh tally.
  const roundRef = useRef<{ nonce?: string; round: number }>({ round: -1 });

  // Stable anonymous viewer id (the server's vote-switch dedupe keys off it).
  useEffect(() => {
    try {
      let id = localStorage.getItem(VIEWER_ID_KEY);
      if (!id) {
        id = randomToken();
        localStorage.setItem(VIEWER_ID_KEY, id);
      }
      viewerIdRef.current = id;
    } catch {
      viewerIdRef.current = randomToken(); // storage blocked: per-load id
    }
  }, []);

  // Live state. Snapshot fetch for fast first paint, then SSE; on a new round
  // identity (the host started a different poll, or the room was recreated)
  // clear the local vote lock. A "closed" frame carries a null poll, so the
  // waiting screen below doubles as the terminal state when the host turns
  // voting off; the server ends the stream right after and EventSource's
  // reconnect loop takes over, exactly like before the first publish.
  useEffect(() => {
    let disposed = false;
    const apply = (e: VoteEvent) => {
      if (disposed) return;
      setState(e);
      if (e.round !== roundRef.current.round || e.nonce !== roundRef.current.nonce) {
        roundRef.current = { nonce: e.nonce, round: e.round };
        let remembered: string | null = null;
        try {
          const raw = localStorage.getItem(voteMemoryKey(room));
          const saved = raw
            ? (JSON.parse(raw) as { nonce?: string; round: number; action: string })
            : null;
          // Restore only when the whole identity matches; a nonce mismatch
          // means a different room instance, where this phone has NOT voted.
          if (saved && saved.round === e.round && saved.nonce === e.nonce) {
            remembered = saved.action;
          }
        } catch {
          /* storage blocked: lock lives in memory only */
        }
        setVotedAction(remembered);
      }
    };

    fetch(`/api/vote/${room}`)
      .then((r) => r.json())
      .then((body: VoteEvent) => apply(body))
      .catch(() => {});

    const source = new EventSource(`/api/vote/${room}?watch=1`);
    source.onmessage = (msg) => {
      try {
        apply(JSON.parse(msg.data) as VoteEvent);
      } catch {
        /* malformed frame: skip */
      }
    };
    return () => {
      disposed = true;
      source.close();
    };
  }, [room]);

  const vote = async (action: string) => {
    if (!viewerIdRef.current || action === votedAction) return;
    setNotice(null);
    try {
      const res = await fetch(`/api/vote/${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "vote", viewerId: viewerIdRef.current, action }),
      });
      const body = (await res.json()) as { event?: VoteEvent | null } & VoteEvent;
      const event = res.ok ? (body as VoteEvent) : body.event;
      if (event) setState(event);
      if (res.ok || res.status === 409) {
        setVotedAction(action);
        try {
          localStorage.setItem(
            voteMemoryKey(room),
            JSON.stringify({
              nonce: event?.nonce ?? roundRef.current.nonce,
              round: event?.round ?? roundRef.current.round,
              action,
            })
          );
        } catch {
          /* storage blocked */
        }
      } else if (res.status === 429) {
        setNotice("One change per second, tap again in a moment.");
      } else {
        setNotice("That vote didn't go through. The poll may have changed.");
      }
    } catch {
      setNotice("Connection hiccup, try again.");
    }
  };

  const poll = state?.poll ?? null;
  const counts = state?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center px-5 py-10">
      <header className="flex items-center gap-2 mb-10">
        <span
          aria-hidden
          className="h-2 w-2 rounded-full bg-cyan-400"
          style={{ boxShadow: "0 0 10px #22d3ee" }}
        />
        <span className="font-mono text-xs uppercase tracking-[0.3em] text-white/70">
          Capturia Live Vote
        </span>
      </header>

      {!poll ? (
        <div className="flex flex-col items-center gap-4 mt-16 text-center">
          <span className="h-3 w-3 rounded-full bg-amber-400 animate-pulse" aria-hidden />
          <p className="text-white/70 text-sm max-w-[18rem] leading-relaxed">
            Waiting for the host to start a poll. Keep this page open; it updates by itself.
          </p>
        </div>
      ) : (
        <div className="w-full max-w-sm flex flex-col gap-6">
          <h1 className="text-2xl font-semibold leading-snug text-center">{poll.title}</h1>

          <div className="flex flex-col gap-3">
            {poll.options.map((option) => {
              const count = counts[option.actionName] ?? 0;
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              const chosen = votedAction === option.actionName;
              return (
                <button
                  key={option.actionName}
                  type="button"
                  onClick={() => vote(option.actionName)}
                  className={`relative overflow-hidden rounded-2xl border px-5 py-4 text-left transition-all active:scale-[0.98] ${
                    chosen
                      ? "border-cyan-400/70 bg-cyan-500/15"
                      : "border-white/15 bg-white/5 hover:bg-white/10"
                  }`}
                >
                  {/* Live result bar behind the label, visible once anyone voted. */}
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 bg-cyan-400/15 transition-[width] duration-500"
                    style={{ width: votedAction ? `${pct}%` : 0 }}
                  />
                  <span className="relative flex items-center justify-between gap-3">
                    <span className="font-medium">{option.label}</span>
                    {votedAction && (
                      <span className="font-mono text-sm text-white/70">
                        {count} · {pct}%
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="text-center text-xs text-white/50 min-h-4">
            {notice ??
              (votedAction
                ? "Vote counted. Tap another option to switch."
                : "Tap an option to vote. Results show after you vote.")}
          </p>
        </div>
      )}
    </main>
  );
}
