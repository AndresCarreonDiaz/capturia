// Pure voice-activity-detection state machine. The desktop capture hook
// feeds it one RMS sample per poll tick; it decides when an utterance ended
// so the recording can be sliced into a chunk and transcribed while the mic
// keeps listening. Extracted from the tap-to-talk hook so continuous mode
// (M9) is driven by tested transitions instead of timer spaghetti.

export interface VadConfig {
  // RMS at or below this is silence.
  silenceRms: number;
  // Speech shorter than this at utterance end is discarded as noise.
  minSpeechMs: number;
  // Silence this long after speech closes the utterance.
  trailingSilenceMs: number;
  // An utterance longer than this is force-closed (safety cap); the speech
  // simply continues into the next chunk.
  maxUtteranceMs: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  silenceRms: 0.015,
  minSpeechMs: 250,
  trailingSilenceMs: 800,
  maxUtteranceMs: 30000,
};

export type VadPhase = "waiting_for_speech" | "speaking" | "trailing_silence";

export interface VadState {
  phase: VadPhase;
  // When this utterance window opened (recorder start).
  startedAt: number;
  speechStartedAt: number;
  silenceStartedAt: number;
}

// What the caller should do after a step:
// - none: keep polling
// - utterance_end: real speech ended; slice the chunk and transcribe it
// - discard: the window closed with no usable speech (too short / pure
//   noise blip); slice and drop without transcribing
export type VadAction = "none" | "utterance_end" | "discard";

export interface VadStep {
  state: VadState;
  action: VadAction;
  speaking: boolean;
}

export function createVadState(now: number): VadState {
  return { phase: "waiting_for_speech", startedAt: now, speechStartedAt: 0, silenceStartedAt: 0 };
}

export function stepVad(
  state: VadState,
  rms: number,
  now: number,
  cfg: VadConfig = DEFAULT_VAD_CONFIG
): VadStep {
  const loud = rms > cfg.silenceRms;
  const next: VadState = { ...state };

  // Safety cap: close the window regardless of phase. Mid-speech, the window
  // ALWAYS transcribes (clipping words because a sentence straddled the cap
  // would be worse than an occasional short chunk; the next window catches
  // the continuation). In trailing silence the utterance is judged by its
  // real speech span; a window that never heard speech has nothing to keep.
  if (now - state.startedAt > cfg.maxUtteranceMs) {
    if (state.phase === "speaking") {
      return { state: next, action: "utterance_end", speaking: loud };
    }
    if (state.phase === "trailing_silence") {
      const speechDuration = state.silenceStartedAt - state.speechStartedAt;
      return {
        state: next,
        action: speechDuration >= cfg.minSpeechMs ? "utterance_end" : "discard",
        speaking: false,
      };
    }
    return { state: next, action: "discard", speaking: false };
  }

  switch (state.phase) {
    case "waiting_for_speech": {
      if (loud) {
        next.phase = "speaking";
        next.speechStartedAt = now;
        return { state: next, action: "none", speaking: true };
      }
      return { state: next, action: "none", speaking: false };
    }
    case "speaking": {
      if (loud) return { state: next, action: "none", speaking: true };
      next.phase = "trailing_silence";
      next.silenceStartedAt = now;
      return { state: next, action: "none", speaking: false };
    }
    case "trailing_silence": {
      if (loud) {
        // Speaker resumed before the window closed.
        next.phase = "speaking";
        return { state: next, action: "none", speaking: true };
      }
      if (now - state.silenceStartedAt >= cfg.trailingSilenceMs) {
        const speechDuration = state.silenceStartedAt - state.speechStartedAt;
        return {
          state: next,
          action: speechDuration >= cfg.minSpeechMs ? "utterance_end" : "discard",
          speaking: false,
        };
      }
      return { state: next, action: "none", speaking: false };
    }
  }
}
