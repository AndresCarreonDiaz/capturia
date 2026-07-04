"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceCaptureState } from "./useVoiceCapture";

// Tap-to-start desktop voice capture backed by local whisper.cpp through the
// Electron main process. Same VoiceCaptureState shape as useVoiceCapture so
// the studio swap is a one-line import switch.
//
// Flow: tap mic / hotkey -> record -> energy-based VAD detects end of speech
// after VAD_TRAILING_SILENCE_MS of quiet -> auto-stop + transcribe -> fire
// onFinalResult once. User can also tap again to stop manually mid-utterance.
// No streaming / interim transcripts yet (next iteration if needed).

const WHISPER_SAMPLE_RATE = 16000;

// VAD tuning. AudioContext + AnalyserNode run in parallel with MediaRecorder
// on the same MediaStream (they don't conflict; the Web Speech / AudioContext
// conflict noted in feedback memory doesn't apply here since we're not using
// Web Speech).
const VAD_POLL_MS = 50;
const VAD_SILENCE_RMS = 0.015;        // RMS below this is considered silence
const VAD_MIN_SPEECH_MS = 250;        // need this much speech before auto-stop arms
const VAD_TRAILING_SILENCE_MS = 800;  // this much silence after speech triggers stop
const VAD_MAX_WAIT_FOR_SPEECH_MS = 6000;  // give up if user opens mic but never speaks
const VAD_MAX_RECORDING_MS = 30000;   // hard safety cap

type VadPhase = "waiting_for_speech" | "speaking" | "trailing_silence";

interface VadState {
  phase: VadPhase;
  startedAt: number;
  speechStartedAt: number;
  silenceStartedAt: number;
}

