// Shared bits for the icon generators (tray template + app icns): the camera
// glyph geometry in a 16x16 design space, supersampled coverage, and a
// dependency-free RGBA PNG encoder.

import { deflateSync } from "node:zlib";

// --- camera glyph, in 16x16 design space -------------------------------------

// Rounded-rect camera body.
export function inBody(x, y) {
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

export function inWedge(x, y) {
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

export function inGlyph(x, y) {
  return inBody(x, y) || inWedge(x, y);
}

// Fraction (0..1) of an SS x SS supersample grid inside `test`, for the pixel
// at (px, py). Coordinates handed to `test` are divided by `scale`, so a test
// authored in 16x16 design space works at any raster size.
export function coverage(px, py, scale, test, SS = 4) {
  let hits = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      if (test((px + (sx + 0.5) / SS) / scale, (py + (sy + 0.5) / SS) / scale)) hits++;
    }
  }
  return hits / (SS * SS);
}

// Signed containment for a rounded rect given explicitly (used by the app
// icon's background tile, which is not in glyph space).
export function inRoundedRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const dx = Math.max(qx, 0), dy = Math.max(qy, 0);
  return Math.hypot(dx, dy) + Math.min(Math.max(qx, qy), 0) - r <= 0;
}

// --- PNG encoding (RGBA8, no deps) --------------------------------------------

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

// pixelAt(x, y) must return [r, g, b, a], each 0..255.
export function encodePng(size, pixelAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines: filter byte 0 + RGBA pixels
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4) + 1;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      raw[row + x * 4] = r;
      raw[row + x * 4 + 1] = g;
      raw[row + x * 4 + 2] = b;
      raw[row + x * 4 + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
