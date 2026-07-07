import { describe, expect, it } from "vitest";
import { createLineSplitter, parseSpeechEvent } from "./speech-events";

describe("parseSpeechEvent", () => {
  it("parses every protocol event", () => {
    expect(parseSpeechEvent('{"type":"ready","locale":"en_US"}')).toEqual({
      type: "ready",
      locale: "en_US",
    });
    expect(parseSpeechEvent('{"type":"interim","text":"show a","atMs":120}')).toEqual({
      type: "interim",
      text: "show a",
      atMs: 120,
    });
    expect(parseSpeechEvent('{"type":"final","text":"Show a poll.","atMs":900}')).toEqual({
      type: "final",
      text: "Show a poll.",
      atMs: 900,
    });
    expect(parseSpeechEvent('{"type":"done"}')).toEqual({ type: "done" });
    expect(parseSpeechEvent('{"type":"downloading-model"}')).toEqual({
      type: "downloading-model",
    });
    expect(parseSpeechEvent('{"type":"error","message":"boom"}')).toEqual({
      type: "error",
      message: "boom",
    });
  });

  it("rejects malformed lines instead of crashing main", () => {
    expect(parseSpeechEvent("not json")).toBeNull();
    expect(parseSpeechEvent('{"type":"interim"}')).toBeNull(); // no text
    expect(parseSpeechEvent('{"type":"warp"}')).toBeNull();
    expect(parseSpeechEvent('{"type":"error"}')).toBeNull();
    expect(parseSpeechEvent("42")).toBeNull();
  });
});

describe("createLineSplitter", () => {
  it("reassembles lines across arbitrary chunk boundaries", () => {
    const lines: string[] = [];
    const feed = createLineSplitter((l) => lines.push(l));
    feed('{"type":"rea');
    feed('dy","locale":"en_US"}\n{"type":"inter');
    feed('im","text":"hi","atMs":1}\n');
    expect(lines).toEqual([
      '{"type":"ready","locale":"en_US"}',
      '{"type":"interim","text":"hi","atMs":1}',
    ]);
  });

  it("handles several lines in one chunk and skips blanks", () => {
    const lines: string[] = [];
    const feed = createLineSplitter((l) => lines.push(l));
    feed('{"a":1}\n\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});
