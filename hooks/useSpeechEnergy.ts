"use client";
import { useEffect, useRef } from "react";
import { stepEnergy, SPEAK_WINDOW_MS } from "@/lib/energy";

interface Args {
  targetRef: React.RefObject<HTMLElement | null>;
  // performance.now() of the most recent speech-recognition result (0 = none
  // yet). Stamped in useVoiceCapture's onresult, so it moves ONLY when the
  // recognizer actually heard something: lifecycle churn (the silence-restart
  // cycle fires onerror/onend/onstart every ~8s) and re-renders with an
  // unchanged transcript don't count as speech.
  lastResultAt: number;
  isListening: boolean;
}

/**
 * Conflict-free audio-reactivity. Opening an AudioContext analyser would fight
 * the Web Speech API (the two can't run at once; speech recognition drops into
 * a restart loop), so instead of reading the mic we derive a "speaking energy"
 * from Web Speech's OWN result events: frames within SPEAK_WINDOW_MS of the
 * last result count as speaking, and a requestAnimationFrame loop eases
 * stepEnergy() into the `--mic-energy` CSS variable (0..1) on targetRef. The
 * easing is time-based (rAF timestamps), so 60Hz and 120Hz displays breathe
 * identically. No React state in the loop and writes are skipped when the
 * value hasn't changed, so the sub-1s voice render hot path is untouched;
 * overlays read the var in CSS. Runs only while listening and resets to 0
 * when voice stops. The target element must be mounted whenever isListening
 * is true (the effect reads the ref once on start).
 */
export function useSpeechEnergy({ targetRef, lastResultAt, isListening }: Args) {
  const lastSpeakRef = useRef(0);
  const energyRef = useRef(0);
  const rafRef = useRef(0);

  useEffect(() => {
    if (isListening && lastResultAt > 0) lastSpeakRef.current = lastResultAt;
  }, [lastResultAt, isListening]);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;
    if (!isListening) {
      el.style.setProperty("--mic-energy", "0");
      energyRef.current = 0;
      return;
    }
    let running = true;
    let lastTick = 0;
    let lastWritten = "";
    const tick = (now: DOMHighResTimeStamp) => {
      if (!running) return;
      const dt = lastTick ? now - lastTick : undefined;
      lastTick = now;
      const speaking = now - lastSpeakRef.current < SPEAK_WINDOW_MS;
      energyRef.current = stepEnergy(energyRef.current, speaking, dt);
      const value = energyRef.current.toFixed(3);
      if (value !== lastWritten) {
        el.style.setProperty("--mic-energy", value);
        lastWritten = value;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
      el.style.setProperty("--mic-energy", "0");
      energyRef.current = 0;
    };
  }, [isListening, targetRef]);
}
