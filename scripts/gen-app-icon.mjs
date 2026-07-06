// Generates the macOS app icon: build/icon.iconset/* then build/icon.icns via
// iconutil (macOS only). The design is the shared camera glyph in white,
// centered on a dark rounded-rect tile with the standard Big Sur margins
// (tile spans ~80% of the canvas). Re-run only to change the artwork:
//   node scripts/gen-app-icon.mjs
// The checked-in build/icon.icns is what electron-builder consumes.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { coverage, encodePng, inGlyph, inRoundedRect } from "./icon-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const iconsetDir = join(buildDir, "icon.iconset");

// Vertical gradient for the tile, deep slate to near-black.
const TOP = [0x26, 0x26, 0x3a];
const BOTTOM = [0x0e, 0x0e, 0x18];

function renderAppIcon(size) {
  // Tile: 80% of the canvas, squircle-ish corner radius (Apple uses ~22.5%).
  const tileHalf = size * 0.4;
  const tileRadius = tileHalf * 2 * 0.225;
  const c = size / 2;
  // Glyph: 62% of the tile width, centered. The glyph's design space is 16
  // units wide, so scale accordingly and offset to center.
  const glyphScale = (tileHalf * 2 * 0.62) / 16;
  const glyphOffset = c - 8 * glyphScale;

  return encodePng(size, (px, py) => {
    const tileCov = coverage(px, py, 1, (x, y) =>
      inRoundedRect(x, y, c, c, tileHalf, tileHalf, tileRadius)
    );
    if (tileCov === 0) return [0, 0, 0, 0];
    const t = py / size;
    const bg = TOP.map((ch, i) => Math.round(ch + (BOTTOM[i] - ch) * t));
    const glyphCov = coverage(px - glyphOffset, py - glyphOffset, glyphScale, inGlyph);
    const px3 = bg.map((ch) => Math.round(ch + (255 - ch) * glyphCov));
    return [px3[0], px3[1], px3[2], Math.round(tileCov * 255)];
  });
}

// iconutil's required member sizes: name -> pixel size.
const MEMBERS = {
  "icon_16x16.png": 16,
  "icon_16x16@2x.png": 32,
  "icon_32x32.png": 32,
  "icon_32x32@2x.png": 64,
  "icon_128x128.png": 128,
  "icon_128x128@2x.png": 256,
  "icon_256x256.png": 256,
  "icon_256x256@2x.png": 512,
  "icon_512x512.png": 512,
  "icon_512x512@2x.png": 1024,
};

rmSync(iconsetDir, { recursive: true, force: true });
mkdirSync(iconsetDir, { recursive: true });
const rendered = new Map();
for (const [name, size] of Object.entries(MEMBERS)) {
  if (!rendered.has(size)) rendered.set(size, renderAppIcon(size));
  writeFileSync(join(iconsetDir, name), rendered.get(size));
}
execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", join(buildDir, "icon.icns")]);
rmSync(iconsetDir, { recursive: true, force: true });
console.log(`[gen-app-icon] wrote ${join(buildDir, "icon.icns")}`);
