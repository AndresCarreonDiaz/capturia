"use client";
import { useEffect, useRef, useState } from "react";
import {
  MIRROR_CHANNEL_NAME,
  parseMirrorMessage,
  speakPingDue,
  type MirrorRole,
  type MirrorSnapshot,
} from "@/lib/mirror";
import { randomToken } from "@/lib/random-id";

// Studio state mirroring over a BroadcastChannel (model + protocol notes in
// lib/mirror.ts). The PRIMARY Control Room publishes its live state; every
// ?out=1 RECEIVER (the desktop app's offscreen camera window, an OBS
// browser-source tab) adopts it. Plain web API on purpose: it works without
// a preload in the offscreen window and gives the free web OBS flow the same
// cross-tab mirroring for free.

interface Args {
  role: MirrorRole;
  // Primary: the state to publish. Must be memoized by the caller so the
  // republish effect keys on real state changes, not render churn. Receivers
  // still pass their (ignored) local state; the role gates every effect.
  snapshot: MirrorSnapshot;
  // Primary: performance.now() stamp of the most recent speech result
  // (0 = none yet). Every movement while listening becomes a throttled speak
  // ping so receivers can run their own --mic-energy envelope.
  speakAt: number;
}

interface Mirror {
  // Receiver: the most recently adopted snapshot (null until the first state
  // message lands). Always null on the primary.
  adopted: MirrorSnapshot | null;
  // Receiver: local-clock (performance.now()) time of the last speak ping
  // from the adopted sender; feeds useSpeechEnergy exactly like a local
  // speech result stamp. 0 on the primary and before the first ping.
  adoptedSpeakAt: number;
}

export function useStudioMirror({ role, snapshot, speakAt }: Args): Mirror {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const senderIdRef = useRef<string | null>(null);
  const snapshotRef = useRef(snapshot);
  const lastPingSentRef = useRef(0);
  // The sender whose state the receiver last adopted; speak pings from
  // anyone else are ignored (see the two-primaries rule in lib/mirror.ts).
  const adoptedFromRef = useRef<string | null>(null);
  const [adopted, setAdopted] = useState<MirrorSnapshot | null>(null);
  const [adoptedSpeakAt, setAdoptedSpeakAt] = useState(0);

  // Latest-value ref (the useVoteRoom pattern): the hello responder below
  // must answer with the CURRENT state without re-subscribing per change.
  useEffect(() => {
    snapshotRef.current = snapshot;
  });

  // Channel lifecycle + the receive path. Keyed on role, which is fixed for
  // the life of the page (detectMirrorRole reads the load URL), so this runs
  // once. Guarded for environments without BroadcastChannel (SSR pass, very
  // old Safari): mirroring is then simply off, never a crash.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(MIRROR_CHANNEL_NAME);
    channelRef.current = channel;
    if (role === "primary") {
      if (!senderIdRef.current) senderIdRef.current = randomToken(12);
      const from = senderIdRef.current;
      // Late-join handshake: answer a receiver's hello with the current
      // snapshot so an out page opened mid-show syncs immediately instead of
      // waiting for the next state change.
      channel.onmessage = (event) => {
        if (parseMirrorMessage(event.data)?.kind !== "hello") return;
        channel.postMessage({ kind: "state", from, snapshot: snapshotRef.current });
      };
    } else {
      channel.onmessage = (event) => {
        const msg = parseMirrorMessage(event.data);
        if (!msg) return;
        if (msg.kind === "state") {
          adoptedFromRef.current = msg.from;
          setAdopted(msg.snapshot);
        } else if (msg.kind === "speak" && msg.from === adoptedFromRef.current) {
          setAdoptedSpeakAt(performance.now());
        }
      };
      // Request the snapshot. If no primary is up yet, its mount-time publish
      // (the effect below runs on the primary's first render) covers us.
      channel.postMessage({ kind: "hello" });
    }
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [role]);

  // Primary: republish on EVERY state change. One effect on the memoized
  // snapshot, deliberately not scattered across the call sites that mutate
  // overlays (agent tools, applyCue, compose_scene, vote tally mirroring),
  // so a future mutation path can never forget to publish.
  useEffect(() => {
    if (role !== "primary") return;
    const channel = channelRef.current;
    const from = senderIdRef.current;
    if (!channel || !from) return;
    channel.postMessage({ kind: "state", from, snapshot });
  }, [role, snapshot]);

  // Primary: throttled speak ping per speech result while the mic is live.
  // snapshotRef is already current here (its effect is declared first).
  useEffect(() => {
    if (role !== "primary" || speakAt <= 0) return;
    if (!snapshotRef.current.listening) return;
    const channel = channelRef.current;
    const from = senderIdRef.current;
    if (!channel || !from) return;
    const now = performance.now();
    if (!speakPingDue(lastPingSentRef.current, now)) return;
    lastPingSentRef.current = now;
    channel.postMessage({ kind: "speak", from });
  }, [role, speakAt]);

  return { adopted, adoptedSpeakAt };
}
