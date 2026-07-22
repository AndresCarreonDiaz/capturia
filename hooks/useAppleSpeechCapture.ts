"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceCaptureState } from "./useVoiceCapture";
import { isLikelyHallucination } from "@/lib/transcript-stream";
import { appleSpeechLocale } from "@/lib/voice-locale";

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
  onInterimResult?: (text: string) => void,
  onSegmentEnd?: () => void,
  // Canonical BCP-47 tag from lib/voice-locale.ts; converted to the
  // helper's underscore form at start. A change mid-session restarts the
  // helper in the new language (see the locale effect below).
  locale?: string
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
  const onSegmentEndRef = useRef(onSegmentEnd);
  useEffect(() => {
    onFinalRef.current = onFinalResult;
    onInterimRef.current = onInterimResult;
    onSegmentEndRef.current = onSegmentEnd;
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
            // matching fires primed cards from it mid-sentence (M9). The
            // hallucination gate mirrors the final path below: a silent-room
            // "Thank you." must not fire a closing-slide card.
            if (event.text && !isLikelyHallucination(event.text)) {
              onInterimRef.current?.(event.text);
            }
          }
          break;
        case "final": {
          const text = (event.text || "").trim();
          setInterimTranscript("");
          if (text && !isLikelyHallucination(text)) {
            setSpeechStatus(listeningRef.current ? "sent, still listening" : "sent ✓");
            onFinalRef.current(text);
          }
          // Every final closes the interim segment, INCLUDING filtered and
          // empty ones the callback above never sees; consumers otherwise
          // carry a dead segment's dedup state into the next sentence.
          onSegmentEndRef.current?.();
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
          onSegmentEndRef.current?.();
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
          onSegmentEndRef.current?.();
          break;
      }
    });
  }, []);

  // The current locale, readable from the stable callbacks below without
  // re-registering them; the effect after startSession owns the mid-session
  // restart when it changes.
  const localeRef = useRef(locale);

  // Open a helper session in the current locale. Shared by startListening
  // and the live language switch; the generation counter makes a superseded
  // start adopt-and-stop its session instead of clobbering the newer one's
  // id (two quick locale flips race their IPC round trips).
  const startGenRef = useRef(0);
  const startSession = useCallback(async (status: string) => {
    const speech = window.capturia?.speech;
    if (!speech) return;
    const gen = ++startGenRef.current;
    startingRef.current = true;
    setSpeechStatus(status);
    try {
      const id = await speech.start(appleSpeechLocale(localeRef.current));
      // A stop (or unmount, which clears listeningRef) can land during the
      // IPC round trip; adopting the session then would leave a hot mic
      // nothing points at.
      if (gen !== startGenRef.current || !listeningRef.current) {
        speech.stop(id).catch(() => {});
        return;
      }
      sessionIdRef.current = id;
    } catch (err) {
      // A superseded start's failure is not the newer session's problem.
      if (gen === startGenRef.current) {
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(msg);
        setSpeechStatus(`error: ${msg}`);
        listeningRef.current = false;
        setIsListening(false);
      }
    } finally {
      if (gen === startGenRef.current) startingRef.current = false;
    }
  }, []);

  const startListening = useCallback(async () => {
    if (!window.capturia?.speech || listeningRef.current) return;
    listeningRef.current = true;
    setIsListening(true);
    setLastError("");
    setInterimTranscript("");
    await startSession("starting speech engine…");
  }, [startSession]);

  // Live language switch: while listening, start a NEW helper session in the
  // new locale. Main's speech:start stops the old helper itself, and the
  // sessionId tag on events lets the old session's trailing finals/done
  // drain without touching this one (the same overlap a stop/start restart
  // already survives; startingRef keeps the drain from flipping the
  // listening state).
  useEffect(() => {
    const prev = localeRef.current;
    localeRef.current = locale;
    if (prev === locale || !listeningRef.current) return;
    void startSession("switching language…");
  }, [locale, startSession]);

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
