"use client";
import { useVoiceCapture, type VoiceCaptureState } from "./useVoiceCapture";
import { useDesktopVoiceCapture } from "./useDesktopVoiceCapture";
import { useAppleSpeechCapture } from "./useAppleSpeechCapture";

// Voice-capture façade for the studio. Picks the best backend available:
//   - Desktop on macOS 26+: on-device streaming SpeechAnalyzer helper
//     (sentence finals DURING speech, ~1s interims)
//   - Desktop otherwise: chunked local whisper.cpp sessions via IPC
//   - Web browser: Web Speech API (Chrome/Edge only)
//
// All hooks are called unconditionally to satisfy Rules of Hooks; unused
// ones are inert. A live session pins its engine: availability resolving
// mid-session must not swap the state source under the studio.
//
// onInterimResult receives the volatile current-segment hypothesis from the
// engines that stream one (apple-speech, Web Speech); chunked whisper has no
// interims. The studio uses it for deterministic cue matching mid-sentence.
// onSegmentEnd covers segment boundaries that produce NO final (filtered
// hallucinations, recognizer cycle restarts, session error/done). Boundaries
// WITH a final only guarantee onFinalResult (on web a mid-cycle final fires
// no onSegmentEnd), so consumers must treat BOTH callbacks as segment
// closers or interim dedup state will leak across sentences.
export function useStudioVoice(
  onFinalResult: (text: string) => void,
  onInterimResult?: (text: string) => void,
  onSegmentEnd?: () => void,
  // Canonical BCP-47 tag (lib/voice-locale.ts). Web Speech and apple-speech
  // both honor it, restarting live on a change. The whisper engine does NOT:
  // its shipped model (base.en) is English-only, so the Settings picker pins
  // English whenever whisper is the engine rather than pretending.
  locale?: string
): VoiceCaptureState {
  const web = useVoiceCapture(onFinalResult, onInterimResult, onSegmentEnd, locale);
  const whisper = useDesktopVoiceCapture(onFinalResult);
  const apple = useAppleSpeechCapture(onFinalResult, onInterimResult, onSegmentEnd, locale);

  const isDesktop =
    typeof window !== "undefined" && window.capturia?.isDesktop === true;

  if (!isDesktop) return web;
  if (apple.isListening) return apple;
  if (whisper.isListening) return whisper;
  return apple.isSupported ? apple : whisper;
}
