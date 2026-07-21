// Pins the crash-log contracts (lib/crash-log.ts, consumed by
// electron/crash-log.js via the gen build): every record is exactly one JSON
// line however hostile its inputs, and truncation keeps the NEWEST records on
// a clean line boundary. These shapes are what a support thread reads back,
// so they must not drift.

import { describe, expect, it } from "vitest";
import { CRASH_LOG_MAX_CHARS, formatCrashRecord, truncateCrashLog } from "./crash-log";

const input = (over: Partial<Parameters<typeof formatCrashRecord>[0]> = {}) => ({
  source: "renderer",
  reason: "crashed",
  detail: "exit code 11",
  appVersion: "0.1.1",
  at: Date.parse("2026-07-21T10:00:00.000Z"),
  ...over,
});

describe("formatCrashRecord", () => {
  it("builds one JSON line, newline-terminated, with every field", () => {
    const line = formatCrashRecord(input());
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      at: "2026-07-21T10:00:00.000Z",
      source: "renderer",
      reason: "crashed",
      appVersion: "0.1.1",
      detail: "exit code 11",
    });
  });

  it("stays one line when the detail is a multi-line stack", () => {
    const line = formatCrashRecord(input({ detail: "Error: boom\n  at start\n  at main" }));
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line).detail).toBe("Error: boom\n  at start\n  at main");
  });

  it("omits the detail field when there is none", () => {
    expect(JSON.parse(formatCrashRecord(input({ detail: undefined })))).not.toHaveProperty("detail");
    expect(JSON.parse(formatCrashRecord(input({ detail: null })))).not.toHaveProperty("detail");
    expect(JSON.parse(formatCrashRecord(input({ detail: "" })))).not.toHaveProperty("detail");
  });

  it("caps a runaway detail instead of archiving it", () => {
    const line = formatCrashRecord(input({ detail: "x".repeat(50_000) }));
    expect(JSON.parse(line).detail).toHaveLength(2_000);
  });

  it("survives a non-finite timestamp instead of throwing on a failure path", () => {
    // The whole module runs while something is already broken; a bad clock
    // value must degrade to epoch, never become a second crash.
    expect(JSON.parse(formatCrashRecord(input({ at: NaN }))).at).toBe(
      "1970-01-01T00:00:00.000Z"
    );
  });
});

describe("truncateCrashLog", () => {
  it("returns a log under the cap unchanged", () => {
    const text = "aaaa\nbbbb\n";
    expect(truncateCrashLog(text, 100)).toBe(text);
    expect(truncateCrashLog(text, CRASH_LOG_MAX_CHARS)).toBe(text);
  });

  it("keeps the newest records when oversized", () => {
    const text = "old-1\nold-2\nnew-1\nnew-2\n";
    const kept = truncateCrashLog(text, 12); // keeps ~6 chars of tail
    expect(kept).toBe("new-2\n");
  });

  it("drops a partial record when the cut lands mid-line", () => {
    // 19 chars, cap 16 -> the raw cut starts inside "middle"; the partial
    // record goes with the old ones instead of leading the file.
    const text = "aaaa\nmiddle\nnewest\n";
    const kept = truncateCrashLog(text, 16);
    expect(kept).toBe("newest\n");
  });

  it("keeps only complete lines after any truncation", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `{"n":${i}}`).join("\n") + "\n";
    const kept = truncateCrashLog(lines, 100);
    expect(kept.length).toBeLessThanOrEqual(100);
    for (const line of kept.split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("cuts a single monster line raw rather than keeping it whole", () => {
    const text = "x".repeat(100);
    expect(truncateCrashLog(text, 10)).toBe("x".repeat(5));
  });
});
