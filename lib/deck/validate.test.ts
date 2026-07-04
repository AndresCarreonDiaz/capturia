import { describe, it, expect } from "vitest";
import { validateSpec } from "@/lib/deck/validate";

// Deck cards are author-controlled but still untrusted input; validateSpec is
// the gate between a parsed deck and React state.

describe("validateSpec", () => {
  it("accepts a valid spec and defaults an invalid position to top-left", () => {
    const out = validateSpec({
      id: "b1",
      type: "LiveBadge",
      position: "under-the-sofa",
      props: { label: "Q4" },
    });
    expect(out).not.toBeNull();
    expect(out!.type).toBe("LiveBadge");
    expect((out as { position?: string }).position).toBe("top-left");
  });

  it("rejects unknown types", () => {
    expect(validateSpec({ id: "x", type: "Marquee", props: {} })).toBeNull();
  });

  it("rejects surface-only types (ActionButton can't ride in via a deck cue)", () => {
    expect(
      validateSpec({
        id: "x",
        type: "ActionButton",
        position: "bottom-center",
        props: { label: "Tap", actionName: "go" },
      })
    ).toBeNull();
  });

  it("rejects a spec whose props fail the shared Zod schema", () => {
    expect(
      validateSpec({ id: "x", type: "StatRing", props: { value: "NaN-ish", label: "z" } })
    ).toBeNull();
  });
});
