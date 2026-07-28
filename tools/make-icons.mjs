#!/usr/bin/env node
// Renders the Pull Deck mark to PNG at every size the manifest needs.
// Pure Node: analytic coverage with 4x supersampling, zlib for the IDAT.
// Chromium action icons must be raster, so SVG is not an option here.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersample factor per axis

// --- color -------------------------------------------------------------------
// Accent teal, oklch(58% 0.12 190) and oklch(46% 0.115 193), converted to sRGB
// once and hard-coded so this script needs no color library.
const TEAL_LIGHT = [42, 176, 186];
const TEAL_DARK = [18, 122, 136];
const INK = [252, 254, 254];

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// --- geometry, all in a 0..1 unit square ------------------------------------
// Rounded-square tile holding three bars of decreasing width: reads as
// "a group of tabs" at 16px, which is the only size that really has to work.
const TILE_INSET = 0.055;
const TILE_RADIUS = 0.235;

const BARS = [
  { x: 0.235, y: 0.285, w: 0.53, h: 0.105 },
  { x: 0.235, y: 0.4475, w: 0.395, h: 0.105 },
  { x: 0.235, y: 0.61, w: 0.26, h: 0.105 },
];

/** Signed distance to a rounded rectangle; negative inside. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ox, oy) - r;
}

function sampleTile(x, y) {
  const half = 0.5 - TILE_INSET;
  return sdRoundRect(x, y, 0.5, 0.5, half, half, TILE_RADIUS) <= 0;
}

function sampleBars(x, y) {
  for (const b of BARS) {
    const hw = b.w / 2;
    const hh = b.h / 2;
    const r = Math.min(hh, b.h * 0.5);
    if (sdRoundRect(x, y, b.x + hw, b.y + hh, hw, hh, r) <= 0) return true;
  }
  return false;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SS);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tileHits = 0;
      let barHits = 0;
      let gradAccum = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * step;
          const y = (py * SS + sy + 0.5) * step;
          if (!sampleTile(x, y)) continue;
          tileHits++;
          gradAccum += (x + y) / 2;
          if (sampleBars(x, y)) barHits++;
        }
      }

      const total = SS * SS;
      const i = (py * size + px) * 4;
      if (tileHits === 0) continue;

      const tileAlpha = tileHits / total;
      const barRatio = barHits / tileHits;
      // Diagonal gradient across the tile: light top-left to deep bottom-right.
      const t = Math.min(1, Math.max(0, gradAccum / tileHits));
      const tile = mix(TEAL_LIGHT, TEAL_DARK, t);
      const color = mix(tile, INK, barRatio);

      rgba[i] = Math.round(color[0]);
      rgba[i + 1] = Math.round(color[1]);
      rgba[i + 2] = Math.round(color[2]);
      rgba[i + 3] = Math.round(tileAlpha * 255);
    }
  }
  return rgba;
}

// --- PNG encoding ------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = resolve(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
