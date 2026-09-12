#!/usr/bin/env node
// Writes public/apple-touch-icon.png: the favicon's tick on the app blue,
// 180 px, the size iOS asks for. iOS ignores SVG for the home screen.
// No image library: a PNG is zlib-compressed rows with a CRC, which Node has.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const N = 180, BG = [0x1d, 0x4e, 0xd8], FG = [0xff, 0xff, 0xff];
const scale = N / 64;
const pts = [[18, 33], [28, 43], [46, 23]].map(([x, y]) => [x * scale, y * scale]);
const width = 3.5 * scale;   // stroke-width 7 → radius 3.5
const radius = 16 * scale;   // corner radius 16

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function inRoundedSquare(x, y) {
  const cx = Math.min(Math.max(x, radius), N - radius), cy = Math.min(Math.max(y, radius), N - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y += 1) {
  raw[y * (N * 4 + 1)] = 0;   // filter: none
  for (let x = 0; x < N; x += 1) {
    const px = x + 0.5, py = y + 0.5;
    const o = y * (N * 4 + 1) + 1 + x * 4;
    if (!inRoundedSquare(px, py)) { raw[o + 3] = 0; continue; }
    const d = Math.min(distToSegment(px, py, pts[0], pts[1]), distToSegment(px, py, pts[1], pts[2]));
    const c = d <= width ? FG : BG;
    raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'public', 'apple-touch-icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
