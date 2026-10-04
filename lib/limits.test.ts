import { describe, it, expect, vi, afterEach } from "vitest";
import { MAX_TOOL_JSON, oversizedToolArg, readBodyCapped } from "@/lib/limits";

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

// The body cap guards /api/copilotkit on a public deploy: it has to hold even
// when the sender omits or lies about Content-Length.
describe("readBodyCapped", () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request("http://x/api/copilotkit", { method: "POST", body, headers });
  // A chunked upload: no Content-Length, bytes arrive in pieces.
  const streamed = (...chunks: Uint8Array[]) =>
    new Request("http://x/api/copilotkit", {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          for (const chunk of chunks) c.enqueue(chunk);
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);

  it("returns a body exactly at the cap", async () => {
    expect(await readBodyCapped(post("x".repeat(10)), 10)).toBe("x".repeat(10));
  });

  it("refuses one byte over the cap", async () => {
    expect(await readBodyCapped(post("x".repeat(11)), 10)).toBeNull();
  });

  it("refuses an oversized declared Content-Length without reading", async () => {
    const req = post("tiny", { "content-length": "999" });
    expect(await readBodyCapped(req, 10)).toBeNull();
    expect(req.bodyUsed).toBe(false);
  });

  it("counts a chunked body that declares no length", async () => {
    const six = new Uint8Array(6);
    expect(await readBodyCapped(streamed(six, six), 10)).toBeNull();
  });

  it("counts real bytes when Content-Length understates them", async () => {
    const req = streamed(new Uint8Array(6), new Uint8Array(6));
    req.headers.set("content-length", "2");
    expect(await readBodyCapped(req, 10)).toBeNull();
  });

  it("decodes a multibyte char split across chunks", async () => {
    const bytes = new TextEncoder().encode("é"); // 2 bytes
    expect(await readBodyCapped(streamed(bytes.slice(0, 1), bytes.slice(1)), 10)).toBe("é");
  });

  // Regression: cancelling one branch of a cloned (teed) body only resolves
  // once the other branch cancels too, so awaiting it hung the 413 forever on
  // a chunked upload. An endless stream also proves the read really stops.
  it("returns promptly on an endless chunked body, even from a clone", async () => {
    const endless = new Request("http://x/api/copilotkit", {
      method: "POST",
      body: new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(4)) }),
      duplex: "half",
    } as RequestInit);
    expect(await readBodyCapped(endless.clone(), 10)).toBeNull();
  }, 1_000);

  it("treats a missing body as empty", async () => {
    expect(await readBodyCapped(new Request("http://x", { method: "POST" }), 10)).toBe("");
  });
});
