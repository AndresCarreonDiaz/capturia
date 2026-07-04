import { describe, it, expect } from "vitest";
import { randomToken } from "@/lib/random-id";

// randomToken has to produce ids the vote store will accept, over plain HTTP
// (getRandomValues, never randomUUID), so the format contract is load-bearing.

const KEY_RE = /^[a-z0-9-]{8,64}$/i; // vote-store KEY_RE (host key, viewer id)
const ROOM_ID_RE = /^[a-z0-9]{8,32}$/i; // vote-store ROOM_ID_RE (room slug)

describe("randomToken", () => {
  it("is lowercase base36 of the requested length", () => {
    expect(randomToken(12)).toMatch(/^[0-9a-z]{12}$/);
    expect(randomToken(32)).toHaveLength(32);
    expect(randomToken()).toHaveLength(32); // default
  });

  it("satisfies the vote store's room and key formats", () => {
    expect(ROOM_ID_RE.test(randomToken(12))).toBe(true); // room slug
    expect(KEY_RE.test(randomToken(32))).toBe(true); // host key
    expect(KEY_RE.test(`host-${randomToken(32)}`)).toBe(true); // host viewer id
  });

  it("is effectively unique across calls", () => {
    const seen = new Set(Array.from({ length: 500 }, () => randomToken(16)));
    expect(seen.size).toBe(500);
  });
});
