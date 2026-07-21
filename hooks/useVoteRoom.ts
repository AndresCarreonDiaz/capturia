"use client";
import { useCallback, useEffect, useRef } from "react";
import type { PollDef, PollOption, VoteEvent } from "@/lib/vote-store";
import { randomToken } from "@/lib/random-id";
import { voteApiBase, voteOriginUsable } from "@/lib/vote-url";

// Studio side of audience voting. Publishes the live poll (derived from the
// current authored surface) to this session's vote room, subscribes to the
// room's counts over SSE, and lets the operator's own taps count as votes so
// the server stays the single source of truth for the tally.

// One room per TAB, module-level on purpose: the CopilotKit provider remounts
// the whole studio subtree on a provider/key switch, and React state would
// mint a new room id mid-show, stranding every phone that already scanned the
// QR. The room slug is PUBLIC (it rides in the on-feed QR); the hostKey is a
// SECRET, so it is longer and never leaves this tab.
let sessionRoom: { room: string; hostKey: string } | null = null;
function getSessionRoom() {
  if (!sessionRoom) {
    sessionRoom = { room: randomToken(12), hostKey: randomToken(32) };
  }
  return sessionRoom;
}

interface Args {
  enabled: boolean;
  // The poll currently on screen (title + ActionButton options), or null.
  poll: PollDef | null;
  // Fired with the server's ABSOLUTE counts on every vote/state event. The
  // studio mirrors them onto the broadcast tally; absolute values make late
  // or re-ordered events harmless.
  onCounts: (counts: Record<string, number>, options: PollOption[]) => void;
  // Fired when a poll publish is REJECTED by the server (bad poll, room taken,
  // room limit) so the operator sees why the QR shows nothing, instead of the
  // failure being swallowed. null clears the notice on the next success.
  onPublishError?: (message: string | null) => void;
}

