"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceCaptureState } from "./useVoiceCapture";
import { createVadState, stepVad, DEFAULT_VAD_CONFIG, type VadState } from "@/lib/vad";
import { createSerialQueue } from "@/lib/transcript-stream";

// Continuous, hands-free desktop voice backed by local whisper.cpp through
// the Electron main process (M9 part 1). Same VoiceCaptureState shape as the
// web hook so the studio swap stays a one-line import switch.
//
// One toggle opens a SESSION, not an utterance: the mic stays open, the pure
// VAD machine (lib/vad.ts) watches energy, and every pause slices the
// recording into a chunk that transcribes in the background (serial queue;
// whisper handles one job at a time) while the mic keeps listening. Toggling
// again ends the session and flushes the last chunk. Latency is
// utterance-class (about a second after each pause); the sub-second native
// streaming engine lands behind the same contract later (issue #8).

const WHISPER_SAMPLE_RATE = 16000;
const VAD_POLL_MS = 50;
// Throttle for lastResultAt stamps while speaking; drives the audio-reactive
// energy FX without re-rendering the studio at poll frequency.
const ENERGY_STAMP_MS = 250;

export function useDesktopVoiceCapture(
  onFinalResult: (text: string) => void
): VoiceCaptureState {
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript] = useState("");
  const [speechStatus, setSpeechStatus] = useState("idle");
  const [lastError, setLastError] = useState("");
  const [isSupported, setIsSupported] = useState(false);
  const [lastResultAt, setLastResultAt] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("");
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const vadStateRef = useRef<VadState | null>(null);
  const isListeningRef = useRef(false);
  const lastStampRef = useRef(0);
  const onFinalRef = useRef(onFinalResult);
  onFinalRef.current = onFinalResult;

  // Serial transcription queue: whisper in main rejects concurrent jobs, and
  // utterances must reach the agent in spoken order anyway.
  const transcribeQueueRef = useRef(
    createSerialQueue((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(msg);
      setSpeechStatus(`error: ${msg}`);
    })
  );

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

  // Transcribe one sliced utterance in the background. The session keeps
  // recording while this runs; results fire in spoken order via the queue.
  const transcribeChunk = useCallback((chunks: Blob[], mime: string) => {
    transcribeQueueRef.current(async () => {
      const blob = new Blob(chunks, { type: mime });
      const wav = await blobToWavMono16k(blob);
      const transcript = await window.capturia!.transcribe(wav);
      if (transcript && transcript.trim()) {
        setSpeechStatus(isListeningRef.current ? "sent, still listening" : "sent ✓");
        onFinalRef.current(transcript.trim());
      } else if (isListeningRef.current) {
        setSpeechStatus("listening…");
      }
    });
  }, []);

  // Slice the current utterance: stop the recorder (its onstop hands the
  // chunk to the transcriber) and, when the session continues, immediately
  // start a fresh recorder on the same open stream. `transcribe` is false
  // for VAD "discard" windows (noise blips, silent caps).
  const sliceUtterance = useCallback(
    (transcribe: boolean) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") return;
      const mime = mimeRef.current;
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (transcribe && chunks.length > 0) {
          setSpeechStatus("transcribing…");
          transcribeChunk(chunks, mime);
        }
        // Session still live: keep the mic hot with a new recorder.
        const stream = streamRef.current;
        if (isListeningRef.current && stream && stream.active) {
          const next = new MediaRecorder(stream, { mimeType: mime });
          recorderRef.current = next;
          next.ondataavailable = (e) => {
            if (e.data.size > 0) chunksRef.current.push(e.data);
          };
          next.start();
          vadStateRef.current = createVadState(Date.now());
        }
      };
      try {
        recorder.stop();
      } catch {
        /* recorder already gone; teardown paths handle the rest */
      }
    },
    [transcribeChunk]
  );

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
      recorder.start();
      setSpeechStatus("listening…");

      // Energy watcher for the VAD. AnalyserNode + AudioContext are safe next
      // to MediaRecorder on the same stream (the Web Speech conflict from the
      // feedback memory does not apply here; no Web Speech on desktop).
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
      vadStateRef.current = createVadState(Date.now());

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
        const now = Date.now();

        const step = stepVad(state, rms, now, DEFAULT_VAD_CONFIG);
        vadStateRef.current = step.state;

        // Audio-reactive energy: stamp while actually speaking, throttled so
        // the studio does not re-render at poll frequency.
        if (step.speaking && now - lastStampRef.current >= ENERGY_STAMP_MS) {
          lastStampRef.current = now;
          setLastResultAt(now);
        }

        if (step.action !== "none") {
          sliceUtterance(step.action === "utterance_end");
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
  }, [teardown, sliceUtterance]);

  const stopListening = useCallback(() => {
    if (!isListeningRef.current) return;
    isListeningRef.current = false;
    setIsListening(false);
    setSpeechStatus("finishing…");
    stopVad();

    const recorder = recorderRef.current;
    const mime = mimeRef.current;
    if (recorder && recorder.state !== "inactive") {
      // Flush the last utterance, then release the mic.
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];
        const stream = streamRef.current;
        if (stream) {
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
        recorderRef.current = null;
        if (chunks.length > 0) {
          setSpeechStatus("transcribing…");
          transcribeChunk(chunks, mime);
        } else {
          setSpeechStatus("idle");
        }
      };
      try {
        recorder.stop();
      } catch {
        teardown();
        setSpeechStatus("idle");
      }
    } else {
      teardown();
      setSpeechStatus("idle");
    }
  }, [teardown, stopVad, transcribeChunk]);

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
    // Live VAD stamps: the feed's energy FX now breathes on desktop too.
    lastResultAt,
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
