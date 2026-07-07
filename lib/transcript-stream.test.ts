import { describe, expect, it, vi } from "vitest";
import {
  TranscriptEmitter,
  createSerialQueue,
  isLikelyHallucination,
} from "./transcript-stream";

describe("isLikelyHallucination", () => {
  it("catches whisper's classic noise fillers regardless of punctuation", () => {
    expect(isLikelyHallucination("Thank you.")).toBe(true);
    expect(isLikelyHallucination("THANKS FOR WATCHING!")).toBe(true);
    expect(isLikelyHallucination("[BLANK_AUDIO]")).toBe(true);
    expect(isLikelyHallucination("(applause)")).toBe(true);
    expect(isLikelyHallucination("you")).toBe(true);
  });

  it("never flags real commands, even ones containing filler phrases", () => {
    expect(isLikelyHallucination("show a live counter of 500 viewers")).toBe(false);
    expect(isLikelyHallucination("thank you all for coming, show the poll")).toBe(false);
    expect(isLikelyHallucination("add a timer")).toBe(false);
  });
});

describe("TranscriptEmitter", () => {
  it("delivers events to subscribers and honors unsubscribe", () => {
    const emitter = new TranscriptEmitter();
    const seen: string[] = [];
    const off = emitter.on("final", (text) => seen.push(text));
    emitter.emit("final", "hello");
    off();
    emitter.emit("final", "gone");
    expect(seen).toEqual(["hello"]);
  });

  it("contains a throwing handler so others still run", () => {
    const emitter = new TranscriptEmitter();
    const seen: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    emitter.on("final", () => {
      throw new Error("bad subscriber");
    });
    emitter.on("final", (text) => seen.push(text));
    emitter.emit("final", "still delivered");
    expect(seen).toEqual(["still delivered"]);
    errSpy.mockRestore();
  });

  it("clear removes every subscriber", () => {
    const emitter = new TranscriptEmitter();
    const seen: string[] = [];
    emitter.on("status", (s) => seen.push(s));
    emitter.clear();
    emitter.emit("status", "idle");
    expect(seen).toEqual([]);
  });
});

describe("createSerialQueue", () => {
  it("runs tasks strictly in order even when later tasks are faster", async () => {
    const queue = createSerialQueue();
    const order: number[] = [];
    const slow = queue(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });
    const fast = queue(async () => {
      order.push(2);
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual([1, 2]);
  });

  it("a rejected task reports the error and does not break the chain", async () => {
    const errors: unknown[] = [];
    const queue = createSerialQueue((err) => errors.push(err));
    const ran: string[] = [];
    await queue(async () => {
      throw new Error("chunk failed");
    });
    await queue(async () => {
      ran.push("after");
    });
    expect(errors).toHaveLength(1);
    expect(ran).toEqual(["after"]);
  });

  it("tracks pending count", async () => {
    const queue = createSerialQueue();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const first = queue(() => gate);
    queue(async () => {});
    expect(queue.pendingCount()).toBe(2);
    release();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.pendingCount()).toBeLessThanOrEqual(1);
  });
});
