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
interface CapturiaBridge {
  isDesktop: boolean;
  onHotkey: (handler: (payload: HotkeyPayload) => void) => () => void;
  transcribe: (wavBytes: ArrayBuffer) => Promise<string>;
  keys: {
    save: (provider: KeyProvider, key: string) => Promise<KeyEntry[]>;
    clear: (provider: KeyProvider) => Promise<KeyEntry[]>;
    list: () => Promise<KeyEntry[]>;
    // Returns the plaintext key for the active provider, or null. Desktop-only,
    // origin-checked in main; used to attach the BYOK request header.
    get: (provider: KeyProvider) => Promise<string | null>;
  };
  // Deck codegen: run a prompt on the stored key in main, return raw model text.
  generateCues: (prompt: string, provider: KeyProvider) => Promise<string>;
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
