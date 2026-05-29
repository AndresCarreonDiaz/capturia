"use client";
import { useEffect, useState } from "react";
import type { KeyEntry, KeyProvider } from "@/hooks/useDesktopHotkey";

interface Props {
  open: boolean;
  onClose: () => void;
  keys: KeyEntry[];
  isReady: boolean;
  save: (provider: KeyProvider, key: string) => Promise<void>;
  clear: (provider: KeyProvider) => Promise<void>;
  activeProvider: KeyProvider;
  onSelectProvider: (provider: KeyProvider) => void;
}

const PROVIDER_META: Record<
  KeyProvider,
  { name: string; tagline: string; url: string; placeholder: string }
> = {
  gemini: {
    name: "Google Gemini",
    tagline: "aistudio.google.com",
    url: "https://aistudio.google.com",
    placeholder: "AIza... or your Google AI Studio key",
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
}: Props) {
  const [drafts, setDrafts] = useState<Partial<Record<KeyProvider, string>>>({});
  const [busy, setBusy] = useState<KeyProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

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
            BYOK API Keys
          </div>
          <p className="text-white/50 text-xs mb-5 leading-relaxed">
            Bring your own LLM keys. Stored locally and encrypted via OS Keychain. Never sent to a Capturia server.
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
                </div>
              );
            })}

          {error && (
            <div className="mt-4 bg-red-950/50 border border-red-500/30 rounded-lg px-3 py-2 text-red-400 text-xs font-mono">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-white/10 text-white/30 text-[10px] font-mono">
          Esc to close. Cmd+, to reopen. Commands run on your selected key.
        </div>
      </div>
    </div>
  );
}
