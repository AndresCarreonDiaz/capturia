"use client";
import { useEffect, useRef, useState } from "react";

export default function WebcamFeed() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream;
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
        }
      })
      .catch((e) => setError(e.message));

    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  if (error) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-neutral-900">
        <p className="text-red-400 text-sm font-mono">Camera error: {error}</p>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      className="absolute inset-0 w-full h-full object-cover"
    />
  );
}
