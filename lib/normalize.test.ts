import { describe, it, expect } from "vitest";
import { normalizeProps } from "@/lib/normalize";

// normalizeProps is the coercion gate shared by add_overlay, compose_scene, the
// deck validator, and the surface sanitizer. Agent/deck JSON is untrusted and
// loosely shaped, so these tests pin the shapes it must repair without throwing.

describe("normalizeProps: KeywordHighlight", () => {
  it("splits a comma string into a trimmed, non-empty array", () => {
    expect(normalizeProps("KeywordHighlight", { keywords: "ai, growth , , demo" }).keywords).toEqual([
      "ai",
      "growth",
      "demo",
    ]);
  });

  it("flattens object/non-string array entries to strings", () => {
    expect(
      normalizeProps("KeywordHighlight", { keywords: ["a", { text: "b" }, 5] }).keywords
    ).toEqual(["a", "b", "5"]);
  });
});

describe("normalizeProps: FloatingChart", () => {
  it("coerces string/object data points to numbers and drops non-finite values", () => {
    expect(
      normalizeProps("FloatingChart", { data: [1, "2", { value: 3 }, "x"] }).data
    ).toEqual([1, 2, 3]);
  });

  it("leaves non-array data untouched", () => {
    const out = normalizeProps("FloatingChart", { data: "nope" });
    expect(out.data).toBe("nope");
  });

  it("drops null/boolean entries instead of fabricating 0/1 data points", () => {
    expect(
      normalizeProps("FloatingChart", { data: [5, null, true, false, 7] }).data
    ).toEqual([5, 7]);
  });
});

describe("normalizeProps: MetricsPanel", () => {
  it("stringifies numeric values, normalizes delta, and drops label-less rows", () => {
    const out = normalizeProps("MetricsPanel", {
      title: "Q4",
      metrics: [
        { label: "Revenue", value: 1800000, delta: 24 },
        { label: "Churn", value: "2.1%", delta: null },
        { value: "orphan-no-label" },
        "not-an-object",
      ],
    });
    expect(out.metrics).toEqual([
      { label: "Revenue", value: "1800000", delta: "24" },
      { label: "Churn", value: "2.1%", delta: undefined },
    ]);
  });

  it("returns an empty array when metrics is not an array", () => {
    expect(normalizeProps("MetricsPanel", { title: "x", metrics: "bad" }).metrics).toEqual([]);
  });

  it("keeps a value-less row as value: '' (pinned: label-only rows are legal)", () => {
    expect(normalizeProps("MetricsPanel", { metrics: [{ label: "Status" }] }).metrics).toEqual([
      { label: "Status", value: "", delta: undefined },
    ]);
  });
});

describe("normalizeProps: Timeline", () => {
  it("coerces string steps to {label} and parses currentStep", () => {
    const out = normalizeProps("Timeline", {
      steps: ["one", { label: "two" }, { nolabel: true }, 3],
      currentStep: "2",
    });
    expect(out.steps).toEqual([{ label: "one" }, { label: "two" }]);
    expect(out.currentStep).toBe(2);
  });

  it("defaults a non-numeric currentStep to 0", () => {
    expect(normalizeProps("Timeline", { steps: [], currentStep: "abc" }).currentStep).toBe(0);
  });

  it("coerces a literal NaN currentStep to 0 (would fail the Zod gate otherwise)", () => {
    expect(normalizeProps("Timeline", { steps: [], currentStep: NaN }).currentStep).toBe(0);
  });
});

describe("normalizeProps: Ticker", () => {
  it("splits a comma string and flattens object items", () => {
    expect(normalizeProps("Ticker", { items: "a, b ,c" }).items).toEqual(["a", "b", "c"]);
    expect(normalizeProps("Ticker", { items: [{ text: "x" }, "y"] }).items).toEqual(["x", "y"]);
  });

  it("defaults a non-array, non-string items to an empty array", () => {
    expect(normalizeProps("Ticker", { items: 42 }).items).toEqual([]);
  });
});

describe("normalizeProps: passthrough", () => {
  it("returns a shallow copy of props for an unhandled type", () => {
    const props = { name: "Alex", subtitle: "Founder" };
    const out = normalizeProps("LowerThird", props);
    expect(out).toEqual(props);
    expect(out).not.toBe(props);
  });
});
