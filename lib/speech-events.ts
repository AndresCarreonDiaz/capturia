// NDJSON protocol of the capturia-speech helper (native/capturia-speech).
// Electron main parses helper stdout with these; the shapes are the wire
// contract between the Swift process and the studio's apple-speech engine.
// Compiled to electron/gen for main, unit-tested here.

export type SpeechHelperEvent =
  | { type: "ready"; locale: string }
  | { type: "downloading-model" }
  | { type: "interim"; text: string; atMs: number }
  | { type: "final"; text: string; atMs: number }
  | { type: "error"; message: string }
  | { type: "done"; atMs?: number };

const TYPES = new Set(["ready", "downloading-model", "interim", "final", "error", "done"]);

// One line -> one event; anything malformed returns null (the helper's
// stdout is trusted-ish, but a truncated write must not crash main).
export function parseSpeechEvent(line: string): SpeechHelperEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.type !== "string" || !TYPES.has(e.type)) return null;
  if ((e.type === "interim" || e.type === "final") && typeof e.text !== "string") return null;
  if (e.type === "error" && typeof e.message !== "string") return null;
  if (e.type === "ready" && typeof e.locale !== "string") return null;
  return raw as SpeechHelperEvent;
}

// Stream chunks arrive at arbitrary boundaries; buffer partials and hand
// complete lines to the callback.
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
      newline = buffer.indexOf("\n");
    }
  };
}
