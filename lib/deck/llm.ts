import type { KeyProvider } from "@/hooks/useDesktopHotkey";
import type { CueCard, DeckExtract } from "./types";
import { toDeckFacts } from "./cues";
import { buildCodegenPrompt } from "./prompt";
import { validateOrFallback } from "./fallback";
import type { RawSpec } from "./validate";
import { extractJsonArray } from "@/lib/extract-json";
import { classifyHostedExhaustion, hostedExhaustionNotice } from "@/lib/desktop-runtime";
import { ipcErrorMessage } from "@/lib/ipc-error";

function aliasesFrom(item: Record<string, unknown>, label: string): string[] {
  const fromLLM = (Array.isArray(item.aliases) ? item.aliases : []).filter(
    (a): a is string => typeof a === "string"
  );
  const fromLabel = label.toLowerCase().split(/[^a-z0-9]+/);
  return [
    ...new Set(
      [...fromLLM, ...fromLabel]
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.length >= 3)
    ),
  ];
}

export interface LLMCueResult {
  cards: CueCard[] | null;
  /**
   * Calm operator notice when the hosted tier refused the run because an
   * allowance is used up (lib/desktop-runtime.ts markers). null for every
   * other failure: those keep the silent deterministic fallback, but a spent
   * allowance is a plan state the operator deserves to see.
   */
  notice: string | null;
}

// LLM-powered cue generation (desktop only). Builds the prompt, runs it on the
// user's key in the Electron main process, then validates each returned spec
// through the SAME catalog Zod gate the deterministic path uses (with the same
// ChatBubble fallback). cards is null on any failure so the caller can fall
// back to the deterministic builder. Never runs on web (no window.capturia),
// which keeps the free path cost-free.
export async function generateCuesViaLLM(
  extract: DeckExtract,
  provider: KeyProvider
): Promise<LLMCueResult> {
  if (typeof window === "undefined" || !window.capturia?.generateCues) {
    return { cards: null, notice: null };
  }
  try {
    const prompt = buildCodegenPrompt(toDeckFacts(extract));
    const raw = await window.capturia.generateCues(prompt, provider);
    const items = extractJsonArray(raw).slice(0, 12);
    const cards: CueCard[] = [];
    items.forEach((it, i) => {
      if (!it || typeof it !== "object") return;
      const item = it as Record<string, unknown>;
      const type = typeof item.type === "string" ? item.type : "";
      const label =
        (typeof item.label === "string" && item.label.trim()) || type || `Cue ${i + 1}`;
      const position = typeof item.position === "string" ? item.position : undefined;
      const props =
        item.props && typeof item.props === "object"
          ? (item.props as Record<string, unknown>)
          : {};
      const rawSpec: RawSpec = { id: `cue-llm-${i}`, type, position, props };
      const [spec, adapted] = validateOrFallback(rawSpec, label);
      cards.push({
        id: `cue-llm-${i}`,
        label: label.slice(0, 42),
        aliases: aliasesFrom(item, label),
        slideIndex: typeof item.slideIndex === "number" ? item.slideIndex : i,
        specs: [spec],
        adapted,
      });
    });
    return { cards: cards.length ? cards : null, notice: null };
  } catch (err) {
    const exhaustion = classifyHostedExhaustion(ipcErrorMessage(err));
    return { cards: null, notice: exhaustion ? hostedExhaustionNotice(exhaustion) : null };
  }
}
