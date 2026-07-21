"use client";
import { useEffect, useRef, useState } from "react";
import type { SysextStateReport } from "@/lib/sysext";
import type { HostedUsage } from "@/lib/hosted-billing";

// Actions main pushes on the "hotkey" channel. index rides along on the
// "fire-cue" action (deck rail position, 0-based); consumers must validate
// it since only `action` is shape-checked at the bridge.
type HotkeyPayload = { action: string; index?: number };

// The full surface exposed by electron/preload.js via contextBridge. All
// desktop hooks (hotkey, voice capture, key vault) reference this single
// declaration so the global Window["capturia"] type stays in one place.
// "capturia-hosted" holds the Capturia Pro access token (hosted tier, M11)
// in the same vault slot shape as the BYOK vendor keys.
export type KeyProvider = "gemini" | "claude" | "openai" | "capturia-hosted";
export interface KeyEntry {
  provider: KeyProvider;
  has: boolean;
  mask: string | null;
}
// Where main's loopback CopilotKit runtime listens: the absolute runtimeUrl
// plus the per-launch bearer token that authenticates the renderer to it.
// { disabled: true } when the runtime failed to start on the static file://
// build, where the /api/copilotkit fallback route does not exist: AI stays
// off until main restarts the engine (tray: Restart AI engine) and reloads
// the page on success.
export type DesktopRuntimeInfo = { url: string; token: string } | { disabled: true };
// State the renderer reports up to main; drives the tray menu status, its
// Start/Stop Listening item, and (via cueCount, the loaded deck size) the
// registration of the global cue-card hotkeys.
export interface DesktopStateReport {
  listening: boolean;
  voiceSupported: boolean;
  cueCount: number;
}
// Virtual-camera feed state main reports (the Capturia CMIO extension fed by
// the offscreen Program Output window; electron/camera-feed.js).
export interface DesktopCameraState {
  available: boolean;
  running: boolean;
  // Wanted but not delivering yet: page load (with retries) or sink-connect
  // backoff. A stop request while connecting cancels the pending start.
  connecting: boolean;
  // Running, but the page has stopped painting (viewers see a frozen frame).
  frozen: boolean;
  fps: number;
  // Offscreen page paints in the last full second, and when the last one was.
  paintFps: number;
  lastPaintAt: number | null;
  pumped: number;
  droppedQueueFull: number;
  error: string | null;
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
  // null when the runtime server failed to start in dev (renderer falls back
  // to the /api/copilotkit route, which Next serves); { disabled: true } when
  // it failed on the static build, where no fallback route exists.
  runtimeInfo: () => Promise<DesktopRuntimeInfo | null>;
  // Capturia Pro upgrade flow (M11 slice 2); optional because a stale
  // packaged preload may predate it. checkout() opens the Stripe page in
  // the OS browser; activate() trades a pasted one-time code for
  // keychain-held credentials, resolving { ok, devices } or rejecting with
  // a human-readable message.
  billing?: {
    checkout: () => Promise<{ ok: boolean }>;
    activate: (code: string) => Promise<{ ok: boolean; devices?: number }>;
    // Current-period hosted usage for the Settings hours meter; optional
    // within the optional bridge because it shipped later than
    // checkout/activate. Rejects when Pro is inactive or the endpoint is
    // unreachable; callers treat that as "no meter", never an error state.
    getUsage?: () => Promise<HostedUsage>;
    // Releases this device's hosted seat server-side (issue #10); optional
    // because it shipped later than checkout/activate. The caller follows a
    // resolved deactivation with keys.clear("capturia-hosted") so the local
    // clear rides the existing vault-clear routing. Rejects with a
    // human-readable message and clears NOTHING on failure.
    deactivate?: () => Promise<{ ok: boolean }>;
    // Opens the Stripe customer portal (card, invoices, cancel) in the OS
    // browser; optional for the same stale-preload reason.
    portal?: () => Promise<{ ok: boolean }>;
  };
  // Deck codegen: run a prompt on the stored key in main, return raw model text.
  generateCues: (prompt: string, provider: KeyProvider) => Promise<string>;
  // Optional: a stale packaged preload may predate this method; callers must
  // treat it as possibly missing (useDesktopStateReport already does).
  reportState?: (state: DesktopStateReport) => Promise<void>;
  // Virtual camera (M7b): the Capturia CMIO extension feed owned by main;
  // optional for the same stale-preload reason. The invokes resolve null when
  // main has no camera module (electron/gen not built).
  camera?: {
    state: () => Promise<DesktopCameraState | null>;
    start: () => Promise<DesktopCameraState | null>;
    stop: () => Promise<DesktopCameraState | null>;
    onState: (handler: (state: DesktopCameraState) => void) => () => void;
  };
  // In-app camera-extension activation (M8 slice 2); optional for the same
  // stale-preload reason. state/install resolve the current status snapshot
  // (null when main has no sysext module); onState subscribes to the status
  // transitions main pushes on the "sysext" channel.
  cameraExtension?: {
    state: () => Promise<SysextStateReport | null>;
    install: () => Promise<SysextStateReport | null>;
    onState: (handler: (state: SysextStateReport) => void) => () => void;
  };
  // Anonymous usage beacon toggle (electron/telemetry.js); optional for the
  // same stale-preload reason. Only the boolean crosses the bridge: the
  // installId and the sending live in main. ackDisclosure (optional again,
  // it shipped later than get/set) releases the first-run consent gate once
  // the onboarding disclosure is resolved.
  telemetry?: {
    get: () => Promise<{ enabled: boolean } | null>;
    set: (enabled: boolean) => Promise<{ enabled: boolean } | null>;
    ackDisclosure?: () => Promise<{ enabled: boolean } | null>;
  };
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
// Handler is stored in a ref so subscription stays stable across renders;
// it receives the payload for actions that carry data (fire-cue's index).
export function useDesktopHotkey(action: string, handler: (payload: HotkeyPayload) => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const bridge = window.capturia;
    if (!bridge?.onHotkey) return;
    return bridge.onHotkey((payload) => {
      if (payload?.action === action) handlerRef.current(payload);
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

// Mirror renderer state up to the Electron main process whenever it changes,
// so the tray menu shows Listening/Idle and enables its toggle, and main can
// bind/release the global cue hotkeys with the deck. No-op on web (no
// bridge) and against an older preload (reportState missing); an older MAIN
// simply ignores cueCount (its report assertion rebuilds the object from the
// two booleans). The report is fire-and-forget; a rejected invoke must never
// break the studio.
export function useDesktopStateReport({ listening, voiceSupported, cueCount }: DesktopStateReport) {
  useEffect(() => {
    window.capturia?.reportState?.({ listening, voiceSupported, cueCount })?.catch(() => {});
  }, [listening, voiceSupported, cueCount]);
}

// Camera-extension activation state plus the install trigger. state is null
// on web, on a stale preload, and while main has no sysext module; callers
// then hide every install affordance (the onboarding camera step and any
// install UI key off state being present and not "unsupported"). install is
// fire-and-forget: outcomes arrive as pushed state transitions, and a
// rejected invoke must never break the studio.
export function useCameraExtension(): {
  state: SysextStateReport | null;
  install: () => void;
} {
  const [state, setState] = useState<SysextStateReport | null>(null);
  useEffect(() => {
    const bridge = window.capturia?.cameraExtension;
    if (!bridge) return;
    let cancelled = false;
    bridge
      .state()
      .then((s) => {
        if (!cancelled && s) setState(s);
      })
      .catch(() => {});
    const unsubscribe = bridge.onState((s) => setState(s));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  const install = () => {
    window.capturia?.cameraExtension
      ?.install()
      .then((s) => {
        if (s) setState(s);
      })
      .catch(() => {});
  };
  return { state, install };
}

// Live virtual-camera state: an initial snapshot plus the lifecycle
// transitions main pushes (connect, stop, crash recovery). null on web, on a
// stale preload, and while main has no camera module, so callers can simply
// hide any camera status when it is null.
export function useDesktopCameraState(): DesktopCameraState | null {
  const [state, setState] = useState<DesktopCameraState | null>(null);
  useEffect(() => {
    const camera = window.capturia?.camera;
    if (!camera) return;
    let cancelled = false;
    camera
      .state()
      .then((s) => {
        if (!cancelled && s) setState(s);
      })
      .catch(() => {});
    const unsubscribe = camera.onState((s) => setState(s));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return state;
}
