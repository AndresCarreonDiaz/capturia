import { describe, it, expect } from "vitest";
import { catalogDefinitions, isPlaceableOverlayType, SURFACE_ONLY_TYPES } from "@/lib/catalog";

// ActionButton lives in catalogDefinitions (the render_surface sanitizer needs
// its schema) but must never become a standalone overlay; these tests pin the
// placement boundary every tool handler relies on.

describe("isPlaceableOverlayType", () => {
  it("accepts every catalog type except the surface-only ones", () => {
    for (const type of Object.keys(catalogDefinitions)) {
      expect(isPlaceableOverlayType(type)).toBe(!SURFACE_ONLY_TYPES.has(type));
    }
  });

  it("rejects ActionButton (dead button outside the interactive surface host)", () => {
    expect(isPlaceableOverlayType("ActionButton")).toBe(false);
  });

  it("rejects unknown types and Surface", () => {
    expect(isPlaceableOverlayType("Surface")).toBe(false);
    expect(isPlaceableOverlayType("Card")).toBe(false);
    expect(isPlaceableOverlayType("")).toBe(false);
  });

  it("ActionButton's schema requires a non-empty actionName", () => {
    const schema = catalogDefinitions.ActionButton.props;
    expect(schema.safeParse({ label: "Yes", actionName: "poll-yes" }).success).toBe(true);
    expect(schema.safeParse({ label: "Yes", actionName: "" }).success).toBe(false);
    expect(schema.safeParse({ label: "Yes" }).success).toBe(false);
  });
});
