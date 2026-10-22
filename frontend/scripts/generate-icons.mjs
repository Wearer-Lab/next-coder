#!/usr/bin/env node
// Regenerates the PWA icon set and the social card in frontend/public/icons/.
// Zero dependencies: rasterizes the brand mark by hand and writes PNGs with node:zlib.
//
//   node frontend/scripts/generate-icons.mjs
//
// The mark is the Next Coder prompt caret: a chevron and a cursor bar. Its
// geometry lives in frontend/src/brandMark.json, which the console's <BrandMark>
// component reads as well, so the installed icon and the in-app mark are the
// same shape rather than two drawings that drifted apart.
//
// The set is monochrome: a black ground and a white glyph. Output is
// deterministic — the same input always produces byte-identical PNGs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDir = join(scriptDirectory, "..", "public", "icons");
const mark = JSON.parse(readFileSync(join(scriptDirectory, "..", "src", "brandMark.json"), "utf8"));

const GROUND = [0x00, 0x00, 0x00];
const GLYPH = [0xff, 0xff, 0xff];

/** The mark is authored on a 32 x 32 grid; the viewBox in brandMark.json says so too. */
const MARK_UNITS = 32;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function roundedRect(x, y, rect) {
  const dx = Math.max(rect.x0 - x, x - rect.x1, 0);
  const dy = Math.max(rect.y0 - y, y - rect.y1, 0);
  return Math.hypot(dx, dy) - rect.r;
}

function segment(x, y, ax, ay, bx, by, halfWidth) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = x - ax;
  const wy = y - ay;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / lengthSquared));
  return Math.hypot(wx - vx * t, wy - vy * t) - halfWidth;
}

function over(base, layer, coverage) {
  if (coverage <= 0) return base;
  return [
    base[0] + (layer[0] - base[0]) * coverage,
    base[1] + (layer[1] - base[1]) * coverage,
    base[2] + (layer[2] - base[2]) * coverage,
    base[3] + (1 - base[3]) * coverage,
  ];
}

// Signed-distance coverage with a one-pixel feather, in unit space.
function cover(distance, feather) {
  return Math.min(1, Math.max(0, 0.5 - distance / feather));
}

/**
 * The distance from a point to the mark's strokes, in the mark's own units.
 * The chevron is two segments and the cursor bar is a third, each stroked with
 * a round cap, which is exactly how the SVG in the console draws them.
 */
function markDistance(x, y) {
  const half = mark.strokeWidth / 2;
  const [tip, elbow, heel] = mark.chevron;
  let distance = segment(x, y, tip[0], tip[1], elbow[0], elbow[1], half);
  distance = Math.min(distance, segment(x, y, elbow[0], elbow[1], heel[0], heel[1], half));
  distance = Math.min(distance, segment(x, y, mark.bar[0], mark.bar[1], mark.bar[2], mark.bar[3], half));
  return distance;
}

function sample(u, v, options) {
  const feather = options.feather;
  const scale = options.contentScale;
  // Map into the content box so maskable icons keep their glyph inside the safe zone.
  const x = 0.5 + (u - 0.5) / scale;
  const y = 0.5 + (v - 0.5) / scale;

  let pixel = [0, 0, 0, 0];

  if (options.fullBleed) {
    pixel = over(pixel, GROUND, 1);
  } else {
    const outer = roundedRect(u, v, { x0: 0.06, y0: 0.06, x1: 0.94, y1: 0.94, r: 0.2 });
    pixel = over(pixel, GROUND, cover(outer, feather));
  }

  const glyph = cover(markDistance(x * MARK_UNITS, y * MARK_UNITS) / MARK_UNITS, feather);
  pixel = over(pixel, GLYPH, glyph);

  return pixel;
}

function renderIcon(size, options) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 3;
  const feather = 1.6 / size;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const u = (px + (sx + 0.5) / samples) / size;
          const v = (py + (sy + 0.5) / samples) / size;
          const pixel = sample(u, v, { ...options, feather });
          r += pixel[0] * pixel[3];
          g += pixel[1] * pixel[3];
          b += pixel[2] * pixel[3];
          a += pixel[3];
        }
      }
      const total = samples * samples;
      const alpha = a / total;
      const offset = (py * size + px) * 4;
      rgba[offset] = alpha > 0 ? Math.round(r / a) : 0;
      rgba[offset + 1] = alpha > 0 ? Math.round(g / a) : 0;
      rgba[offset + 2] = alpha > 0 ? Math.round(b / a) : 0;
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

