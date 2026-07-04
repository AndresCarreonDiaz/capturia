// Pull a JSON array out of a model's reply, tolerating code fences (```json …```)
// and surrounding prose. Small models often wrap or annotate their JSON; this
// recovers the array so a stray fence, an explanation block, or a markdown link
// before the payload doesn't fail an otherwise valid reply.
// Returns [] when nothing parseable is found (callers treat [] as "no input").
export function extractJsonArray(text: string): unknown[] {
  const t = (text || "").trim();
  if (!t) return [];

  // The well-behaved case: the whole reply IS the array.
  const direct = tryParseArray(t);
  if (direct) return direct;

  // Fenced blocks: models often emit an explanation fence BEFORE the payload
  // fence, so scan all of them, ```json-tagged ones first.
  const fences = [...t.matchAll(/```(json)?\s*([\s\S]*?)```/gi)];
  const ordered = [...fences.filter((f) => f[1]), ...fences.filter((f) => !f[1])];
  for (const f of ordered) {
    const inner = f[2].trim();
    const arr = tryParseArray(inner) ?? scanForArray(inner);
    if (arr) return arr;
  }

  // Raw prose (also covers an unclosed fence): find the largest parseable
  // top-level array anywhere in the text.
  return scanForArray(t) ?? [];
}

// Tool-arg coercers. The tool schemas describe JSON-carrying params as strings,
// but Gemini sometimes emits them PRE-PARSED (a nested object/array inside the
// tool-call args), and nothing in the pipeline re-validates against the schema.
// A handler that assumes a string then throws in JSON.parse and silently
// no-ops. These accept both shapes; null/[] means "unusable input".

/** A JSON object arg: already-parsed object, or a JSON string of one. */
export function coerceRecordArg(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A JSON array arg: already-parsed array, or a string (fences/prose tolerated). */
export function coerceArrayArg(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  return extractJsonArray(value);
}

/** The size-cappable text form of a possibly pre-parsed tool arg. */
export function toolArgText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function tryParseArray(s: string): unknown[] | null {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// For each '[' candidate, walk a string-aware bracket-depth counter to its
// matching ']' and try to parse that slice. Unlike a first-[/last-] span,
// this survives bracket-bearing prose around the payload (markdown links,
// "[sic]", emoticons) by simply moving on to the next candidate.
//
// Returns the array with the LARGEST character span, not the first found. A
// model often echoes a tiny format example before the real payload
// ("shape: [{...}] ... cues: [{...},{...},...]"); returning the first would
// silently ship the example. The real payload has the largest span, and the
// outermost of any nested arrays does too, so this also prefers the outer
// array over an inner one. First wins on a span tie (strict >).
function scanForArray(s: string): unknown[] | null {
  let best: unknown[] | null = null;
  let bestSpan = 0;
  for (let start = s.indexOf("["); start !== -1; start = s.indexOf("[", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString) {
        if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) {
          const span = i + 1 - start;
          if (span > bestSpan) {
            const arr = tryParseArray(s.slice(start, i + 1));
            if (arr) {
              best = arr;
              bestSpan = span;
            }
          }
          break; // matched this candidate's close: try the next start candidate
        }
      }
    }
  }
  return best;
}
