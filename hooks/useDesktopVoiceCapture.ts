"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceCaptureState } from "./useVoiceCapture";
import { createVadState, stepVad, DEFAULT_VAD_CONFIG, type VadState } from "@/lib/vad";
import { createSerialQueue, isLikelyHallucination } from "@/lib/transcript-stream";

// Continuous, hands-free desktop voice backed by local whisper.cpp through
// the Electron main process (M9 part 1). Same VoiceCaptureState shape as the
// web hook so the studio swap stays a one-line import switch.
//
// One toggle opens a SESSION, not an utterance: the mic stays open, the pure
// VAD machine (lib/vad.ts) watches energy, and every pause slices the
// recording into a chunk that transcribes in the background (serial queue;
// whisper handles one job at a time) while the mic keeps listening. Toggling
// again ends the session and flushes the last chunk.
//
// Lifecycle discipline (shaped by adversarial review): every session gets a
// generation id and every async continuation checks it, so a stale handler
// from a stopped session can never touch a newer session's stream. Each
// recorder owns its chunks in closure (no shared buffer to race) and carries
// an explicit intent; a stop event with NO intent is device-initiated (mic
// unplugged, input switched) and ends the session with a visible error
// instead of a zombie "listening" state.

const WHISPER_SAMPLE_RATE = 16000;
const VAD_POLL_MS = 50;
// Throttle for lastResultAt stamps while speaking; drives the audio-reactive
// energy FX without re-rendering the studio at poll frequency.
const ENERGY_STAMP_MS = 250;
// More queued chunks than this means whisper cannot keep up; newest chunks
// are dropped with a visible status rather than growing silently stale.
const MAX_QUEUED_CHUNKS = 3;
// A single chunk transcription taking longer than this is treated as hung.
const TRANSCRIBE_TIMEOUT_MS = 60000;

type RecorderIntent = "slice-transcribe" | "slice-discard" | "final-flush";

interface ManagedRecorder {
  recorder: MediaRecorder;
  chunks: Blob[];
  intent: RecorderIntent | null;
}

