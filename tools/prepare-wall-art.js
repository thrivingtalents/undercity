#!/usr/bin/env node
'use strict';
/**
 * Prepare the wall artwork from ./Asset for the browser.
 *
 *   node tools/prepare-wall-art.js
 *
 * Reads  Asset/Map reference/Full Map.png   → public/wall/art/haven9-map.png (copied as-is)
 *        Asset/Icons/<name>.png             → public/wall/art/icon-<CODE>.png
 *
 * The icons arrive as 1254×1254 canvases that are ~80 % empty. Each is trimmed
 * to its opaque bounding box, padded square and downscaled to ICON_PX with a
 * box filter, so the wall ships 7 small sprites instead of 2.7 MB of mostly
 * transparent pixels. No image library: the PNGs are decoded and re-encoded
 * here with zlib alone (8-bit RGBA only, which is what the assets are).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'Asset');
const OUT = path.join(ROOT, 'public', 'wall', 'art');
const ICON_PX = 256;
const ICONS = {
  POW: 'Power Grid.png',
  WTR: 'Water & Filtration.png',
  MED: 'Medical bay.png',
  TRN: 'Transport & Tunnels.png',
  AGR: 'Agriculture.png',
  COM: 'Comms & Sensors.png',
  CORE: 'Geothermal Core.png',
};

// -- decode -------------------------------------------------------------------

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const depth = buf[24];
  const ctype = buf[25];
  const interlace = buf[28];
  if (depth !== 8 || interlace !== 0) throw new Error('only 8-bit non-interlaced PNGs are handled');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error(`unsupported colour type ${ctype}`);

  const idat = [];
  for (let i = 8; i < buf.length;) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (type === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    if (type === 'IEND') break;
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const s = x * channels;
      if (channels === 4) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = cur[s + 3]; }
      else if (channels === 3) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255; }
      else if (channels === 2) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = cur[s + 1]; }
      else { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = 255; }
    }
    prev = cur;
  }
  return { w, h, data: out };
}

// -- encode -------------------------------------------------------------------

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng({ w, h, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// -- transforms ---------------------------------------------------------------

/** Bounding box of every pixel with alpha above a whisper, padded square. */
function trimSquare(img, pad = 0.06) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y += 1) {
    for (let x = 0; x < img.w; x += 1) {
      if (img.data[(y * img.w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('empty image');
  const side = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const size = Math.round(side * (1 + pad * 2));
  const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
  const sx = Math.round(cx - size / 2); const sy = Math.round(cy - size / 2);
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const ix = sx + x; const iy = sy + y;
      if (ix < 0 || iy < 0 || ix >= img.w || iy >= img.h) continue;
      img.data.copy(out, (y * size + x) * 4, (iy * img.w + ix) * 4, (iy * img.w + ix) * 4 + 4);
    }
  }
  return { w: size, h: size, data: out };
}

/** Area-averaging downscale (premultiplied alpha so edges do not darken). */
function downscale(img, target) {
  const out = Buffer.alloc(target * target * 4);
  const f = img.w / target;
  for (let y = 0; y < target; y += 1) {
    for (let x = 0; x < target; x += 1) {
      const sx0 = Math.floor(x * f); const sx1 = Math.min(img.w, Math.ceil((x + 1) * f));
      const sy0 = Math.floor(y * f); const sy1 = Math.min(img.h, Math.ceil((y + 1) * f));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const o = (sy * img.w + sx) * 4; const al = img.data[o + 3] / 255;
          r += img.data[o] * al; g += img.data[o + 1] * al; b += img.data[o + 2] * al; a += al; n += 1;
        }
      }
      const o = (y * target + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return { w: target, h: target, data: out };
}

// -- main ---------------------------------------------------------------------

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const map = path.join(SRC, 'Map reference', 'Full Map.png');
  fs.copyFileSync(map, path.join(OUT, 'haven9-map.png'));
  const m = decodePng(fs.readFileSync(map));
  console.log(`map     ${m.w}×${m.h}  → public/wall/art/haven9-map.png`);

  for (const [code, file] of Object.entries(ICONS)) {
    const src = path.join(SRC, 'Icons', file);
    const img = decodePng(fs.readFileSync(src));
    const sprite = downscale(trimSquare(img), ICON_PX);
    const out = path.join(OUT, `icon-${code}.png`);
    fs.writeFileSync(out, encodePng(sprite));
    console.log(`${code.padEnd(5)}   ${img.w}×${img.h} → ${ICON_PX}×${ICON_PX}  ${Math.round(fs.statSync(out).size / 1024)} KB  ${path.relative(ROOT, out)}`);
  }
}

if (require.main === module) main();
module.exports = { decodePng, encodePng, trimSquare, downscale };
