import { describe, it, expect } from "vitest";
import {
  extractJsonArray,
  coerceRecordArg,
  coerceArrayArg,
  toolArgText,
} from "@/lib/extract-json";

// Small models wrap their JSON in code fences or prose; extractJsonArray must
// recover the array from those cases and return [] (never throw) on anything
// unparseable. Callers treat [] as "no input".

describe("extractJsonArray", () => {
  it("parses a bare JSON array", () => {
    expect(extractJsonArray("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("recovers an array from a ```json fenced block", () => {
    expect(extractJsonArray('```json\n[{"a": 1}]\n```')).toEqual([{ a: 1 }]);
  });

  it("recovers an array from an untagged ``` fenced block", () => {
    expect(extractJsonArray("```\n[true, false]\n```")).toEqual([true, false]);
  });

  it("recovers an array wrapped in prose", () => {
    expect(extractJsonArray("Sure! Here you go: [1, 2] — enjoy.")).toEqual([1, 2]);
  });

  it("finds the balanced span of a nested array in prose", () => {
    expect(extractJsonArray("noise [ [1], [2] ] more noise")).toEqual([[1], [2]]);
  });

  it("returns [] for prose with no array", () => {
    expect(extractJsonArray("there is no json here")).toEqual([]);
  });

  it("returns [] for a JSON object (not an array)", () => {
    expect(extractJsonArray('{"a": 1}')).toEqual([]);
  });

  it("returns [] for malformed JSON inside brackets", () => {
    expect(extractJsonArray("[1, 2,")).toEqual([]);
    expect(extractJsonArray("[oops not json]")).toEqual([]);
  });

  it("returns [] for empty / whitespace / non-string-ish input", () => {
    expect(extractJsonArray("")).toEqual([]);
    expect(extractJsonArray("   ")).toEqual([]);
    expect(extractJsonArray(undefined as unknown as string)).toEqual([]);
  });

  it("skips bracket-bearing prose before the payload (markdown links)", () => {
    expect(extractJsonArray("[See the slides](https://x.test) and here: [1, 2]")).toEqual([1, 2]);
    expect(extractJsonArray("ok [sic] then [\"a\"] done")).toEqual(["a"]);
  });

  it("prefers the ```json-tagged fence over an earlier untagged one", () => {
    const reply = "```\nthinking about [stuff]\n```\n```json\n[{\"a\":1}]\n```";
    expect(extractJsonArray(reply)).toEqual([{ a: 1 }]);
  });

  it("falls past an explanation fence to a later parseable fence", () => {
    const reply = "```\nno json here\n```\nresult:\n```\n[3, 4]\n```";
    expect(extractJsonArray(reply)).toEqual([3, 4]);
  });

  it("recovers from an unclosed fence", () => {
    expect(extractJsonArray("```json\n[5, 6]")).toEqual([5, 6]);
  });

  it("ignores brackets inside JSON strings while scanning", () => {
    expect(extractJsonArray('text [\"a]b\", \"c\"] after')).toEqual(["a]b", "c"]);
  });

  it("prefers the real payload over a smaller example array earlier in the prose", () => {
    // Models often echo a tiny format example before the real payload. Returning
    // the first-found array would ship the example; the payload has more content.
    const reply = 'Use this shape: [{"t":"x"}] then the cues: [{"a":1},{"b":2},{"c":3}]';
    expect(extractJsonArray(reply)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});

describe("tool-arg coercers", () => {
  it("coerceRecordArg accepts pre-parsed objects (Gemini's structured-args style)", () => {
    expect(coerceRecordArg({ progress: 73 })).toEqual({ progress: 73 });
    expect(coerceRecordArg('{"progress": 73}')).toEqual({ progress: 73 });
  });

  it("coerceRecordArg rejects arrays, scalars, and unparseable strings", () => {
    expect(coerceRecordArg([1, 2])).toBeNull();
    expect(coerceRecordArg(42)).toBeNull();
    expect(coerceRecordArg(null)).toBeNull();
    expect(coerceRecordArg("not json")).toBeNull();
    expect(coerceRecordArg('"a string"')).toBeNull();
  });

  it("coerceArrayArg accepts pre-parsed arrays, JSON strings, and fenced replies", () => {
    expect(coerceArrayArg([1, 2])).toEqual([1, 2]);
    expect(coerceArrayArg("[1, 2]")).toEqual([1, 2]);
    expect(coerceArrayArg("```json\n[3]\n```")).toEqual([3]);
    expect(coerceArrayArg({ nope: true })).toEqual([]);
    expect(coerceArrayArg(7)).toEqual([]);
  });

  it("toolArgText gives the size-cappable text of either shape", () => {
    expect(toolArgText("abc")).toBe("abc");
    expect(toolArgText({ a: 1 })).toBe('{"a":1}');
    expect(toolArgText(undefined)).toBe("");
  });
});
