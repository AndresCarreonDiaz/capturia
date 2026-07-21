"use client";
import { useEffect, useState } from "react";
import type { KeyEntry, KeyProvider } from "@/hooks/useDesktopHotkey";
import { useTelemetry } from "@/hooks/useTelemetry";
import { ipcErrorMessage } from "@/lib/ipc-error";
import type { HostedUsage } from "@/lib/hosted-billing";
import { hoursMeterFraction, hoursMeterLabel } from "@/lib/hosted-hours";

interface Props {
  open: boolean;
  onClose: () => void;
  keys: KeyEntry[];
  isReady: boolean;
  save: (provider: KeyProvider, key: string) => Promise<void>;
  clear: (provider: KeyProvider) => Promise<void>;
  activeProvider: KeyProvider;
  onSelectProvider: (provider: KeyProvider) => void;
  /** Re-pulls the vault list; activation stores tokens in MAIN, so the modal
   *  cannot learn about them from save()'s return value. */
  onRefreshKeys?: () => Promise<void>;
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
  // Hosted tier (M11 slice 2): on a desktop build with the billing bridge,
  // this row renders the guided upgrade (checkout in the browser, paste the
  // activation code back); on web or a stale preload it stays the slice-1
  // paste-a-token input. The note keeps the section's "never sent to a
  // Capturia server" promise honest: this row is the one non-BYOK slot and
  // its credentials DO go to Capturia.
  "capturia-hosted": {
    name: "Capturia Pro",
    tagline: "hosted, no API key needed",
    url: "https://www.capturia.dev",
    placeholder: "Paste your Capturia access token",
    note: "Not BYOK: your Capturia Pro credentials are stored encrypted locally and sent to the Capturia hosted proxy with each request to authenticate your plan.",
  },
};

const PROVIDER_ORDER: KeyProvider[] = ["gemini", "claude", "openai", "capturia-hosted"];

