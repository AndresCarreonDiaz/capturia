"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceCaptureState } from "./useVoiceCapture";
import { isLikelyHallucination } from "@/lib/transcript-stream";

// The apple-speech TranscriptStream engine (M9): on-device streaming
// transcription through the capturia-speech helper (macOS 26+), spawned and
// guarded by Electron main. Sentence-level finals arrive DURING speech
// (about 100ms after each sentence per the spike measurements), so the agent
// reacts without waiting for a pause; interims drive the live caption and
// the energy FX. Same VoiceCaptureState shape as every other engine.

interface SpeechEventPayload {
  type: string;
  text?: string;
  message?: string;
  locale?: string;
  sessionId?: number;
}

export function useAppleSpeechCapture(
  onFinalResult: (text: string) => void,
  onInterimResult?: (text: string) => void
): VoiceCaptureState {
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [speechStatus, setSpeechStatus] = useState("idle");
  const [lastError, setLastError] = useState("");
  const [isSupported, setIsSupported] = useState(false);
  const [lastResultAt, setLastResultAt] = useState(0);

  const sessionIdRef = useRef<number | null>(null);
  const listeningRef = useRef(false);
  // True while startListening awaits the speech.start() round trip. The
  // just-stopped session's trailing done/error can cross that window (its
  // id is still in sessionIdRef, so the stale-guard passes); resetting the
  // listening state then would make the post-await guard cancel the fresh
  // start the user just asked for.
  const startingRef = useRef(false);
  const onFinalRef = useRef(onFinalResult);
  const onInterimRef = useRef(onInterimResult);
  useEffect(() => {
    onFinalRef.current = onFinalResult;
    onInterimRef.current = onInterimResult;
  });

  useEffect(() => {
    const speech = typeof window !== "undefined" ? window.capturia?.speech : undefined;
    if (!speech) return;
    let cancelled = false;
    speech
      .available()
      .then((ok) => {
        if (!cancelled) setIsSupported(Boolean(ok));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // One subscription for the component's lifetime; events only flow while a
  // session runs. Trailing finals after a stop still land (the helper
  // finalizes before exiting), which is exactly the flush semantics the
  // whisper engine has.
  useEffect(() => {
    const speech = typeof window !== "undefined" ? window.capturia?.speech : undefined;
    if (!speech?.onEvent) return;
    return speech.onEvent((event: SpeechEventPayload) => {
      // Only the active session's events count: a restart leaves the OLD
      // helper flushing trailing finals and a done on the same channel, and
      // an untagged stale done would null the NEW session's id (orphaning
      // the mic: stop would have nothing to stop).
      if (typeof event.sessionId === "number" && event.sessionId !== sessionIdRef.current) {
        return;
      }
      switch (event.type) {
        case "downloading-model":
          setSpeechStatus("downloading speech model…");
          break;
        case "ready":
          setSpeechStatus("listening…");
          break;
        case "interim":
          if (typeof event.text === "string") {
            setInterimTranscript(event.text);
            setLastResultAt(performance.now());
            // Volatile hypothesis for the current segment; deterministic cue
            // matching fires primed cards from it mid-sentence (M9).
            if (event.text) onInterimRef.current?.(event.text);
          }
          break;
        case "final": {
          const text = (event.text || "").trim();
          setInterimTranscript("");
          if (text && !isLikelyHallucination(text)) {
            setSpeechStatus(listeningRef.current ? "sent, still listening" : "sent ✓");
            onFinalRef.current(text);
          }
          break;
        }
        case "error": {
          setLastError(event.message || "speech helper error");
          setSpeechStatus(`error: ${event.message || "speech helper"}`);
          setInterimTranscript("");
          // During a restart this event belongs to the draining old session;
          // the fresh start must keep its listening intent.
          if (!startingRef.current) {
            listeningRef.current = false;
            setIsListening(false);
          }
          // The helper exits on every error, but ask main to stop anyway:
          // if the process somehow survived, abandoning the id here would
          // make it unstoppable.
          const deadId = sessionIdRef.current;
          sessionIdRef.current = null;
          if (deadId !== null) speech?.stop(deadId).catch(() => {});
          break;
        }
        case "done":
          // done while still "listening" means the session ended underneath
          // us (helper died cleanly); staying in the listening state would
          // show a live mic with nothing behind it. During a restart it is
          // just the old session draining.
          if (listeningRef.current && !startingRef.current) {
            listeningRef.current = false;
            setIsListening(false);
          }
          if (!startingRef.current) setSpeechStatus("idle");
          sessionIdRef.current = null;
          break;
      }
    });
  }, []);

  const startListening = useCallback(async () => {
    const speech = window.capturia?.speech;
    if (!speech || listeningRef.current) return;
    listeningRef.current = true;
    startingRef.current = true;
    setIsListening(true);
    setLastError("");
    setInterimTranscript("");
    setSpeechStatus("starting speech engine…");
    try {
      const id = await speech.start();
      // A stop (or unmount, which clears listeningRef) can land during the
      // IPC round trip; adopting the session then would leave a hot mic
      // nothing points at.
      if (!listeningRef.current) {
        speech.stop(id).catch(() => {});
        return;
      }
      sessionIdRef.current = id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      setSpeechStatus(`error: ${msg}`);
      listeningRef.current = false;
      setIsListening(false);
    } finally {
      startingRef.current = false;
    }
  }, []);

  const stopListening = useCallback(() => {
    const speech = window.capturia?.speech;
    if (!listeningRef.current) return;
    listeningRef.current = false;
    setIsListening(false);
    setSpeechStatus("finishing…");
    const id = sessionIdRef.current;
    if (speech && id !== null) {
      // Trailing finals flush through the subscription until "done".
      speech.stop(id).catch(() => {});
    } else {
      setSpeechStatus("idle");
    }
  }, []);

  // End the session with the component (page nav, output-mode unmount).
  // Clearing listeningRef also makes an in-flight start() adopt-and-stop
  // its session instead of orphaning it (see startListening).
  useEffect(() => {
    return () => {
      listeningRef.current = false;
      const id = sessionIdRef.current;
      if (id !== null) window.capturia?.speech?.stop(id).catch(() => {});
    };
  }, []);

  return {
    isListening,
    interimTranscript,
    speechStatus,
    lastError,
    lastResultAt,
    isSupported,
    startListening,
    stopListening,
  };
}
