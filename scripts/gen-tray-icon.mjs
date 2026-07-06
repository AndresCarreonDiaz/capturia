// Generates the menu-bar tray icon: electron/assets/trayTemplate.png (16x16)
// and trayTemplate@2x.png (32x32). A macOS template image is pure black with
// alpha; the OS recolors it for light/dark menu bars and selection, so we only
// draw coverage. The glyph is a video-camera body plus lens wedge, rendered
// with 4x4 supersampling per pixel so the curves stay smooth at 16px.
//
// Checked-in PNGs are the build input; re-run this script only to change the
// glyph:  node scripts/gen-tray-icon.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "electron", "assets");

// --- glyph geometry, in 16x16 icon space -----------------------------------

// Signed test: is point (x, y) inside the rounded-rect camera body?
function inBody(x, y) {
  const cx = 5.75, cy = 8, hw = 4.75, hh = 4, r = 1.8;
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const dx = Math.max(qx, 0), dy = Math.max(qy, 0);
  return Math.hypot(dx, dy) + Math.min(Math.max(qx, qy), 0) - r <= 0;
}

// Lens wedge: a right-facing trapezoid attached to the body.
const WEDGE = [
  [10.9, 6.7],
  [15.0, 4.4],
  [15.0, 11.6],
  [10.9, 9.3],
];

function inWedge(x, y) {
  // Ray-casting point-in-polygon.
  let inside = false;
  for (let i = 0, j = WEDGE.length - 1; i < WEDGE.length; j = i++) {
    const [xi, yi] = WEDGE[i];
    const [xj, yj] = WEDGE[j];
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

// --- PNG encoding (RGBA8, no deps) ------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, alphaAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines: filter byte 0 + RGBA pixels (black + computed alpha)
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4) + 1;
    for (let x = 0; x < size; x++) {
      raw[row + x * 4 + 3] = alphaAt(x, y);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function renderIcon(size) {
  const scale = size / 16;
  const SS = 4; // supersamples per axis
  return encodePng(size, (px, py) => {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / scale;
        const y = (py + (sy + 0.5) / SS) / scale;
        if (inBody(x, y) || inWedge(x, y)) hits++;
      }
    }
    return Math.round((hits / (SS * SS)) * 255);
  });
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "trayTemplate.png"), renderIcon(16));
writeFileSync(join(outDir, "trayTemplate@2x.png"), renderIcon(32));
console.log(`[gen-tray-icon] wrote trayTemplate.png + @2x -> ${outDir}`);
