"use client";
import { useEffect, useState } from "react";
import type { KeyEntry, KeyProvider } from "@/hooks/useDesktopHotkey";
import { DEFAULT_VOICE_LOCALE, VOICE_LOCALES } from "@/lib/voice-locale";
import {
  listSelectableCameras,
  resolveCameraDevice,
  type CameraPreference,
} from "@/lib/camera-select";
import type { VideoInputInfo } from "@/lib/camera-feed";

// Sentinel option value for a persisted pick whose camera is not connected
// right now; disabled so it can only be displayed, never re-picked.
const DISCONNECTED_CAMERA = "__capturia-disconnected";

interface Props {
  open: boolean;
  onClose: () => void;
  keys: KeyEntry[];
  isReady: boolean;
  save: (provider: KeyProvider, key: string) => Promise<void>;
  clear: (provider: KeyProvider) => Promise<void>;
  activeProvider: KeyProvider;
  onSelectProvider: (provider: KeyProvider) => void;
  /** Speech-recognition language: the canonical BCP-47 tag (lib/voice-locale.ts). */
  voiceLocale: string;
  onSelectVoiceLocale: (tag: string) => void;
  /** Persisted camera pick (issue #12); null = automatic (the heuristic). */
  cameraPreference: CameraPreference | null;
  onSelectCamera: (preference: CameraPreference | null) => void;
}

const PROVIDER_META: Record<
  KeyProvider,
  { name: string; tagline: string; url: string; placeholder: string; note?: string }
> = {
  gemini: {
    name: "Google Gemini",
    tagline: "aistudio.google.com",
    url: "https://aistudio.google.com",
    placeholder: "AIza... or your Google AI Studio key",
    note: "Free: open aistudio.google.com, hit Get API key, paste it here. About a minute, no card needed.",
  },
  claude: {
    name: "Anthropic Claude",
    tagline: "console.anthropic.com",
    url: "https://console.anthropic.com",
    placeholder: "sk-ant-... key",
  },
  openai: {
    name: "OpenAI",
    tagline: "platform.openai.com",
    url: "https://platform.openai.com",
    placeholder: "sk-... key",
  },
};

const PROVIDER_ORDER: KeyProvider[] = ["gemini", "claude", "openai"];

