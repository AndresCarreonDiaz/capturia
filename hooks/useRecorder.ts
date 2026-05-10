"use client";
import { useCallback, useRef, useState } from "react";

export interface RecorderState {
  isRecording: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
}

export function useRecorder(): RecorderState {
  const [isRecording, setIsRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = useCallback(async () => {
    try {
      // Capture current browser tab — pre-selects this tab in Chrome's picker
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 } as MediaTrackConstraints,
        audio: false,
        preferCurrentTab: true,
      } as DisplayMediaStreamOptions & { preferCurrentTab?: boolean });

      // Grab mic audio separately (already active from WebcamFeed, so just audio)
      let audioTracks: MediaStreamTrack[] = [];
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            sampleRate: 44100,
          },
          video: false,
        });
        audioTracks = audioStream.getAudioTracks();
      } catch {
        // Mic unavailable — record video-only
      }

      const stream = new MediaStream([
        ...displayStream.getVideoTracks(),
        ...audioTracks,
      ]);

      const mimeType =
        [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
        ].find((t) => MediaRecorder.isTypeSupported(t)) ?? "video/webm";

      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 5_000_000,
      });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `capturia-${Date.now()}.webm`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setIsRecording(false);
      };

      recorder.start(250);
      recorderRef.current = recorder;
      setIsRecording(true);

      // Auto-stop if the user ends screen sharing from the browser's share bar
      displayStream.getVideoTracks()[0].addEventListener("ended", () => {
        if (recorder.state !== "inactive") recorder.stop();
      });
    } catch {
      // User cancelled the picker or permission denied — no-op
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state !== "inactive") {
      recorderRef.current?.stop();
    }
  }, []);

  return { isRecording, startRecording, stopRecording };
}