export function useDesktopVoiceCapture(
  onFinalResult: (text: string) => void
): VoiceCaptureState {
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript] = useState("");
  const [speechStatus, setSpeechStatus] = useState("idle");
  const [lastError, setLastError] = useState("");
  const [isSupported, setIsSupported] = useState(false);
  const [lastResultAt, setLastResultAt] = useState(0);

  // Generation counter: bumped on every start AND stop, so continuations
  // from any older session no-op against the current one.
  const sessionRef = useRef(0);
  const managedRef = useRef<ManagedRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
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

  // Hard-release everything the current session holds. Safe to call twice.
  const teardown = useCallback(() => {
    stopVad();
    const managed = managedRef.current;
    if (managed && managed.recorder.state !== "inactive") {
      // Mark as deliberate so the default onstop does not report a device
      // failure for a stop we initiated.
      managed.intent = "slice-discard";
      try {
        managed.recorder.stop();
      } catch {
        /* ignore */
      }
    }
    managedRef.current = null;
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    streamRef.current = null;
  }, [stopVad]);

  // End the session because the capture device failed under us (track ended,
  // recorder error). Visible error, full release, no zombie "listening".
  const failSession = useCallback(
    (session: number, why: string) => {
      if (sessionRef.current !== session || !isListeningRef.current) return;
      sessionRef.current += 1;
      isListeningRef.current = false;
      setIsListening(false);
      setLastError(why);
      setSpeechStatus(`error: ${why}`);
      teardown();
    },
    [teardown]
  );

  // Transcribe one sliced utterance in the background. The session keeps
  // recording while this runs; results fire in spoken order via the queue.
  const transcribeChunk = useCallback((chunks: Blob[], mime: string) => {
    if (transcribeQueueRef.current.pendingCount() >= MAX_QUEUED_CHUNKS) {
      setSpeechStatus("whisper backlog, dropped a chunk");
      return;
    }
    transcribeQueueRef.current(async () => {
      const blob = new Blob(chunks, { type: mime });
      const wav = await blobToWavMono16k(blob);
      const transcript = await withTimeout(
        window.capturia!.transcribe(wav),
        TRANSCRIBE_TIMEOUT_MS,
        "transcription timed out"
      );
      const text = (transcript || "").trim();
      if (text && !isLikelyHallucination(text)) {
        setSpeechStatus(isListeningRef.current ? "sent, still listening" : "sent ✓");
        onFinalRef.current(text);
      } else if (isListeningRef.current) {
        setSpeechStatus("listening…");
      } else {
        setSpeechStatus("idle");
      }
    });
  }, []);

  // Create a recorder bound to `session`, with its chunks in closure and a
  // default onstop that distinguishes deliberate slices from device death.
  const makeRecorder = useCallback(
    (stream: MediaStream, mime: string, session: number): ManagedRecorder => {
      const managed: ManagedRecorder = {
        recorder: new MediaRecorder(stream, { mimeType: mime }),
        chunks: [],
        intent: null,
      };
      managed.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) managed.chunks.push(e.data);
      };
      managed.recorder.onerror = () => {
        failSession(session, "microphone error");
      };
      managed.recorder.onstop = () => {
        if (sessionRef.current !== session) return; // stale session: its teardown owns cleanup
        const intent = managed.intent;

        if (intent === "final-flush") {
          // Deliberate session end: transcribe the tail, release the mic.
          const stream2 = streamRef.current;
          if (stream2) {
            stream2.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
          }
          managedRef.current = null;
          if (managed.chunks.length > 0) {
            setSpeechStatus("transcribing…");
            transcribeChunk(managed.chunks, mime);
          } else {
            setSpeechStatus("idle");
          }
          return;
        }

        if (intent === "slice-transcribe" || intent === "slice-discard") {
          if (intent === "slice-transcribe" && managed.chunks.length > 0) {
            setSpeechStatus("transcribing…");
            transcribeChunk(managed.chunks, mime);
          }
          // Session continues: keep the mic hot with a fresh recorder.
          if (isListeningRef.current && stream.active) {
            try {
              const next = makeRecorderRef.current!(stream, mime, session);
              managedRef.current = next;
              next.recorder.start();
              vadStateRef.current = createVadState(Date.now());
            } catch {
              failSession(session, "microphone lost between utterances");
            }
          }
          return;
        }

        // No intent: the device stopped us (mic unplugged, input switched).
        failSession(session, "microphone disconnected");
      };
      return managed;
    },
    [failSession, transcribeChunk]
  );
  // Self-reference so onstop can build the successor recorder. Assigned in
  // an effect (not during render); onstop only fires long after mount.
  const makeRecorderRef = useRef<typeof makeRecorder | null>(null);
  useEffect(() => {
    makeRecorderRef.current = makeRecorder;
  }, [makeRecorder]);

  const startListening = useCallback(async () => {
    if (isListeningRef.current) return;
    if (!window.capturia?.transcribe) {
      setLastError("Desktop bridge unavailable.");
      setSpeechStatus("error: bridge");
      return;
    }
    const session = ++sessionRef.current;
    // A previous session's final-flush may still be in flight; bumping the
    // session id just made its onstop a stale no-op, so reclaim its stream
    // here. Its tail chunk is dropped by design: the user is starting over.
    const priorStream = streamRef.current;
    if (priorStream) {
      priorStream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    managedRef.current = null;
    isListeningRef.current = true;
    setLastError("");
    setSpeechStatus("opening mic…");
    setIsListening(true);

    try {
      const mime = pickRecorderMime();
      if (!mime) throw new Error("No supported audio codec for MediaRecorder.");
      mimeRef.current = mime;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (sessionRef.current !== session || !isListeningRef.current) {
        // Session was stopped (or replaced) while the mic prompt was open.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      // Device death (Bluetooth drop, input switch) must end the session
      // loudly, not leave the VAD polling a silent analyser forever.
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener("ended", () => failSession(session, "microphone disconnected"));
      });

      const managed = makeRecorder(stream, mime, session);
      managedRef.current = managed;
      managed.recorder.start();
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
        if (sessionRef.current !== session) return;
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
        // the studio does not re-render at poll frequency. performance.now()
        // because that is useSpeechEnergy's clock (an epoch stamp pegs the
        // decay math and the vignette never relaxes).
        if (step.speaking && now - lastStampRef.current >= ENERGY_STAMP_MS) {
          lastStampRef.current = now;
          setLastResultAt(performance.now());
        }

        if (step.action !== "none") {
          const managed2 = managedRef.current;
          if (!managed2 || managed2.recorder.state === "inactive") return;
          managed2.intent =
            step.action === "utterance_end" ? "slice-transcribe" : "slice-discard";
          try {
            managed2.recorder.stop();
          } catch {
            failSession(session, "microphone error");
          }
        }
      }, VAD_POLL_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (sessionRef.current === session) {
        setLastError(msg);
        setSpeechStatus(`error: ${msg}`);
        teardown();
        isListeningRef.current = false;
        setIsListening(false);
      }
    }
  }, [teardown, makeRecorder, failSession]);

  const stopListening = useCallback(() => {
    if (!isListeningRef.current) return;
    isListeningRef.current = false;
    setIsListening(false);
    setSpeechStatus("finishing…");
    stopVad();

    const managed = managedRef.current;
    if (managed && managed.recorder.state !== "inactive") {
      // Flush the last utterance; the recorder's own onstop releases the
      // stream. The session id stays current so that onstop still runs; the
      // NEXT startListening bumps it and takes fresh refs.
      managed.intent = "final-flush";
      try {
        managed.recorder.stop();
      } catch {
        teardown();
        setSpeechStatus("idle");
      }
    } else {
      teardown();
      setSpeechStatus("idle");
    }
  }, [teardown, stopVad]);

  useEffect(() => {
    return () => {
      sessionRef.current += 1;
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
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
