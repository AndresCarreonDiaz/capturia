// Generates the menu-bar tray icon: electron/assets/trayTemplate.png (16x16)
// and trayTemplate@2x.png (32x32). A macOS template image is pure black with
// alpha; the OS recolors it for light/dark menu bars and selection, so we only
// draw coverage. Glyph geometry and PNG encoding live in scripts/icon-lib.mjs
// (shared with the app-icon generator).
//
// Checked-in PNGs are the build input; re-run this script only to change the
// glyph:  node scripts/gen-tray-icon.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { coverage, encodePng, inGlyph } from "./icon-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "electron", "assets");

function renderIcon(size) {
  const scale = size / 16;
  return encodePng(size, (px, py) => [
    0,
    0,
    0,
    Math.round(coverage(px, py, scale, inGlyph) * 255),
  ]);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "trayTemplate.png"), renderIcon(16));
writeFileSync(join(outDir, "trayTemplate@2x.png"), renderIcon(32));
console.log(`[gen-tray-icon] wrote trayTemplate.png + @2x -> ${outDir}`);