export default function SettingsModal({
  open,
  onClose,
  keys,
  isReady,
  save,
  clear,
  activeProvider,
  onSelectProvider,
  voiceLocale,
  onSelectVoiceLocale,
  cameraPreference,
  onSelectCamera,
}: Props) {
  const [drafts, setDrafts] = useState<Partial<Record<KeyProvider, string>>>({});
  const [busy, setBusy] = useState<KeyProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Non-English disabled where it would be a lie: desktop below macOS 26
  // (and stale preloads without the speech bridge) transcribes with the
  // local English-only Whisper model, so a non-English pick there would
  // silently produce garbage. Web Speech and the macOS 26+ apple-speech
  // helper handle the whole curated list. Defaults open until the probe
  // answers; the probe is a sync check in main, so the window is tiny.
  const [englishOnly, setEnglishOnly] = useState(false);
  useEffect(() => {
    const bridge = window.capturia;
    if (!bridge?.isDesktop) return;
    let cancelled = false;
    const appleAvailable = bridge.speech
      ? bridge.speech.available().catch(() => false)
      : Promise.resolve(false);
    appleAvailable.then((ok) => {
      if (!cancelled) setEnglishOnly(!ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Video inputs for the camera picker (issue #12), enumerated per open so
  // the list reflects what is plugged in NOW, and refreshed on devicechange
  // while the modal is up. null until the first read answers (or where
  // mediaDevices does not exist, e.g. an insecure origin), which renders the
  // quiet detecting state instead of a wrong "no camera" verdict. State only
  // moves from the async callbacks; a sync reset would be the lint-banned
  // setState-in-effect cascade.
  const [videoInputs, setVideoInputs] = useState<VideoInputInfo[] | null>(null);
  useEffect(() => {
    if (!open) return;
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!media?.enumerateDevices) return;
    let cancelled = false;
    const refresh = () => {
      media
        .enumerateDevices()
        .then((devices) => {
          if (cancelled) return;
          setVideoInputs(
            devices
              .filter((d) => d.kind === "videoinput")
              .map((d) => ({ kind: d.kind, label: d.label, deviceId: d.deviceId }))
          );
        })
        .catch(() => {
          if (!cancelled) setVideoInputs([]);
        });
    };
    refresh();
    media.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      media.removeEventListener?.("devicechange", refresh);
    };
  }, [open]);

  // Where the persisted pick lands in the live list right now: exact id,
  // else label (ids rotate), else it is disconnected and the select shows it
  // as such instead of silently pretending Automatic.
  const selectableCameras = listSelectableCameras(videoInputs ?? []);
  const cameraResolution = resolveCameraDevice(cameraPreference, videoInputs ?? []);
  const pickedDevice =
    cameraPreference && cameraResolution.source === "preference" ? cameraResolution.device : null;
  const cameraValue = !cameraPreference ? "" : pickedDevice?.deviceId ?? DISCONNECTED_CAMERA;
  // Inputs exist but none is selectable: labels are empty until the first
  // capture permission (web), or only the Capturia camera is present.
  const camerasHidden = videoInputs !== null && videoInputs.length > 0 && selectableCameras.length === 0;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async (provider: KeyProvider) => {
    const key = drafts[provider]?.trim();
    if (!key) return;
    setBusy(provider);
    setError(null);
    try {
      await save(provider, key);
      setDrafts((d) => ({ ...d, [provider]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async (provider: KeyProvider) => {
    setBusy(provider);
    setError(null);
    try {
      await clear(provider);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-center justify-center p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl bg-black/85 border border-white/15 rounded-2xl shadow-[0_0_80px_rgba(0,0,0,0.8)] overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-white text-sm font-mono uppercase tracking-[0.2em]">
            Settings
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-white/40 hover:text-white text-2xl leading-none transition-colors"
          >
            ×
          </button>
        </div>

        <div className="px-6 py-5">
          <div className="mb-1.5 text-white/40 text-[10px] font-mono uppercase tracking-[0.2em]">
            Model Access
          </div>
          <p className="text-white/50 text-xs mb-5 leading-relaxed">
            Bring your own LLM keys (BYOK). Stored locally and encrypted via OS Keychain. Your keys go only to the model provider you pick, never anywhere else.
          </p>

          {isReady && keys.some((k) => k.has) && (
            <div className="mb-5">
              <div className="mb-2 text-white/40 text-[10px] font-mono uppercase tracking-[0.2em]">
                Active model
              </div>
              <div className="flex gap-2">
                {PROVIDER_ORDER.map((provider) => {
                  const has = keys.find((k) => k.provider === provider)?.has ?? false;
                  const isActive = activeProvider === provider;
                  return (
                    <button
                      key={provider}
                      onClick={() => has && onSelectProvider(provider)}
                      disabled={!has}
                      className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                        isActive
                          ? "bg-white/15 border-white/40 text-white"
                          : has
                          ? "bg-white/5 border-white/10 text-white/60 hover:bg-white/10 hover:text-white"
                          : "bg-white/[0.02] border-white/5 text-white/25 cursor-not-allowed"
                      }`}
                      title={has ? `Use ${PROVIDER_META[provider].name}` : "Add a key first"}
                    >
                      {PROVIDER_META[provider].name.split(" ").pop()}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-white/40 text-[11px] leading-relaxed">
                Capturia runs every command on this key. Your key, your bill, on your machine.
              </p>
            </div>
          )}

          {!isReady && (
            <div className="text-white/40 text-xs font-mono">Loading…</div>
          )}

          {isReady &&
            PROVIDER_ORDER.map((provider) => {
              const meta = PROVIDER_META[provider];
              const entry = keys.find((k) => k.provider === provider);
              const has = entry?.has ?? false;
              const mask = entry?.mask ?? null;
              const draft = drafts[provider] ?? "";
              const isBusy = busy === provider;

              return (
                <div key={provider} className="mb-4 last:mb-0">
                  <div className="flex items-baseline justify-between mb-1.5">
                    <span className="text-white text-sm font-medium">
                      {meta.name}
                    </span>
                    <a
                      href={meta.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-white/30 hover:text-white/70 text-[10px] font-mono tracking-wider"
                    >
                      {meta.tagline} ↗
                    </a>
                  </div>
                  {has ? (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 font-mono text-xs text-white/60">
                        {mask}
                      </div>
                      <button
                        onClick={() => handleClear(provider)}
                        disabled={isBusy}
                        className="text-white/50 hover:text-red-400 text-xs font-mono px-3 py-2 rounded-lg transition-colors disabled:opacity-40"
                      >
                        Clear
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        value={draft}
                        onChange={(e) =>
                          setDrafts((d) => ({ ...d, [provider]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSave(provider);
                        }}
                        placeholder={meta.placeholder}
                        disabled={isBusy}
                        className="flex-1 bg-white/5 border border-white/10 focus:border-white/30 rounded-lg px-3 py-2 font-mono text-xs text-white outline-none placeholder:text-white/20 transition-colors"
                      />
                      <button
                        onClick={() => handleSave(provider)}
                        disabled={!draft.trim() || isBusy}
                        className="bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors"
                      >
                        {isBusy ? "Saving…" : "Save"}
                      </button>
                    </div>
                  )}
                  {meta.note && (
                    <p className="mt-1.5 text-white/35 text-[11px] leading-relaxed">
                      {meta.note}
                    </p>
                  )}
                </div>
              );
            })}

          {error && (
            <div className="mt-4 bg-red-950/50 border border-red-500/30 rounded-lg px-3 py-2 text-red-400 text-xs font-mono">
              {error}
            </div>
          )}

          <div className="mt-6 pt-5 border-t border-white/10">
            <div className="mb-1.5 text-white/40 text-[10px] font-mono uppercase tracking-[0.2em]">
              Voice
            </div>
            <div className="flex items-center justify-between gap-4">
              <p className="text-white/50 text-xs leading-relaxed">
                The language Capturia listens in. Switching applies
                immediately, even mid-session, and the agent writes overlay
                text in the same language.
              </p>
              <select
                value={voiceLocale}
                onChange={(e) => onSelectVoiceLocale(e.target.value)}
                aria-label="Voice recognition language"
                className="shrink-0 bg-white/5 border border-white/10 focus:border-white/30 rounded-lg px-3 py-2 text-xs text-white outline-none transition-colors"
              >
                {VOICE_LOCALES.map((l) => (
                  <option
                    key={l.tag}
                    value={l.tag}
                    disabled={englishOnly && l.tag !== DEFAULT_VOICE_LOCALE}
                    className="bg-neutral-900 text-white"
                  >
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
            {englishOnly && (
              <p className="mt-1.5 text-white/35 text-[11px] leading-relaxed">
                This Mac transcribes with a local English-only Whisper model
                (streaming multilingual speech needs macOS 26), so other
                languages are disabled here.
              </p>
            )}
          </div>

          <div className="mt-6 pt-5 border-t border-white/10">
            <div className="mb-1.5 text-white/40 text-[10px] font-mono uppercase tracking-[0.2em]">
              Camera
            </div>
            <div className="flex items-center justify-between gap-4">
              <p className="text-white/50 text-xs leading-relaxed">
                The camera on your stage and published feed. Switching applies
                immediately; Automatic prefers your built-in camera.
              </p>
              {selectableCameras.length > 0 ? (
                <select
                  value={cameraValue}
                  onChange={(e) => {
                    const device = selectableCameras.find((d) => d.deviceId === e.target.value);
                    onSelectCamera(
                      device ? { deviceId: device.deviceId, label: device.label } : null
                    );
                  }}
                  aria-label="Camera"
                  className="shrink-0 max-w-[13rem] bg-white/5 border border-white/10 focus:border-white/30 rounded-lg px-3 py-2 text-xs text-white outline-none transition-colors"
                >
                  <option value="" className="bg-neutral-900 text-white">
                    Automatic
                  </option>
                  {cameraPreference && cameraValue === DISCONNECTED_CAMERA && (
                    <option value={DISCONNECTED_CAMERA} disabled className="bg-neutral-900 text-white">
                      {cameraPreference.label} (not connected)
                    </option>
                  )}
                  {selectableCameras.map((d) => (
                    <option key={d.deviceId} value={d.deviceId} className="bg-neutral-900 text-white">
                      {d.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="shrink-0 text-white/35 text-[11px] font-mono">
                  {videoInputs === null
                    ? "Detecting…"
                    : camerasHidden
                    ? "Awaiting permission"
                    : "No camera found"}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-white/35 text-[11px] leading-relaxed">
              The Capturia virtual camera is never listed here: capturing it
              would feed the camera its own output (a feedback loop).
            </p>
            {camerasHidden && (
              <p className="mt-1.5 text-white/35 text-[11px] leading-relaxed">
                Camera names appear once a camera permission exists. Use Go on
                camera on the stage, then come back.
              </p>
            )}
          </div>

        </div>

        <div className="px-6 py-3 border-t border-white/10 text-white/30 text-[10px] font-mono">
          Esc to close. Cmd+, to reopen. Commands run on your selected key.
        </div>
      </div>
    </div>
  );
}
