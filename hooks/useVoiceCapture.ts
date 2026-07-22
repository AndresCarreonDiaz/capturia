"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { webSpeechLang } from "@/lib/voice-locale";

// Web Speech API types (not in all TS DOM lib versions)
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function getSR(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    (window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor })
      .SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionConstructor })
      .webkitSpeechRecognition
  );
}

export interface VoiceCaptureState {
  isListening: boolean;
  interimTranscript: string;
  speechStatus: string;
  lastError: string;   // persists even when status cycles, so we see the real failure
  // performance.now() of the latest onresult (0 = none yet). The audio-reactive
  // energy (useSpeechEnergy) keys off this rather than transcript/status text:
  // results fire ONLY while the recognizer hears speech, while status churns
  // through the silence-restart cycle and interim strings can repeat unchanged.
  lastResultAt: number;
  isSupported: boolean;
  startListening: () => void;
  stopListening: () => void;
}

export function useVoiceCapture(
  onFinalResult: (text: string) => void,
  onInterimResult?: (text: string) => void,
  onSegmentEnd?: () => void,
  // Canonical BCP-47 tag from lib/voice-locale.ts; anything else lands on
  // the default. A change rebuilds the recognizer (recognition.lang is fixed
  // at start), restarting it live if a session is running.
  locale?: string
): VoiceCaptureState {
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [lastResultAt, setLastResultAt] = useState(0);
  const [speechStatus, setSpeechStatus] = useState("idle");
  const [lastError, setLastError] = useState("");
  const [isSupported, setIsSupported] = useState(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const isListeningRef = useRef(false);
  const onFinalRef = useRef(onFinalResult);
  const onInterimRef = useRef(onInterimResult);
  const onSegmentEndRef = useRef(onSegmentEnd);
  useEffect(() => {
    onFinalRef.current = onFinalResult;
    onInterimRef.current = onInterimResult;
    onSegmentEndRef.current = onSegmentEnd;
  });

  useEffect(() => {
    const SR = getSR();
    if (!SR) {
      setIsSupported(false);
      setSpeechStatus("not supported");
      return;
    }

    // Electron renderer: webkitSpeechRecognition exists, but the Web Speech
    // backend needs Google's private Speech API key (shipped only inside
    // Chrome). Electron doesn't have it, so every call returns "network".
    // Hide voice in desktop until local whisper.cpp lands.
    const inDesktop = (window as unknown as { capturia?: { isDesktop?: boolean } })
      .capturia?.isDesktop === true;
    if (inDesktop) {
      setIsSupported(false);
      setSpeechStatus("not supported");
      return;
    }

    // Brave is Chromium-based so SpeechRecognition exists, but Brave Shields
    // blocks the Google speech endpoint by default and the API never returns
    // results. Detect Brave so the voice button hides instead of throwing a
    // confusing 'network' error mid-use.
    const brave = (navigator as unknown as {
      brave?: { isBrave?: () => Promise<boolean> };
    }).brave;
    if (brave?.isBrave) {
      brave.isBrave().then((isBrave) => {
        setIsSupported(!isBrave);
        if (isBrave) setSpeechStatus("not supported");
      });
    } else {
      setIsSupported(true);
    }

    // A language switch disposes this recognizer and builds a fresh one (the
    // effect re-runs on `locale`). The old one's onend fires AFTER the swap,
    // when isListeningRef is true again for the successor, so without this
    // flag it would schedule a restart of ITSELF: two recognizers on one
    // mic, the stale one still in the old language.
    let disposed = false;

    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = webSpeechLang(locale);

    // Pipeline stages: each one logs so we know exactly where it breaks
    recognition.onstart = () => setSpeechStatus("started, waiting for audio…");
    recognition.onaudiostart = () => setSpeechStatus("audio received, speak now");
    recognition.onspeechstart = () => setSpeechStatus("speech detected…");

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) final += text;
        else interim += text;
      }
      setSpeechStatus(final.trim() ? "sent ✓" : "recognizing…");
      setLastResultAt(performance.now());
      // Finals precede interims positionally in event.results, and one event
      // routinely carries utterance A's final plus utterance B's first
      // hypothesis. Dispatch in that order: the final must close A's cue
      // segment before B's interim seeds the next one, or A's stale
      // candidate could be confirmed by B's unrelated first words.
      if (final.trim()) onFinalRef.current(final.trim());
      // Current-cycle hypothesis; deterministic cue matching fires primed
      // cards from it mid-sentence (M9).
      if (interim.trim()) onInterimRef.current?.(interim);
      setInterimTranscript(interim);
    };

    recognition.onend = () => {
      // A recognizer cycle is a segment boundary whether or not it produced
      // a final: interims never survive a restart, so consumers must not
      // carry this cycle's cue-dedup state into the next one.
      onSegmentEndRef.current?.();
      if (disposed) return;
      if (isListeningRef.current) {
        // 600ms pause before restarting. Stops the crazy rapid cycling and
        // gives the status text time to be readable between attempts
        setSpeechStatus("restarting…");
        restartTimerRef.current = setTimeout(() => {
          if (isListeningRef.current) {
            try { recognition.start(); } catch { /* ignore */ }
          }
        }, 600);
      } else {
        setSpeechStatus("idle");
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // lastError persists so rapid cycling can't overwrite it before user reads it
      setLastError(event.error);
      setSpeechStatus(`error: ${event.error}`);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        isListeningRef.current = false;
        setIsListening(false);
      }
    };

    recognitionRef.current = recognition;
    return () => {
      disposed = true;
      isListeningRef.current = false;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      recognition.stop();
    };
  }, [locale]);

  // `locale` is a dep so a language switch restarts a live session on the
  // freshly built recognizer above (effects re-run in order: rebuild, then
  // start). Idle, the extra run just re-asserts the idle state.
  useEffect(() => {
    isListeningRef.current = isListening;
    const rec = recognitionRef.current;
    if (!rec) return;
    if (isListening) {
      setSpeechStatus("connecting…");
      try { rec.start(); } catch { /* already running */ }
    } else {
      rec.stop();
      setInterimTranscript("");
      setSpeechStatus("idle");
    }
  }, [isListening, locale]);

  const startListening = useCallback(() => setIsListening(true), []);
  const stopListening = useCallback(() => setIsListening(false), []);

  return { isListening, interimTranscript, speechStatus, lastError, lastResultAt, isSupported, startListening, stopListening };
}
