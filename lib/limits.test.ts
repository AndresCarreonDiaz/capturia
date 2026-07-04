import { describe, it, expect, vi, afterEach } from "vitest";
import { MAX_TOOL_JSON, oversizedToolArg } from "@/lib/limits";

// The size cap is the first line of defense on every tool handler in the
// studio; an off-by-one or a type slip here silently uncaps agent payloads.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("oversizedToolArg", () => {
  it("accepts a string exactly at the cap", () => {
    expect(oversizedToolArg("x".repeat(MAX_TOOL_JSON))).toBe(false);
  });

  it("rejects (and warns) one char over the cap", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(oversizedToolArg("x".repeat(MAX_TOOL_JSON + 1))).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("passes non-string values through (callers stringify pre-parsed args)", () => {
    expect(oversizedToolArg(undefined)).toBe(false);
    expect(oversizedToolArg(null)).toBe(false);
    expect(oversizedToolArg(123)).toBe(false);
  });
});
