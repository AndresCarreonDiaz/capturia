"use client";
import { useEffect, useRef, useState } from "react";

type HotkeyPayload = { action: string };

// The full surface exposed by electron/preload.js via contextBridge. All
// desktop hooks (hotkey, voice capture, key vault) reference this single
// declaration so the global Window["capturia"] type stays in one place.
export type KeyProvider = "gemini" | "claude" | "openai";
export interface KeyEntry {
  provider: KeyProvider;
  has: boolean;
  mask: string | null;
}
// Where main's loopback CopilotKit runtime listens: the absolute runtimeUrl
// plus the per-launch bearer token that authenticates the renderer to it.
export interface DesktopRuntimeInfo {
  url: string;
  token: string;
}
// Voice state the renderer reports up to main; drives the tray menu status
// and its Start/Stop Listening item.
export interface DesktopStateReport {
  listening: boolean;
  voiceSupported: boolean;
}
interface CapturiaBridge {
  isDesktop: boolean;
  onHotkey: (handler: (payload: HotkeyPayload) => void) => () => void;
  transcribe: (wavBytes: ArrayBuffer) => Promise<string>;
  keys: {
    save: (provider: KeyProvider, key: string) => Promise<KeyEntry[]>;
    clear: (provider: KeyProvider) => Promise<KeyEntry[]>;
    list: () => Promise<KeyEntry[]>;
    // No `get`: the plaintext key never enters the renderer. The runtime
    // server in main reads the keychain itself (electron/runtime-server.js).
  };
  // null when the runtime server failed to start (renderer falls back to the
  // /api/copilotkit route, which works in dev).
  runtimeInfo: () => Promise<DesktopRuntimeInfo | null>;
  // Deck codegen: run a prompt on the stored key in main, return raw model text.
  generateCues: (prompt: string, provider: KeyProvider) => Promise<string>;
  // Optional: a stale packaged preload may predate this method; callers must
  // treat it as possibly missing (useDesktopStateReport already does).
  reportState?: (state: DesktopStateReport) => Promise<void>;
  // On-device streaming speech (macOS 26+ helper); optional for the same
  // stale-preload reason. Events: ready | downloading-model | interim |
  // final | error | done.
  speech?: {
    available: () => Promise<boolean>;
    start: (locale?: string) => Promise<number>;
    stop: (id: number) => Promise<void>;
    onEvent: (handler: (event: { type: string; text?: string; message?: string }) => void) => () => void;
  };
}

declare global {
  interface Window {
    capturia?: CapturiaBridge;
  }
}

// Subscribe to a global hotkey action emitted by the Electron main process.
// Safe to call from web (web has no window.capturia, so it's a no-op).
// Handler is stored in a ref so subscription stays stable across renders.
export function useDesktopHotkey(action: string, handler: () => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const bridge = window.capturia;
    if (!bridge?.onHotkey) return;
    return bridge.onHotkey((payload) => {
      if (payload?.action === action) handlerRef.current();
    });
  }, [action]);
}

// SSR-safe desktop detection. Returns false on server and on web; true only
// inside the Electron renderer where preload.js has run.
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    setIsDesktop(window.capturia?.isDesktop === true);
  }, []);
  return isDesktop;
}

// Mirror voice state up to the Electron main process whenever it changes, so
// the tray menu shows Listening/Idle and enables its toggle. No-op on web
// (no bridge) and against an older preload (reportState missing). The report
// is fire-and-forget; a rejected invoke must never break the studio.
export function useDesktopStateReport({ listening, voiceSupported }: DesktopStateReport) {
  useEffect(() => {
    window.capturia?.reportState?.({ listening, voiceSupported })?.catch(() => {});
  }, [listening, voiceSupported]);
}