export function useDesktopVoiceCapture(
  onFinalResult: (text: string) => void
): VoiceCaptureState {
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript] = useState("");
  const [speechStatus, setSpeechStatus] = useState("idle");
  const [lastError, setLastError] = useState("");
  const [isSupported, setIsSupported] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("");
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const vadStateRef = useRef<VadState | null>(null);
  const isListeningRef = useRef(false);
  const onFinalRef = useRef(onFinalResult);
  onFinalRef.current = onFinalResult;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const ok =
      typeof window.capturia?.transcribe === "function" &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof window.MediaRecorder !== "undefined" &&
      typeof window.AudioContext !== "undefined";
    setIsSupported(ok);
    if (!ok) setSpeechStatus("not supported");
  }, []);

  const stopVad = useCallback(() => {
    if (vadTimerRef.current) {
      clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    vadStateRef.current = null;
    analyserRef.current = null;
    const ctx = audioCtxRef.current;
    if (ctx) {
      ctx.close().catch(() => {
        /* already closed */
      });
    }
    audioCtxRef.current = null;
  }, []);

  const teardown = useCallback(() => {
    stopVad();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
    recorderRef.current = null;
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    streamRef.current = null;
  }, [stopVad]);

  // Forward-declare stopListening so VAD timer can call it. We assign the
  // real implementation after defining startListening to avoid hoisting
  // issues with useCallback.
  const stopListeningRef = useRef<() => void>(() => {});

  const startListening = useCallback(async () => {
    if (isListeningRef.current) return;
    if (!window.capturia?.transcribe) {
      setLastError("Desktop bridge unavailable.");
      setSpeechStatus("error: bridge");
      return;
    }
    isListeningRef.current = true;
    setLastError("");
    setSpeechStatus("opening mic…");
    setIsListening(true);
    chunksRef.current = [];

    try {
      const mime = pickRecorderMime();
      if (!mime) throw new Error("No supported audio codec for MediaRecorder.");
      mimeRef.current = mime;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isListeningRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stopVad();
        const chunks = chunksRef.current;
        chunksRef.current = [];
        const s = streamRef.current;
        if (s) {
          s.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }

        if (chunks.length === 0) {
          isListeningRef.current = false;
          setIsListening(false);
          setSpeechStatus("idle");
          return;
        }

        try {
          setSpeechStatus("transcribing…");
          const blob = new Blob(chunks, { type: mimeRef.current });
          const wav = await blobToWavMono16k(blob);
          const transcript = await window.capturia!.transcribe(wav);

          isListeningRef.current = false;
          setIsListening(false);
          if (transcript && transcript.trim()) {
            setSpeechStatus("sent ✓");
            onFinalRef.current(transcript.trim());
          } else {
            setSpeechStatus("idle");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setLastError(msg);
          setSpeechStatus(`error: ${msg}`);
          isListeningRef.current = false;
          setIsListening(false);
        }
      };

      recorder.start();
      setSpeechStatus("listening, speak now");

      // VAD pipeline: AnalyserNode on the same MediaStream watches energy.
      // When silence persists after speech, auto-trigger stop.
      const AudioCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtor();
      audioCtxRef.current = ctx;
      const sourceNode = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      sourceNode.connect(analyser);
      analyserRef.current = analyser;

      const now = Date.now();
      vadStateRef.current = {
        phase: "waiting_for_speech",
        startedAt: now,
        speechStartedAt: 0,
        silenceStartedAt: 0,
      };

      const sampleBuffer = new Float32Array(analyser.fftSize);
      vadTimerRef.current = setInterval(() => {
        const state = vadStateRef.current;
        const a = analyserRef.current;
        if (!state || !a || !isListeningRef.current) return;

        a.getFloatTimeDomainData(sampleBuffer);
        let sumSquares = 0;
        for (let i = 0; i < sampleBuffer.length; i++) {
          sumSquares += sampleBuffer[i] * sampleBuffer[i];
        }
        const rms = Math.sqrt(sumSquares / sampleBuffer.length);
        const t = Date.now();
        const elapsed = t - state.startedAt;

        // Safety cap regardless of phase.
        if (elapsed > VAD_MAX_RECORDING_MS) {
          stopListeningRef.current();
          return;
        }

        if (state.phase === "waiting_for_speech") {
          if (rms > VAD_SILENCE_RMS) {
            state.phase = "speaking";
            state.speechStartedAt = t;
          } else if (elapsed > VAD_MAX_WAIT_FOR_SPEECH_MS) {
            // User opened mic but never spoke. Stop without transcribing
            // (empty buffer → onstop returns early).
            stopListeningRef.current();
          }
          return;
        }

        if (state.phase === "speaking") {
          if (rms > VAD_SILENCE_RMS) {
            // still speaking; keep going
          } else {
            state.phase = "trailing_silence";
            state.silenceStartedAt = t;
          }
          return;
        }

        if (state.phase === "trailing_silence") {
          if (rms > VAD_SILENCE_RMS) {
            // user resumed speaking; cancel the silence timer
            state.phase = "speaking";
          } else {
            const speechDuration = state.silenceStartedAt - state.speechStartedAt;
            const silenceDuration = t - state.silenceStartedAt;
            if (
              speechDuration >= VAD_MIN_SPEECH_MS &&
              silenceDuration >= VAD_TRAILING_SILENCE_MS
            ) {
              setSpeechStatus("processing…");
              stopListeningRef.current();
            }
          }
        }
      }, VAD_POLL_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      setSpeechStatus(`error: ${msg}`);
      teardown();
      isListeningRef.current = false;
      setIsListening(false);
    }
  }, [teardown, stopVad]);

  const stopListening = useCallback(() => {
    if (!isListeningRef.current) return;
    setSpeechStatus("stopping…");
    stopVad();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        teardown();
        isListeningRef.current = false;
        setIsListening(false);
      }
    } else {
      teardown();
      isListeningRef.current = false;
      setIsListening(false);
    }
  }, [teardown, stopVad]);

  // Keep the ref pointing at the latest stopListening so the VAD timer
  // (which closes over the first ref value) always calls the current one.
  stopListeningRef.current = stopListening;

  useEffect(() => {
    return () => {
      isListeningRef.current = false;
      teardown();
    };
  }, [teardown]);

  return {
    isListening,
    interimTranscript,
    speechStatus,
    lastError,
    // Whisper transcribes whole chunks after the fact, so there is no live
    // result stream to stamp; audio-reactive energy simply stays inert on
    // desktop until a streaming backend lands.
    lastResultAt: 0,
    isSupported,
    startListening,
    stopListening,
  };
}

function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

// Decode the recorded blob, resample to 16kHz mono via OfflineAudioContext,
// and encode as a 44-byte-header 16-bit PCM WAV. Sending pre-formatted WAV
// means whisper.cpp's input pipeline does no ffmpeg call.
async function blobToWavMono16k(blob: Blob): Promise<ArrayBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtor();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  audioCtx.close();

  const targetLength = Math.max(1, Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE));
  const offlineCtx = new OfflineAudioContext(1, targetLength, WHISPER_SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();

  return encodeWav(rendered.getChannelData(0), WHISPER_SAMPLE_RATE);
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const byteLength = 44 + samples.length * 2;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, "WAVE");

  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  writeString(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
