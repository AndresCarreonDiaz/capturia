// Pure record building and size-cap decisions for the desktop crash log
// (electron/crash-log.js): one JSON record per line, newest last. The log is
// the only crash visibility the packaged app has (no third-party crash
// service without consent, issue #51), so the one-line guarantee and the
// truncation-keeps-newest rule are contracts, not detail. Framework-free so
// vitest pins them; Electron main consumes the CJS build in electron/gen/
// and owns the actual file I/O under app.getPath("logs").

export interface CrashRecordInput {
  /** Which failure path wrote this: "runtime-server", "renderer", "main", ... */
  source: string;
  reason: string;
  detail?: string | null;
  appVersion: string;
  /** Epoch ms; the caller passes Date.now() so this module stays pure. */
  at: number;
}

// ~250k chars holds months of one-line records while a crash loop can never
// fill a disk. Measured in characters, not bytes: the records are
// ASCII-dominant JSON, and the file-size check in electron/crash-log.js
// reads bytes, which only ever over-counts, so trimming errs early, the
// safe direction for a cap.
export const CRASH_LOG_MAX_CHARS = 250_000;
// A runaway stack trace is evidence, not an archive.
const DETAIL_MAX_CHARS = 2_000;

// One JSON line, trailing newline included so plain appends keep the
// line-per-record shape. JSON.stringify escapes control characters, which is
// what makes multi-line stacks safe to embed.
export function formatCrashRecord({ source, reason, detail, appVersion, at }: CrashRecordInput): string {
  const record: Record<string, string> = {
    at: new Date(Number.isFinite(at) ? at : 0).toISOString(),
    source: String(source),
    reason: String(reason),
    appVersion: String(appVersion),
  };
  const trimmed = detail == null ? "" : String(detail).slice(0, DETAIL_MAX_CHARS);
  if (trimmed) record.detail = trimmed;
  return `${JSON.stringify(record)}\n`;
}

// Trim an oversized log to its newest records. Keeps half the cap (not the
// whole cap) so a full file is not re-trimmed on every append, aligned to a
// record boundary so no partial line ever leads the file; a mid-record cut
// point drops that partial record with the old ones. A single line larger
// than the cap has no boundary to respect and is cut raw.
export function truncateCrashLog(text: string, maxChars: number = CRASH_LOG_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const cut = text.length - Math.floor(maxChars / 2);
  const aligned = text[cut - 1] === "\n" ? cut : text.indexOf("\n", cut) + 1;
  if (aligned === 0) return text.slice(cut);
  return text.slice(aligned);
}
