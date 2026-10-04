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

// Ceiling on one agent reply. maxSteps is 1, so a reply is a single burst of
// tool calls: 8K tokens fits two MAX_TOOL_JSON-sized args (~4K tokens each),
// and anything longer carries an arg the client would drop anyway. Bounds what
// one request can spend on a public deploy's operator key. Reasoning models
// count thinking against it too, so a CAPTURIA_MODEL pinned to one may need
// more headroom; the provider defaults (lib/server-keys.ts) don't think.
export const MAX_OUTPUT_TOKENS = 8_192;

// Cap on one /api/copilotkit request body. The client resends the whole
// thread every turn, so this must clear a long live session (a voice turn plus
// its tool calls is a few KB, so ~1MB is hundreds of turns) while stopping a
// single request from buffering an arbitrary payload or shipping it to the
// model as billed input.
export const MAX_RUNTIME_BODY_BYTES = 1_000_000;

// Reads a body as text, or null when it exceeds maxBytes. Content-Length is
// checked first so an honest oversized upload is refused unread, then the
// stream is counted anyway: a chunked or lying sender can't be trusted to
// declare its size. Consumes the body.
export async function readBodyCapped(
  request: Request,
  maxBytes: number
): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Not awaited: on a cloned body the cancel only settles once the other
      // branch cancels too, which would stall the 413 indefinitely.
      reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
