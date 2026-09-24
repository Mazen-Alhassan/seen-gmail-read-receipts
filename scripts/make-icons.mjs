// Draws the extension icon (white double check on a blue rounded square) at 16/32/48/128px.
// Pure Node — no image tooling needed. Output: extension/static/icons/icon<size>.png
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

const out = path.join(import.meta.dirname, "..", "extension", "static", "icons");
mkdirSync(out, { recursive: true });

// Geometry in a 0..1 unit square.
const RADIUS = 0.24;
const STROKE = 0.085;
const ticks = [
  [[0.17, 0.53], [0.33, 0.69], [0.62, 0.36]],
  [[0.40, 0.62], [0.47, 0.69], [0.80, 0.36]],
];

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inRoundedSquare(x, y) {
  const cx = Math.min(Math.max(x, RADIUS), 1 - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), 1 - RADIUS);
  return Math.hypot(x - cx, y - cy) <= RADIUS;
}

function onTick(x, y) {
  return ticks.some(([a, b, c]) => distToSegment(x, y, a, b) <= STROKE / 2 || distToSegment(x, y, b, c) <= STROKE / 2);
}

function render(size) {
  const SS = 8; // supersampling per axis
  const px = Buffer.alloc(size * size * 4);
  const top = [26, 115, 232]; // #1a73e8
  const bottom = [11, 87, 208]; // #0b57d0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (!inRoundedSquare(u, v)) continue;
          bg++;
          if (onTick(u, v)) fg++;
        }
      }
      const n = SS * SS;
      const alpha = bg / n;
      const white = bg ? fg / bg : 0;
      const t = y / Math.max(1, size - 1);
      const base = top.map((c, i) => c + (bottom[i] - c) * t);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(base[c] * (1 - white) + 255 * white);
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return png(size, px);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(path.join(out, `icon${size}.png`), render(size));
}
console.log(`Icons written to ${path.relative(process.cwd(), out)}`);
