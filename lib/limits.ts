// Cap on any single tool-call JSON string arg. Agent JSON is untrusted, and an
// over-eager (or leaked-key) model could emit a huge payload that stalls the
// reconciler. ~12KB is far above any legitimate scene/surface yet bounds the
// blast radius. (render_surface also bounds node count/depth in the sanitizer.)
export const MAX_TOOL_JSON = 12_000;

export function oversizedToolArg(s: unknown): boolean {
  if (typeof s === "string" && s.length > MAX_TOOL_JSON) {
    console.warn("capturia: tool JSON arg exceeds size cap, ignoring");
    return true;
  }
  return false;
}
