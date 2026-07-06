import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIN_ACCENT_CONTRAST,
  MIN_QR_CSS_PX,
  MIN_QR_MODULE_PX,
  MIN_TEXT_PX,
  PANEL_RGB,
  QR_QUIET_ZONE_MODULES,
  contrastRatio,
  ensureLegibleAccent,
  parseColor,
  qrDisplaySize,
  relativeLuminance,
} from "./legibility";
import { normalizeProps } from "./normalize";

const contrastOnPanel = (hex: string | undefined) =>
  contrastRatio(relativeLuminance(parseColor(hex)!), relativeLuminance(PANEL_RGB));

describe("parseColor", () => {
  it("parses hex forms", () => {
    expect(parseColor("#22c55e")).toEqual({ r: 0x22, g: 0xc5, b: 0x5e });
    expect(parseColor("#FFF")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("parses rgb() and clamps channels", () => {
    expect(parseColor("rgb(300, 10, 0)")).toEqual({ r: 255, g: 10, b: 0 });
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30 });
  });

  it("parses the named colors the agent reaches for", () => {
    expect(parseColor("cyan")).toEqual({ r: 0, g: 255, b: 255 });
    expect(parseColor("RED")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("rejects gradients, css functions, and non-strings", () => {
    expect(parseColor("linear-gradient(#fff, #000)")).toBeNull();
    expect(parseColor("hsl(200, 50%, 50%)")).toBeNull();
    expect(parseColor("var(--accent)")).toBeNull();
    expect(parseColor(42)).toBeNull();
    expect(parseColor(undefined)).toBeNull();
  });
});

describe("ensureLegibleAccent", () => {
  it("passes bright accents through as canonical hex", () => {
    expect(ensureLegibleAccent("#22d3ee")).toBe("#22d3ee");
    expect(ensureLegibleAccent("cyan")).toBe("#00ffff");
  });

  it("lightens colors that would sink into the dark panel", () => {
    const fixed = ensureLegibleAccent("#111111");
    expect(fixed).toBeDefined();
    expect(contrastOnPanel(fixed)).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
  });

  it("holds the floor for the QUANTIZED color across a sweep of dark inputs", () => {
    // Rounding hex channels after the lift can shave contrast back under the
    // floor; this sweep pins the guarantee on what actually ships. #485348
    // is the empirical worst case that caught the original defect.
    const samples = ["#485348", "#333333", "#0a0a0a", "#402000", "#003040", "#2a0033"];
    for (let r = 0; r < 255; r += 51) {
      for (let g = 0; g < 255; g += 51) {
        samples.push(`rgb(${r}, ${g}, 40)`);
      }
    }
    for (const input of samples) {
      const fixed = ensureLegibleAccent(input);
      expect(fixed).toBeDefined();
      expect(contrastOnPanel(fixed)).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
    }
  });

  it("preserves hue when lifting a dark color", () => {
    const fixed = parseColor(ensureLegibleAccent("#200000"));
    expect(fixed).not.toBeNull();
    // Still red-dominant after the lift.
    expect(fixed!.r).toBeGreaterThan(fixed!.g);
    expect(fixed!.r).toBeGreaterThan(fixed!.b);
  });

  it("returns undefined for unparseable values so component defaults win", () => {
    expect(ensureLegibleAccent("conic-gradient(red, blue)")).toBeUndefined();
    expect(ensureLegibleAccent("")).toBeUndefined();
    expect(ensureLegibleAccent(null)).toBeUndefined();
  });

  it("fixes pure black, the worst case", () => {
    const fixed = ensureLegibleAccent("black");
    expect(fixed).toBeDefined();
    expect(fixed).not.toBe("#000000");
  });
});

describe("qrDisplaySize", () => {
  it("gives every module the minimum on-feed size", () => {
    // Version-10-ish payload: 57 modules per side.
    const size = qrDisplaySize(57);
    expect(size).toBe((57 + 2 * QR_QUIET_ZONE_MODULES) * MIN_QR_MODULE_PX);
  });

  it("keeps a typical vote URL at least as large as the badge that shipped", () => {
    // EC-H for a ~39-char vote URL is 37 modules; the pre-floor badge really
    // rendered at 192 CSS px (~6.2px/module), and this floor must not regress
    // what audiences were actually scanning.
    expect(qrDisplaySize(37)).toBeGreaterThanOrEqual(192);
  });

  it("never renders below the badge floor", () => {
    expect(qrDisplaySize(1)).toBe(MIN_QR_CSS_PX);
  });
});

// The gate as the authoring paths actually use it (lib/normalize.ts).
describe("accent gate in normalizeProps", () => {
  it("lifts a too-dark accent and ships a floor-compliant hex", () => {
    const out = normalizeProps("BigCounter", { value: 5, color: "#333333" });
    expect(typeof out.color).toBe("string");
    expect(contrastOnPanel(out.color as string)).toBeGreaterThanOrEqual(
      MIN_ACCENT_CONTRAST
    );
  });

  it("passes bright accents through canonicalized", () => {
    const out = normalizeProps("ActionButton", { label: "Go", color: "cyan" });
    expect(out.color).toBe("#00ffff");
  });

  it("drops unparseable accents so component defaults win", () => {
    const out = normalizeProps("Ticker", {
      items: ["a"],
      accent: "linear-gradient(red, blue)",
    });
    expect("accent" in out).toBe(false);
  });

  it("keeps KeywordHighlight's documented auto palette mode", () => {
    const out = normalizeProps("KeywordHighlight", { keywords: ["x"], color: "auto" });
    expect(out.color).toBe("auto");
  });

  it("falls back to auto for KeywordHighlight instead of dropping its required color", () => {
    const out = normalizeProps("KeywordHighlight", {
      keywords: ["x"],
      color: "var(--accent)",
    });
    expect(out.color).toBe("auto");
  });
});

// The type-size floor is a source contract: nothing rendered into Program
// Output (the published feed the audience sees after meeting-app compression)
// may use text below MIN_TEXT_PX. Operator chrome (CommandBar, CueDeck,
// SettingsModal...) and the landing site are exempt: they render on the
// host's own screen at native resolution. Tailwind arbitrary-size classes are
// the only way below the design scale (text-xs = 12px is the smallest named
// size), so scanning feed sources for sub-floor bracket sizes enforces the
// floor at test time.
describe("type-size floor in feed-surface sources", () => {
  const componentsDir = join(__dirname, "..", "components");
  // Everything mounted inside Program Output (see the stage layout in
  // app/studio/page.tsx): the webcam base layer, the on-feed QR badge, the
  // overlay hosts (including the A2UI wrapper), and the overlay leaves.
  const files = [
    join(componentsDir, "WebcamFeed.tsx"),
    join(componentsDir, "VoteQRBadge.tsx"),
    join(componentsDir, "OverlayLayer.tsx"),
    join(componentsDir, "A2uiOverlayLayer.tsx"),
    join(componentsDir, "A2uiOverlay.tsx"),
    ...readdirSync(join(componentsDir, "overlays"), { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(tsx|ts)$/.test(e.name))
      .map((e) => join(componentsDir, "overlays", e.name)),
  ];

  it(`no feed surface uses text smaller than ${MIN_TEXT_PX}px`, () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        if (Number(match[1]) < MIN_TEXT_PX) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
