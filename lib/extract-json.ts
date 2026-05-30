// Pull a JSON array out of a model's reply, tolerating code fences (```json …```)
// or surrounding prose. Small models often wrap or annotate their JSON; this
// recovers the array so a stray fence doesn't fail an otherwise valid payload.
// Returns [] when nothing parseable is found (callers treat [] as "no input").
export function extractJsonArray(text: string): unknown[] {
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
