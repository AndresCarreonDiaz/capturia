// Pure easing for the synthetic "speaking energy" (0..1) that drives the
// audio-reactive overlays. We deliberately do NOT use an AudioContext analyser:
// it fights the Web Speech API (running both throws speech recognition into a
// restart loop), so energy is derived from speech-recognition RESULTS instead.
// While "speaking", energy rises toward 1 with a fast exponential attack;
// otherwise it falls linearly toward 0. Both are TIME-based (dtMs), so the
// envelope reads identically on 60Hz and 120Hz displays and survives rAF
// throttling. Kept pure + framework-free so it is unit-testable; the
// requestAnimationFrame wiring lives in hooks/useSpeechEnergy.ts.

// Attack: exponential time constant of the rise (63% of the remaining gap per
// tau). 40ms keeps the original snap: ~0.9 within ~100ms of speech.
export const ATTACK_TAU_MS = 40;
// Decay: linear fall per second. 1.2/s is a deliberately long ~830ms release:
// Chrome's interim results can arrive 300-600ms apart during continuous
// speech, and the release has to bridge those gaps (plus SPEAK_WINDOW_MS)
// without the feed visibly pumping word by word.
export const DECAY_PER_SEC = 1.2;
// How long after the last recognition result we still count as "speaking".
// Consumed by hooks/useSpeechEnergy.ts; lives here so tests can pin the
// window and the release together.
export const SPEAK_WINDOW_MS = 450;
// rAF can pause for seconds (tab switch, window drag). Clamp the step so a
// resume never teleports the envelope.
export const MAX_STEP_MS = 100;

export function stepEnergy(prev: number, speaking: boolean, dtMs = 16.7): number {
  const dt = Math.min(Math.max(dtMs, 0), MAX_STEP_MS);
  const next = speaking
    ? prev + (1 - prev) * (1 - Math.exp(-dt / ATTACK_TAU_MS))
    : prev - (dt / 1000) * DECAY_PER_SEC;
  return Math.min(1, Math.max(0, next));
}