export default function SettingsModal({
  open,
  onClose,
  keys,
  isReady,
  save,
  clear,
  activeProvider,
  onSelectProvider,
  onRefreshKeys,
}: Props) {
  const [drafts, setDrafts] = useState<Partial<Record<KeyProvider, string>>>({});
  const [busy, setBusy] = useState<KeyProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Upgrade-flow feedback: "checkout opened" hint and the activate spinner.
  const [billingInfo, setBillingInfo] = useState<string | null>(null);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  // Desktop-only anonymous beacon toggle; unsupported (web, stale preload)
  // hides the whole Privacy section.
  const telemetry = useTelemetry();
  // Guided upgrade needs the desktop billing bridge; without it (web, stale
  // preload) the Pro row keeps the paste-a-token input.
  const billing = typeof window !== "undefined" ? window.capturia?.billing : undefined;
  // Hours meter for an entitled Pro row (issue #10 slice 4). Fetched per
  // open, silently: a meter that cannot load simply does not render, it is
  // never worth an error banner. Keyed on the vault signature so activating
  // or clearing Pro while the modal is open re-reads.
  const [usage, setUsage] = useState<HostedUsage | null>(null);
  const proActive = keys.find((k) => k.provider === "capturia-hosted")?.has ?? false;
  useEffect(() => {
    if (!open || !proActive || !billing?.getUsage) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    billing
      .getUsage()
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch(() => {
        if (!cancelled) setUsage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, proActive, billing]);

  const handleUpgrade = async () => {
    if (!billing) return;
    setUpgradeBusy(true);
    setError(null);
    setBillingInfo(null);
    try {
      await billing.checkout();
      setBillingInfo(
        "Checkout opened in your browser. After paying, copy the activation code from the success page and paste it below."
      );
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setUpgradeBusy(false);
    }
  };

  const handleActivate = async () => {
    const code = drafts["capturia-hosted"]?.trim();
    if (!billing || !code) return;
    setBusy("capturia-hosted");
    setError(null);
    try {
      const res = await billing.activate(code);
      if (res?.ok) {
        setDrafts((d) => ({ ...d, "capturia-hosted": "" }));
        setBillingInfo("Capturia Pro is active on this Mac.");
        await onRefreshKeys?.();
        onSelectProvider("capturia-hosted");
      }
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

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
            Bring your own LLM keys (BYOK). Stored locally and encrypted via OS Keychain. BYOK keys are never sent to a Capturia server; Capturia Pro is the hosted exception, see its row below.
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
                    <div>
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
                      {/* Hours meter (Pro only): the plan is sold in hours,
                          so the meter speaks hours; tokens stay invisible. */}
                      {provider === "capturia-hosted" && usage && (
                        <div className="mt-2">
                          <div
                            className="h-1 rounded-full bg-white/10 overflow-hidden"
                            role="progressbar"
                            aria-label="Included hours used this month"
                          >
                            <div
                              className="h-full rounded-full bg-cyan-400/70 transition-all"
                              style={{
                                width: `${
                                  hoursMeterFraction(usage.tokensUsed, usage.monthlyTokenBudget) *
                                  100
                                }%`,
                              }}
                            />
                          </div>
                          <p className="mt-1.5 text-white/50 text-[11px] leading-relaxed">
                            {hoursMeterLabel(usage.tokensUsed, usage.monthlyTokenBudget)} · resets{" "}
                            {new Date(usage.periodEnd).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            })}
                          </p>
                        </div>
                      )}
                    </div>
                  ) : provider === "capturia-hosted" && billing ? (
                    <div>
                      <button
                        onClick={handleUpgrade}
                        disabled={upgradeBusy || isBusy}
                        className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-medium px-4 py-2.5 rounded-lg transition-colors"
                      >
                        {upgradeBusy ? "Opening checkout…" : "Upgrade to Pro · $19/mo"}
                      </button>
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          type="text"
                          value={draft}
                          onChange={(e) =>
                            setDrafts((d) => ({ ...d, [provider]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleActivate();
                          }}
                          placeholder="CAPTURIA-XXXX-XXXX-XXXX-XXXX"
                          disabled={isBusy}
                          spellCheck={false}
                          className="flex-1 bg-white/5 border border-white/10 focus:border-white/30 rounded-lg px-3 py-2 font-mono text-xs text-white outline-none placeholder:text-white/20 transition-colors uppercase"
                        />
                        <button
                          onClick={handleActivate}
                          disabled={!draft.trim() || isBusy}
                          className="bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors"
                        >
                          {isBusy ? "Activating…" : "Activate"}
                        </button>
                      </div>
                      {billingInfo && (
                        <p className="mt-1.5 text-emerald-300/80 text-[11px] leading-relaxed">
                          {billingInfo}
                        </p>
                      )}
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

          {telemetry.supported && (
            <div className="mt-6 pt-5 border-t border-white/10">
              <div className="mb-1.5 text-white/40 text-[10px] font-mono uppercase tracking-[0.2em]">
                Privacy
              </div>
              <div className="flex items-start justify-between gap-4">
                <p className="text-white/50 text-xs leading-relaxed">
                  Share anonymous usage pings: a random install id plus the app
                  and macOS versions, sent on launch and camera install. Never
                  audio, transcripts, or anything on your feed.
                </p>
                <button
                  role="switch"
                  aria-checked={telemetry.enabled}
                  aria-label="Share anonymous usage pings"
                  onClick={() => telemetry.setEnabled(!telemetry.enabled)}
                  className={`relative shrink-0 mt-0.5 w-9 h-5 rounded-full border transition-colors ${
                    telemetry.enabled
                      ? "bg-cyan-400/30 border-cyan-400/60"
                      : "bg-white/10 border-white/20"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
                      telemetry.enabled ? "left-[18px] bg-cyan-300" : "left-0.5 bg-white/50"
                    }`}
                  />
                </button>
              </div>
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