export function useVoteRoom({ enabled, poll, onCounts, onPublishError }: Args) {
  const { room, hostKey } = getSessionRoom();
  // Whether voting can work HERE at all. The advertised origin (below) must
  // be http(s) for phones. On any http(s) studio the room's own traffic is
  // same-origin relative fetches; on the packaged app's file:// origin it
  // travels to the advertised origin instead (apiBase, cross-origin against
  // the hosted deploy, which build:electron bakes in). Only a file:// studio
  // with NO baked origin has neither a scannable URL nor a reachable
  // /api/vote: everything below gates on originUsable so the feed never
  // carries a dead QR and the operator gets ONE clear notice instead of a
  // doomed publish loop's error noise.
  const configuredOrigin = process.env.NEXT_PUBLIC_CAPTURIA_ORIGIN || "";
  const pageOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const origin = configuredOrigin || pageOrigin;
  const originUsable = voteOriginUsable(origin);
  const apiBase = voteApiBase(configuredOrigin, pageOrigin);
  const onCountsRef = useRef(onCounts);
  const onPublishErrorRef = useRef(onPublishError);
  const pollRef = useRef<PollDef | null>(null);
  const enabledRef = useRef(enabled);
  const lastPublishedRef = useRef("");
  // Latest-value refs, written in an effect (not during render) so the SSE
  // handler and castHostVote always see current props without re-subscribing.
  useEffect(() => {
    onCountsRef.current = onCounts;
    onPublishErrorRef.current = onPublishError;
    pollRef.current = poll;
    enabledRef.current = enabled;
  });

  // Publish the poll whenever its content changes, debounced so the agent
  // re-authoring a surface mid-stream doesn't spam the room. The server keeps
  // counts when the option set is unchanged and starts a new round otherwise.
  useEffect(() => {
    if (!enabled || !originUsable || !poll) return;
    const body = JSON.stringify({ type: "poll", hostKey, poll });
    if (body === lastPublishedRef.current) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${apiBase}/api/vote/${room}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        if (cancelled) return;
        if (res.ok) {
          // Commit only on success, so a rejected publish is retried on the
          // next content change instead of being stuck as "already published".
          lastPublishedRef.current = body;
          onPublishErrorRef.current?.(null);
        } else {
          const detail = await res.json().catch(() => null);
          onPublishErrorRef.current?.(
            typeof detail?.error === "string" ? detail.error : `publish failed (${res.status})`
          );
        }
      } catch {
        if (!cancelled) onPublishErrorRef.current?.("could not reach the vote server");
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, originUsable, poll, room, hostKey, apiBase]);

  // Unpublish on toggle-off: without this the room stays votable for the
  // rest of the 4h TTL, and a later session in this tab (the room id is
  // module-level) would inherit its stale counts and the phones' vote locks.
  // The store deletes the room and ends every phone's stream (they fall back
  // to their waiting screen); resetting lastPublishedRef makes re-enabling
  // republish the same poll into a fresh room instead of skipping it as
  // "already published". Keyed on the enabled TRANSITION rather than effect
  // cleanup, because cleanup also runs when the provider remounts the studio
  // subtree mid-show, which must not tear down a live room. Fire-and-forget:
  // a failed unpublish just means the old TTL-only behavior.
  const wasEnabledRef = useRef(false);
  useEffect(() => {
    if (enabled && originUsable) {
      wasEnabledRef.current = true;
      return;
    }
    if (!wasEnabledRef.current) return;
    wasEnabledRef.current = false;
    lastPublishedRef.current = "";
    fetch(`${apiBase}/api/vote/${room}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "unpublish", hostKey }),
    }).catch(() => {});
  }, [enabled, originUsable, room, hostKey, apiBase]);

  // Live counts. EventSource's native reconnect covers the window before the
  // first publish (the server closes streams for unknown rooms).
  useEffect(() => {
    if (!enabled || !originUsable) return;
    const source = new EventSource(`${apiBase}/api/vote/${room}?watch=1`);
    source.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as VoteEvent;
        if (event.poll) onCountsRef.current(event.counts, event.poll.options);
      } catch {
        /* malformed frame: skip */
      }
    };
    return () => source.close();
  }, [enabled, originUsable, room, apiBase]);

  // The operator's own tap on a poll button becomes a server vote (instead of
  // an agent turn), so audience counts and host taps can never diverge.
  // Returns false when voting is off or the action isn't a poll option, in
  // which case the caller should fall through to the agent [ACTION] path.
  const castHostVote = useCallback(
    (action: string): boolean => {
      const current = pollRef.current;
      // Without a workable origin the tap must fall through to the agent
      // [ACTION] path: with no baked origin a vote POST from file:// goes
      // nowhere, and swallowing the tap would leave poll buttons dead in the
      // packaged app.
      if (!enabledRef.current || !originUsable || !current) return false;
      if (!current.options.some((o) => o.actionName === action)) return false;
      fetch(`${apiBase}/api/vote/${room}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Key the host's voter slot on the SECRET hostKey, not the PUBLIC room
        // id: a `host-<room>` id is in the QR/vote URL, so any viewer could
        // POST as the host, flip the host's vote, and keep the host's
        // rate-limit slot hot so the operator's own taps 429 silently.
        body: JSON.stringify({ type: "vote", viewerId: `host-${hostKey}`, action }),
      }).catch(() => {});
      return true;
    },
    [room, hostKey, originUsable, apiBase]
  );

  // The QR on the feed is scanned by people watching through Zoom/Meet (the
  // fake-camera path), so the URL must be reachable from THEIR network, not
  // just this machine. NEXT_PUBLIC_CAPTURIA_ORIGIN lets a deployed/tunneled
  // instance be advertised even while the operator drives a local studio;
  // otherwise we fall back to however the operator opened the studio (a LAN
  // IP origin works for in-room audiences). Origin exists only in the
  // browser; null during prerender is fine because nothing renders the URL
  // until the operator enables voting post-hydration. The packaged app bakes
  // the hosted deploy's origin in at build time, so its QR points there; a
  // non-http(s) origin with nothing baked (a stripped-down desktop build)
  // yields NO url at all rather than a dead QR on the feed, and
  // voteOriginUnusable tells the studio to explain why.
  const voteUrl = enabled && originUsable ? `${origin}/vote/${room}` : null;

  return { voteUrl, voteOriginUnusable: enabled && !originUsable, castHostVote };
}
