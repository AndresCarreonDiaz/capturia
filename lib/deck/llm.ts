import type { KeyProvider } from "@/hooks/useDesktopHotkey";
import type { CueCard, DeckExtract } from "./types";
import { toDeckFacts } from "./cues";
import { buildCodegenPrompt } from "./prompt";
import { validateOrFallback } from "./fallback";
import type { RawSpec } from "./validate";

// Pull the JSON array out of the model's reply, tolerating code fences or
// surrounding prose.
function extractJsonArray(text: string): unknown[] {
  let t = (text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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

// LLM-powered cue generation (desktop only). Builds the prompt, runs it on the
// user's key in the Electron main process, then validates each returned spec
// through the SAME catalog Zod gate the deterministic path uses (with the same
// ChatBubble fallback). Returns null on any failure so the caller can fall back
// to the deterministic builder. Never runs on web (no window.capturia), which
// keeps the free path cost-free.
export async function generateCuesViaLLM(
  extract: DeckExtract,
  provider: KeyProvider
): Promise<CueCard[] | null> {
  if (typeof window === "undefined" || !window.capturia?.generateCues) return null;
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
    return cards.length ? cards : null;
  } catch {
    return null;
  }
}