/* The social card ---------------------------------------------------------- */

/*
   The share card is the same mark on the same black ground, with the wordmark
   set in the dot-matrix face the console and the marketing pages use. The face
   is a five-by-seven pixel grid, so the wordmark is drawn as pixels too: no
   font file, no dependency, and the card matches the product exactly.
*/
const PIXEL_FONT = {
  N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function wordmarkWidth(text, unit) {
  return text.length * 6 * unit - unit;
}

function drawMark(rgba, width, height, originX, originY, size) {
  // One output pixel of feather, expressed in the mark's own units.
  const feather = MARK_UNITS / size;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const mx = ((px + 0.5) / size) * MARK_UNITS;
      const my = ((py + 0.5) / size) * MARK_UNITS;
      const coverage = cover(markDistance(mx, my), feather);
      if (coverage <= 0) continue;
      const x = originX + px;
      const y = originY + py;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const offset = (y * width + x) * 4;
      rgba[offset] = Math.round(rgba[offset] + (GLYPH[0] - rgba[offset]) * coverage);
      rgba[offset + 1] = Math.round(rgba[offset + 1] + (GLYPH[1] - rgba[offset + 1]) * coverage);
      rgba[offset + 2] = Math.round(rgba[offset + 2] + (GLYPH[2] - rgba[offset + 2]) * coverage);
    }
  }
}

function drawWordmark(rgba, width, height, text, originX, originY, unit) {
  for (let index = 0; index < text.length; index += 1) {
    const glyph = PIXEL_FONT[text[index]];
    if (!glyph) continue;
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] !== "1") continue;
        const x = originX + (index * 6 + column) * unit;
        const y = originY + row * unit;
        for (let dy = 0; dy < unit; dy += 1) {
          for (let dx = 0; dx < unit; dx += 1) {
            const px = x + dx;
            const py = y + dy;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const offset = (py * width + px) * 4;
            rgba[offset] = GLYPH[0];
            rgba[offset + 1] = GLYPH[1];
            rgba[offset + 2] = GLYPH[2];
          }
        }
      }
    }
  }
}

function renderSocialCard(width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = GROUND[0];
    rgba[index * 4 + 1] = GROUND[1];
    rgba[index * 4 + 2] = GROUND[2];
    rgba[index * 4 + 3] = 255;
  }

  const markSize = Math.round(height * 0.36);
  drawMark(rgba, width, height, Math.round((width - markSize) / 2), Math.round(height * 0.16), markSize);

  const unit = Math.round(height * 0.026);
  const text = "NEXT CODER";
  drawWordmark(
    rgba,
    width,
    height,
    text,
    Math.round((width - wordmarkWidth(text, unit)) / 2),
    Math.round(height * 0.66),
    unit,
  );

  return encodePng(width, height, rgba);
}

const targets = [
  { file: "icon-192.png", size: 192, options: { contentScale: 1, fullBleed: false } },
  { file: "icon-512.png", size: 512, options: { contentScale: 1, fullBleed: false } },
  { file: "icon-maskable-512.png", size: 512, options: { contentScale: 0.72, fullBleed: true } },
  { file: "apple-touch-icon.png", size: 180, options: { contentScale: 0.86, fullBleed: true } },
  { file: "favicon-32.png", size: 32, options: { contentScale: 1, fullBleed: false } },
];

mkdirSync(outputDir, { recursive: true });
for (const target of targets) {
  writeFileSync(join(outputDir, target.file), renderIcon(target.size, target.options));
  process.stdout.write(`wrote ${target.file} (${target.size}x${target.size})\n`);
}

writeFileSync(join(outputDir, "social-card.png"), renderSocialCard(1200, 630));
process.stdout.write("wrote social-card.png (1200x630)\n");
