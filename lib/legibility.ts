// Compression-resilient rendering constraints. Meeting apps compress the
// camera channel hard (it is the top technical objection to camera-composited
// UI, per the feature research), so every surface obeys floors that survive
// a 1080p feed being downscaled and re-encoded:
//
// - Type-size floor: nothing on the feed below MIN_TEXT_PX (enforced by a
//   source-scan test over components/overlays).
// - Accent contrast: agent-supplied colors are checked against the dark
//   panel background and lightened (or dropped to the component default)
//   when they would vanish into it.
// - QR resilience: error correction H, a real quiet zone, and a minimum
//   on-feed module size so phones can scan the vote code off a re-encoded
//   stream (an unscannable QR kills the voting flagship).

// Minimum CSS px for any text rendered onto the feed.
export const MIN_TEXT_PX = 12;

// QR: highest error correction (~30% recovery) survives blocky re-encodes.
export const QR_ERROR_CORRECTION = "H" as const;
// Quiet zone in modules around the code (spec asks for 4; we render inside a
// solid white card that extends it, so 2 in-canvas is enough).
export const QR_QUIET_ZONE_MODULES = 2;
// Minimum rendered CSS px per module, the real scannability floor. Calibrated
// against what actually shipped before this module existed: a 192 CSS px badge
// at ~6.2px per module, which was borderline-scannable off a re-encoded feed.
// Zoom/Meet can downscale the feed to 640x360 (a ~3x loss on a 1080p stage),
// so 6px modules keep ~2 real pixels per module at the receiver; 3px would
// halve what already barely worked.
export const MIN_QR_MODULE_PX = 6;
// The badge never renders smaller than this even for tiny payloads.
export const MIN_QR_CSS_PX = 96;

// Backdrop model for accent contrast: the overlay panels are bg-black/70-85
// glass over live video, so the real backdrop depends on the scene behind
// the host. Model it as 70% black over a mid-gray scene (0.3 * 128 per
// channel): the floor then holds from dark rooms through typical exposure.
// A blown-out white wall still degrades any accent (that needs a scrim
// behind accent elements, a possible follow-up), but modeling near-black
// would certify colors that vanish in every ordinary room.
export const PANEL_RGB: Rgb = { r: 38, g: 38, b: 38 };
// WCAG large-text/graphics ratio; overlay accents are large type and shapes.
export const MIN_ACCENT_CONTRAST = 3;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

// Small named-color map: the CSS basic keywords plus the handful the agent
// actually reaches for. Anything else (gradients, hsl(), var()) is treated as
// unparseable and the component's tuned default wins.
const NAMED_COLORS: Record<string, string> = {
  white: "#ffffff",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  black: "#000000",
  red: "#ff0000",
  maroon: "#800000",
  yellow: "#ffff00",
  gold: "#ffd700",
  olive: "#808000",
  lime: "#00ff00",
  green: "#008000",
  emerald: "#10b981",
  aqua: "#00ffff",
  cyan: "#00ffff",
  teal: "#008080",
  blue: "#0000ff",
  navy: "#000080",
  sky: "#38bdf8",
  indigo: "#4f46e5",
  violet: "#8b5cf6",
  purple: "#800080",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  pink: "#ec4899",
  rose: "#f43f5e",
  orange: "#f97316",
  amber: "#f59e0b",
  coral: "#ff7f50",
  crimson: "#dc143c",
};

export function parseColor(value: unknown): Rgb | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  const named = NAMED_COLORS[raw];
  const hex = named ?? raw;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
  if (short) {
    return {
      r: parseInt(short[1] + short[1], 16),
      g: parseInt(short[2] + short[2], 16),
      b: parseInt(short[3] + short[3], 16),
    };
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
  if (long) {
    return {
      r: parseInt(long[1], 16),
      g: parseInt(long[2], 16),
      b: parseInt(long[3], 16),
    };
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]+)?\)$/.exec(raw);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((c) => Math.min(255, Number(c)));
    return { r, g, b };
  }
  return null;
}

export function toHex({ r, g, b }: Rgb): string {
  const h = (c: number) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// WCAG relative luminance.
export function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const PANEL_LUMINANCE = relativeLuminance(PANEL_RGB);

function contrastOnPanel(rgb: Rgb): number {
  return contrastRatio(relativeLuminance(rgb), PANEL_LUMINANCE);
}

// Mix toward white in sRGB by factor t (0..1).
function lighten(rgb: Rgb, t: number): Rgb {
  return {
    r: rgb.r + (255 - rgb.r) * t,
    g: rgb.g + (255 - rgb.g) * t,
    b: rgb.b + (255 - rgb.b) * t,
  };
}

function roundRgb({ r, g, b }: Rgb): Rgb {
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

// Make an agent-supplied accent color legible on the feed's dark panels.
// Returns a canonical hex the components can trust, or undefined when the
// value is not a color we can reason about (the caller then drops the prop so
// the component's tuned default applies). Colors that would sink into the
// panel are lightened just enough to clear MIN_ACCENT_CONTRAST, preserving
// hue: "darken until dramatic" is a classic model move that dies on video.
export function ensureLegibleAccent(value: unknown): string | undefined {
  const rgb = parseColor(value);
  if (!rgb) return undefined;
  if (contrastOnPanel(rgb) >= MIN_ACCENT_CONTRAST) return toHex(rgb);
  // Binary-search the smallest lighten factor that clears the floor.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrastOnPanel(lighten(rgb, mid)) >= MIN_ACCENT_CONTRAST) hi = mid;
    else lo = mid;
  }
  // The guarantee must hold for the QUANTIZED color that actually ships:
  // rounding each channel can shave up to 0.5 and drop the contrast back
  // under the floor (roughly half of all lifted colors, measured), so nudge
  // the factor up until the rounded result clears. Terminates at white.
  let t = hi;
  let out = roundRgb(lighten(rgb, t));
  while (contrastOnPanel(out) < MIN_ACCENT_CONTRAST && t < 1) {
    t = Math.min(1, t + 1 / 128);
    out = roundRgb(lighten(rgb, t));
  }
  return toHex(out);
}

// On-feed CSS size for a QR with the given module count (per side, without
// quiet zone): every module gets at least MIN_QR_MODULE_PX, never below the
// badge floor. No upper cap: scannability outranks feed real estate, and vote
// URLs are short enough that this stays badge-sized.
export function qrDisplaySize(moduleCount: number): number {
  const modules = moduleCount + 2 * QR_QUIET_ZONE_MODULES;
  return Math.max(MIN_QR_CSS_PX, modules * MIN_QR_MODULE_PX);
}
